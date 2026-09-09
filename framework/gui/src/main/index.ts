import { execFile, execFileSync, spawn } from 'node:child_process';
import nodeCrypto from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_KUNGFU_ONBOARDING_STATE,
  type KungfuOnboardingState,
  kungfuAgentBriefCommand,
  kungfuAgentFirstPrompt,
  parseKungfuOnboardingState,
} from '@kungfu-tech/api/capability';
import { type KfxPlanDeps, planKfx } from '@kungfu-tech/kfx';
import {
  BrowserWindow,
  Menu,
  Tray,
  WebContentsView,
  app,
  dialog,
  ipcMain,
  nativeImage,
  shell,
} from 'electron';
// Minimal Electron main process for the kungfu reference app.
//
// The C++ runtime reads configuration through std::getenv, which only sees
// environment variables present when the process starts. The renderer process
// is spawned by this main process, so the runtime directory must be exported
// here, before any window (and therefore the renderer process) is created.
import { navigationForRole, primaryProductNavigation } from '../navigation';
import { isResettableRuntimeFailure } from '../runtime-recovery-contract';
import {
  type RuntimeStatusPayload,
  type RuntimeStatusResult,
  deriveWorkspaceRuntimePresentation,
} from '../runtime-status';
import {
  AGENT_RUNTIME_CLI_EXEC_CHANNEL,
  DESTROY_CHANNEL,
  ENSURE_CHANNEL,
  HIDE_CHANNEL,
  ONBOARDING_GET_CHANNEL,
  ONBOARDING_INSTALL_CLI_CHANNEL,
  ONBOARDING_SET_CHANNEL,
  PROFILE_CLI_EXEC_CHANNEL,
  RUNTIME_BACKUP_RESET_CHANNEL,
  RUNTIME_STATUS_GET_CHANNEL,
  SET_BOUNDS_CHANNEL,
  SHELL_NAVIGATE_CHANNEL,
  SHELL_REFRESH_CHANNEL,
  SHOW_CHANNEL,
  type ShellNavigateRequest,
  WINDOW_CHROME_CONTROL_CHANNEL,
  WINDOW_CHROME_GET_CHANNEL,
  WINDOW_CHROME_STATE_CHANNEL,
  WORKSPACE_GET_CHANNEL,
  WORKSPACE_OPEN_CHANNEL,
  WORKSPACE_SELECT_HOME_CHANNEL,
  WORKSPACE_SELECT_PATH_CHANNEL,
  WORKSPACE_SELECT_RECENT_CHANNEL,
  WORKSPACE_START_CONTINUATION_CHANNEL,
  WORK_LOOP_CLI_EXEC_CHANNEL,
} from '../sandbox/channels';
import { executeAgentRuntimeCli } from './agent-runtime-cli';
import {
  bindElectronAgentSessionHost,
  createMainAgentSessionHost,
} from './agent-session-host';
import { configureProductCacheEnvironment } from './desktop-python-environment';
import {
  type ProductionDesktopUpdateProvider,
  createProductionDesktopUpdateProvider,
} from './desktop-update-provider';
import {
  bindElectronGlobalWorkObserver,
  createGlobalWorkObserverHost,
} from './global-work-observer-host';
import {
  installKungfuCliToPath,
  isKungfuCliInstalled,
  uninstallKungfuCliFromPath,
} from './installCli';
import {
  PRODUCT_NAME,
  productAboutPanelOptions,
  versionFirstLine,
} from './product-identity';
import {
  executeProfileCli,
  resolveGuiKungfuCliInvocation,
} from './profile-cli';
import {
  backupAndResetRuntime,
  bindElectronAssignmentRuntime,
  createAssignmentRuntimeHost,
  stopRuntimeForRecovery,
} from './runtime-recovery';
import { type Rect, SandboxManager } from './sandbox-manager';
import { bindSessionWindows } from './session-windows-host';
import {
  writeGuiSkillContextFile,
  writeGuiSkillManagerViewFile,
} from './skill-context';
import {
  bindElectronTerminalHost,
  createMainTerminalHost,
} from './terminal-host';
import { executeWorkLoopCli } from './work-loop-cli';
import {
  applyDesktopProjectPresentationIntent,
  applyDesktopWorkspaceEnvironment,
  clearDesktopWorkspaceEnvForRelaunch,
  defaultHomeDesktopWorkspace,
  inspectDesktopContinuation,
  listRecentDesktopWorkspaces,
  prepareDesktopWorkspaceEnvironmentForRelaunch,
  resolveLastDesktopWorkspace,
} from './workspace-selection';

const qualificationMode = process.env.KF_QUALIFICATION_MODE === '1';
const qualificationAllWork =
  qualificationMode && process.env.KF_QUALIFICATION_ALL_WORK === '1';
const qualificationExpectedWorkTitle =
  process.env.KF_QUALIFICATION_EXPECTED_WORK_TITLE?.trim() || '';

async function waitForQualifiedAllWork(win: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastText = '';
  while (!win.isDestroyed() && Date.now() < deadline) {
    lastText = await win.webContents.executeJavaScript(
      'document.body.innerText',
      true,
    );
    if (
      lastText.includes('All Work') &&
      qualificationExpectedWorkTitle &&
      lastText.includes(qualificationExpectedWorkTitle)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `packaged All Work did not render the seeded Work; body=${lastText.slice(-4096)}`,
  );
}

// Resolve the kungfu runtime directory that holds libkungfu.dylib and the
// kungfu_electron.node binding. In development it lives in the kungfu-core
// package; once packaged it is shipped as an extraResource under Resources/kungfu.
const kungfuDir = app.isPackaged
  ? path.join(process.resourcesPath, 'kungfu')
  : path.join(
      path.dirname(require.resolve('@kungfu-tech/core/package.json')),
      'dist',
      'kungfu',
    );

const bindingPath = path.join(kungfuDir, 'kungfu_electron.node');
const bundledExtensionSourceRoot =
  process.env.KF_BUNDLED_EXTENSION_ROOT ||
  path.join(__dirname, '..', '..', '..', '..', 'extensions');

function expandHomePath(value: string): string {
  if (value === '~') return app.getPath('home');
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(app.getPath('home'), value.slice(2));
  }
  return value;
}

function resolveHomePath(value: string): string {
  return path.resolve(expandHomePath(value));
}

function defaultConfigHome(): string {
  return resolveHomePath(
    process.env.KF_CONFIG_HOME ||
      path.join(app.getPath('home'), '.kungfu-config'),
  );
}

if (!app.isPackaged && process.env.KUNGFU_GUI_DEV_USER_DATA) {
  const developmentUserData = resolveHomePath(
    process.env.KUNGFU_GUI_DEV_USER_DATA,
  );
  mkdirSync(developmentUserData, { recursive: true });
  app.setPath('userData', developmentUserData);
}

const desktopWorkspaceIsRegistryManaged =
  !process.env.KF_INSTANCE_HOME &&
  !process.env.KF_HOME &&
  !process.env.KF_RUNTIME_DIR;

// A product launcher may set KF_INSTANCE_HOME to make a second Kungfu process
// independent from the default user-global homes. Keep the same mental model as
// the default install: config and runtime home are separate directories.
if (process.env.KF_INSTANCE_HOME) {
  const instanceHome = resolveHomePath(process.env.KF_INSTANCE_HOME);
  const runtimeHome = path.join(instanceHome, 'home');
  process.env.KF_INSTANCE_HOME = instanceHome;
  process.env.KF_HOME = runtimeHome;
  process.env.KF_CONFIG_HOME = path.join(instanceHome, 'config');
  process.env.KF_RUNTIME_DIR = path.join(runtimeHome, 'runtime');
  const userDataHome = path.join(instanceHome, 'userData');
  mkdirSync(userDataHome, { recursive: true });
  app.setPath('userData', userDataHome);
} else if (process.env.KF_HOME && !process.env.KF_RUNTIME_DIR) {
  process.env.KF_HOME = resolveHomePath(process.env.KF_HOME);
  process.env.KF_RUNTIME_DIR = path.join(process.env.KF_HOME, 'runtime');
} else if (
  !app.isPackaged &&
  process.env.KF_DEV_HOME &&
  !process.env.KF_RUNTIME_DIR
) {
  // KF_DEV_HOME pins local dev runs to one workspace data home even when the
  // GUI is launched directly (bypassing the product launcher). Packaged apps
  // and explicit KF_INSTANCE_HOME/KF_HOME are unaffected.
  process.env.KF_HOME = resolveHomePath(process.env.KF_DEV_HOME);
  process.env.KF_RUNTIME_DIR = path.join(process.env.KF_HOME, 'runtime');
}

if (desktopWorkspaceIsRegistryManaged) {
  const configHome = defaultConfigHome();
  process.env.KF_CONFIG_HOME = configHome;
  const selected =
    resolveLastDesktopWorkspace(configHome) ??
    defaultHomeDesktopWorkspace(app.getPath('home'));
  applyDesktopWorkspaceEnvironment(process.env, selected);
}

if (
  process.env.KF_HOME &&
  !process.env.KF_WORKSPACE_STATE &&
  (process.env.KF_WORKSPACE_ROOT ||
    path.basename(process.env.KF_HOME) === '.kungfu')
) {
  process.env.KF_WORKSPACE_STATE = inspectDesktopContinuation(
    process.env.KF_HOME,
  ).state;
}

// Explicit instance/runtime homes are compatibility execution roots rather
// than Desktop project selections. Preserve their existing eager-runtime
// behavior while the Workspace product path remains lazy.
process.env.KF_WORKSPACE_STATE = process.env.KF_WORKSPACE_STATE || 'ready';

configureProductCacheEnvironment(process.env, {
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  homeDir: app.getPath('home'),
});

function workspaceRuntimeIsReady(): boolean {
  return (
    process.env.KF_WORKSPACE_STATE === 'ready' ||
    process.env.KF_WORKSPACE_STATE === 'live-runtime'
  );
}

// KF-ADR-019f86da-4f90-7153-a6c1-ab7a0a3cf481 parity is now the product path: the main-process host survives view
// changes and owns every tab/window, while callers may still explicitly opt
// back to renderer/direct behavior for diagnosis.
process.env.KF_TERMINAL_HOST = process.env.KF_TERMINAL_HOST || 'main';
process.env.KF_SESSION_WINDOWS = process.env.KF_SESSION_WINDOWS || '1';

type WindowChromePlatform = 'darwin' | 'win32' | 'linux' | 'other';
type WindowChromeMode = 'native' | 'integrated' | 'custom';
type WindowChromeControl = 'minimize' | 'toggle-maximize' | 'close';

type WindowChromeConfig = {
  platform: WindowChromePlatform;
  mode: WindowChromeMode;
  customControls: boolean;
  draggable: boolean;
  trafficLightInset: number;
  controlInset: number;
};

function windowChromePlatform(): WindowChromePlatform {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'linux') return 'linux';
  return 'other';
}

function windowChromeConfig(): WindowChromeConfig {
  const platform = windowChromePlatform();
  if (platform === 'darwin') {
    return {
      platform,
      mode: 'integrated',
      customControls: false,
      draggable: true,
      trafficLightInset: 84,
      controlInset: 12,
    };
  }
  if (platform === 'win32') {
    return {
      platform,
      mode: 'custom',
      customControls: true,
      draggable: true,
      trafficLightInset: 0,
      controlInset: 138,
    };
  }
  return {
    platform,
    mode: 'native',
    customControls: false,
    draggable: false,
    trafficLightInset: 0,
    controlInset: 0,
  };
}

const windowChrome = windowChromeConfig();
process.env.KF_WINDOW_CHROME = JSON.stringify(windowChrome);

// Export before the renderer process is created so both processes inherit them.
// The default runtime home must be writable: userData when packaged (never
// inside the app bundle), a throwaway directory under out/ in development.
process.env.KF_RUNTIME_DIR =
  process.env.KF_RUNTIME_DIR ||
  (app.isPackaged
    ? path.join(app.getPath('userData'), 'runtime')
    : path.join(__dirname, '..', 'demo-runtime'));
process.env.KFE_PATH = process.env.KFE_PATH || bindingPath;
process.env.KUNGFU_KFX_CONTRACT =
  process.env.KUNGFU_KFX_CONTRACT ||
  path.join(kungfuDir, 'config', 'kungfu-kfx.contract.json');
// Extension roots for the renderer's kfx loader. Installed extensions live
// next to the runtime home (<home>/extensions, populated by `kungfu kfx
// install`); in development the workspace extensions/ tree is the default
// source so the bundled product views load from source builds. Assembly origin
// affects discovery and presentation only; it has no authorization weight.
const bundledExtensionRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'extensions')
  : bundledExtensionSourceRoot;
process.env.KF_BUNDLED_EXTENSION_ROOT = bundledExtensionRoot;
process.env.KF_EXTENSION_PATH =
  app.isPackaged && process.env.KF_EXTENSION_PATH
    ? [bundledExtensionRoot, process.env.KF_EXTENSION_PATH].join(path.delimiter)
    : process.env.KF_EXTENSION_PATH || bundledExtensionRoot;

if (!process.env.KF_PROFILE_KFD3_MANIFEST && app.isPackaged) {
  process.env.KF_PROFILE_KFD3_MANIFEST = path.join(
    process.resourcesPath,
    'kungfu',
    'profile-kfd3.json',
  );
}

if (
  !process.env.KF_SKILL_CONTEXT_FILE &&
  process.env.KF_RUNTIME_DIR &&
  workspaceRuntimeIsReady()
) {
  try {
    process.env.KF_SKILL_CONTEXT_FILE = writeGuiSkillContextFile({
      home: process.env.KF_RUNTIME_DIR,
      profile: 'gui-default',
      agent: 'managed-run',
      env: process.env,
    });
  } catch (e) {
    console.log(`KF_SKILL_CONTEXT_FAIL ${(e as Error).message}`);
  }
}

if (
  !process.env.KF_SKILL_RUNTIME_AUDIT_FILE &&
  process.env.KF_RUNTIME_DIR &&
  workspaceRuntimeIsReady()
) {
  try {
    const invocation = resolveGuiKungfuCliInvocation({
      env: process.env,
      runtimeDir: process.env.KF_RUNTIME_DIR,
      platform: process.platform,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    });
    if (invocation.source !== 'unavailable') {
      const outputPath = path.join(
        process.env.KF_RUNTIME_DIR,
        'skill-manager',
        'runtime-audit.json',
      );
      execFileSync(
        invocation.bin,
        [
          ...invocation.argsPrefix,
          'skill',
          'runtime-audit',
          '--out',
          outputPath,
          '--json',
        ],
        {
          env: { ...process.env, ...invocation.env },
          timeout: 120_000,
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      process.env.KF_SKILL_RUNTIME_AUDIT_FILE = outputPath;
    }
  } catch (e) {
    console.log(`KF_SKILL_RUNTIME_AUDIT_FAIL ${(e as Error).message}`);
  }
}

if (
  !process.env.KF_SKILL_MANAGER_FILE &&
  process.env.KF_RUNTIME_DIR &&
  workspaceRuntimeIsReady()
) {
  try {
    process.env.KF_SKILL_MANAGER_FILE = writeGuiSkillManagerViewFile({
      home: process.env.KF_RUNTIME_DIR,
      env: process.env,
    });
  } catch (e) {
    console.log(`KF_SKILL_MANAGER_FAIL ${(e as Error).message}`);
  }
}

// Prove the assembled Rust-trunk CLI runs standalone next to the binding, and hand
// the result to the renderer for display.
try {
  const kungfuBin = path.join(path.dirname(process.env.KFE_PATH), 'kungfu');
  const out = execFileSync(kungfuBin, ['--version'], { timeout: 10000 });
  process.env.KUNGFU_VERSION = versionFirstLine(out.toString());
} catch {
  process.env.KUNGFU_VERSION = '';
}

// Probe the binding in the main (node) process.
try {
  const kfe = require(process.env.KFE_PATH || bindingPath);
  console.log(
    `KFE_MAIN_OK loaded; exports=${Object.keys(kfe).length} [${Object.keys(kfe)
      .slice(0, 6)
      .join(',')}]`,
  );
} catch (e) {
  console.log(`KFE_MAIN_FAIL ${(e as Error).message}`);
}

// The isolated sandboxed-view harness page. In dev it is served by the renderer
// dev server; once built it sits beside the main renderer under out/renderer.
function harnessEntry(): string {
  return process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}/sandbox-view-harness/index.html`
    : `file://${path.join(__dirname, '../renderer/sandbox-view-harness/index.html')}`;
}

// The embedded-view manager is created per shell window; the ipcMain control
// handlers are registered once and dispatch to the current manager. This keeps
// `activate` (which re-runs createWindow) from double-registering a channel.
let manager: SandboxManager | null = null;

// The current shell window, tracked so the per-session window host (KF-ADR-019f86da-4f90-7153-a6c1-ab7a0a3cf481
// stage 2) can push layout snapshots back to it for persistence.
let shellWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let lastRuntimeStatus: RuntimeStatusResult | null = null;
let desktopUpdateProvider: ProductionDesktopUpdateProvider | null = null;

// Set once the app is quitting; the session-window host reads it so window
// closes during shutdown do not overwrite the persisted layout restore needs.
let appQuitting = false;

const kungfuCliInvocation = resolveGuiKungfuCliInvocation({
  env: process.env,
  runtimeDir: path.dirname(process.env.KFE_PATH || bindingPath),
  platform: process.platform,
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
});
Object.assign(process.env, kungfuCliInvocation.env);
process.env.KUNGFU_CLI_BIN = kungfuCliInvocation.bin;
process.env.KUNGFU_CLI_ARGS_PREFIX = JSON.stringify(
  kungfuCliInvocation.argsPrefix,
);

function kungfuBinPath(): string {
  return kungfuCliInvocation.bin;
}

function kungfuCliArgs(args: string[]): string[] {
  return [...kungfuCliInvocation.argsPrefix, ...args];
}

function readDesktopOnboardingState(): KungfuOnboardingState {
  try {
    const value = JSON.parse(
      readFileSync(path.join(defaultConfigHome(), 'config.json'), 'utf8'),
    ) as { ui?: { onboarding?: unknown } };
    return parseKungfuOnboardingState(value.ui?.onboarding);
  } catch {
    return { ...DEFAULT_KUNGFU_ONBOARDING_STATE };
  }
}

const DESKTOP_AGENT_BRIEF_ARGS = ['agent', 'brief'] as const;

function desktopAgentFirstEntry() {
  const command = kungfuAgentBriefCommand(
    kungfuCliInvocation.bin,
    kungfuCliInvocation.argsPrefix,
  );
  return {
    state: readDesktopOnboardingState(),
    command,
    commandArgs: DESKTOP_AGENT_BRIEF_ARGS,
    prompt: kungfuAgentFirstPrompt(command),
    cliInstalled: isKungfuCliInstalled(),
    cliPath: path.isAbsolute(kungfuCliInvocation.bin)
      ? kungfuCliInvocation.bin
      : '',
  };
}

process.env.KFE_ONBOARDING = JSON.stringify(desktopAgentFirstEntry());

// Finder-launched apps do not inherit an interactive shell PATH. Make the
// packaged CLI discoverable to agents launched by the Console while retaining
// the exact absolute path for adapters that do not perform PATH lookup.
const kungfuBinDir = path.isAbsolute(process.env.KUNGFU_CLI_BIN)
  ? path.dirname(process.env.KUNGFU_CLI_BIN)
  : '';
process.env.PATH = [kungfuBinDir, process.env.PATH || '']
  .filter(Boolean)
  .join(path.delimiter);

function readRuntimeStatus(): RuntimeStatusResult {
  if (!workspaceRuntimeIsReady()) {
    return {
      ok: false,
      payload: null,
      error: 'Workspace selected but not initialized',
      updatedAt: Date.now(),
    };
  }
  try {
    const out = execFileSync(
      kungfuBinPath(),
      kungfuCliArgs(['runtime', 'status', '--json']),
      {
        env: process.env,
        timeout: 10000,
      },
    );
    const payload = JSON.parse(out.toString()) as RuntimeStatusPayload;
    try {
      const assessmentOut = execFileSync(
        kungfuBinPath(),
        kungfuCliArgs(['runtime', 'assessments', '--json']),
        { env: process.env, timeout: 10000 },
      );
      payload.assessments = JSON.parse(assessmentOut.toString());
    } catch {
      // Assessment visibility degrades independently; runtime health still
      // renders and the next status poll retries the progressive trust view.
    }
    lastRuntimeStatus = {
      ok: true,
      payload,
      error: '',
      updatedAt: Date.now(),
    };
    return lastRuntimeStatus;
  } catch (e) {
    lastRuntimeStatus = {
      ok: false,
      payload: null,
      error: (e as Error).message,
      updatedAt: Date.now(),
    };
    return lastRuntimeStatus;
  }
}

function runtimeStatusLabel(result = lastRuntimeStatus ?? readRuntimeStatus()) {
  return deriveWorkspaceRuntimePresentation(result).label;
}

function initializeDesktopUpdateProvider() {
  if (!app.isPackaged || desktopUpdateProvider) return;
  try {
    desktopUpdateProvider = createProductionDesktopUpdateProvider({
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath('userData'),
      runtimeBin: kungfuBinPath(),
      runtimeEnv: process.env,
      productVersion: app.getVersion(),
      platform: process.platform,
      architecture: process.arch,
    });
    desktopUpdateProvider.start();
  } catch (e) {
    console.log(`KF_DESKTOP_UPDATE_PROVIDER_FAIL ${(e as Error).message}`);
  }
}

function desktopUpdateDetail(
  state: ReturnType<ProductionDesktopUpdateProvider['snapshot']>,
): string {
  if (!state.message) {
    return state.error || state.nextAction || `Update phase: ${state.phase}`;
  }
  return [
    state.message.whatHappened,
    state.message.activeWork,
    state.message.activation,
    state.message.userAction,
    state.message.dataAndSessions,
  ].join('\n\n');
}

async function runDesktopSoftwareUpdate() {
  const provider = desktopUpdateProvider;
  if (!provider) {
    await dialog.showMessageBox({
      type: 'info',
      message: 'Software updates are available in packaged Kungfu builds',
      detail:
        'This development build will not contact the release service or run an installer.',
    });
    return;
  }

  try {
    let state = provider.snapshot();
    if (state.phase === 'idle' || state.phase === 'error') {
      await provider.checkForUpdates();
      state = provider.snapshot();
    }
    if (state.phase === 'idle') {
      await dialog.showMessageBox({
        type: 'info',
        message: 'Kungfu is up to date',
        detail: 'No qualified update is available for this installation.',
      });
      return;
    }

    const canDownload =
      state.phase === 'available' &&
      (state.plan?.state === 'download-allowed' ||
        state.plan?.state === 'apply-now');
    const canInstall = state.phase === 'downloaded';
    const primaryAction = canDownload
      ? 'Download Update'
      : canInstall
        ? 'Restart and Install'
        : null;
    const buttons = primaryAction
      ? [primaryAction, 'Later', 'Open Upgrade Guide']
      : ['OK', 'Open Upgrade Guide'];
    const result = await dialog.showMessageBox({
      type: state.phase === 'error' ? 'error' : 'info',
      message: state.message?.title || 'Kungfu Software Update',
      detail: desktopUpdateDetail(state),
      buttons,
      defaultId: 0,
      cancelId: primaryAction ? 1 : 0,
    });
    if (result.response === buttons.indexOf('Open Upgrade Guide')) {
      const documentationUrl = state.message?.documentationUrl;
      if (documentationUrl) await shell.openExternal(documentationUrl);
      return;
    }
    if (result.response !== 0 || !primaryAction) return;
    if (canDownload) {
      await provider.downloadUpdate();
      await runDesktopSoftwareUpdate();
      return;
    }
    if (canInstall) await provider.applyDownloadedUpdate();
  } catch (e) {
    const state = provider.snapshot();
    await dialog.showMessageBox({
      type: 'error',
      message: state.message?.title || 'Kungfu update could not continue',
      detail: desktopUpdateDetail(state) || (e as Error).message,
    });
  }
}

function showShellWindow() {
  const win = shellWindow && !shellWindow.isDestroyed() ? shellWindow : null;
  if (!win) {
    createWindow();
    return;
  }
  if (process.platform === 'darwin') void app.dock?.show();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  buildTrayMenu();
}

function hideShellWindow(win = shellWindow) {
  if (!win || win.isDestroyed()) return;
  win.hide();
  if (process.platform === 'darwin') app.dock?.hide();
  buildTrayMenu();
}

async function showCommandResult(
  title: string,
  args: string[],
  successMessage: string,
) {
  try {
    const out = execFileSync(kungfuBinPath(), kungfuCliArgs(args), {
      env: process.env,
      timeout: 10000,
    });
    await dialog.showMessageBox({
      type: 'info',
      message: successMessage,
      detail: out.toString().trim().slice(0, 4000) || successMessage,
    });
  } catch (e) {
    await dialog.showMessageBox({
      type: 'error',
      message: title,
      detail: (e as Error).message,
    });
  }
}

function quitGui() {
  appQuitting = true;
  app.quit();
}

function trayIcon() {
  const candidates = [
    path.join(process.resourcesPath || '', 'logo', 'icon.png'),
    path.join(__dirname, '../renderer/logo/icon.png'),
    path.join(__dirname, '../../public/logo/icon.png'),
    path.join(
      process.resourcesPath || '',
      'app',
      'out',
      'renderer',
      'logo',
      'icon.png',
    ),
  ];
  const iconPath = candidates.find((candidate) => existsSync(candidate));
  const image = iconPath
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createFromNamedImage('NSApplicationIcon');
  return image.isEmpty()
    ? nativeImage.createEmpty()
    : image.resize({ width: 18, height: 18 });
}

function buildTrayMenu() {
  if (!tray) return;
  const visible =
    shellWindow && !shellWindow.isDestroyed() ? shellWindow.isVisible() : false;
  const status = readRuntimeStatus();
  const workspaceStatus = deriveWorkspaceRuntimePresentation(status);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: runtimeStatusLabel(status),
        enabled: false,
      },
      {
        label: workspaceStatus.detail,
        enabled: false,
      },
      { type: 'separator' },
      {
        label: `Show ${PRODUCT_NAME}`,
        enabled: !visible,
        click: showShellWindow,
      },
      {
        label: 'Hide Window',
        enabled: visible,
        click: () => hideShellWindow(),
      },
      { type: 'separator' },
      {
        label: 'Advanced Runtime Diagnostics',
        click: () =>
          void showCommandResult(
            'Could not read Kungfu Runtime status',
            ['runtime', 'status', '--json'],
            'Kungfu Runtime Diagnostics',
          ),
      },
      { type: 'separator' },
      {
        label: 'Quit GUI',
        click: quitGui,
      },
    ]),
  );
}

function createTray() {
  if (tray) return;
  tray = new Tray(trayIcon());
  tray.setToolTip(PRODUCT_NAME);
  tray.on('click', () => {
    const visible =
      shellWindow && !shellWindow.isDestroyed()
        ? shellWindow.isVisible()
        : false;
    if (visible) hideShellWindow();
    else showShellWindow();
  });
  buildTrayMenu();
}

ipcMain.handle(ENSURE_CHANNEL, (_event, payload) => {
  const { id, bundlePath, declared } = payload as {
    id: string;
    bundlePath: string;
    declared: string[];
  };
  manager?.ensureView({ id, bundlePath, declared });
});
ipcMain.on(SET_BOUNDS_CHANNEL, (_event, payload) => {
  const { id, rect } = payload as { id: string; rect: Rect };
  manager?.setBounds(id, rect);
});
ipcMain.on(SHOW_CHANNEL, (_event, payload) => {
  manager?.show((payload as { id: string }).id);
});
ipcMain.on(HIDE_CHANNEL, (_event, payload) => {
  manager?.hide((payload as { id: string }).id);
});
ipcMain.on(DESTROY_CHANNEL, (_event, payload) => {
  manager?.destroyView((payload as { id: string }).id);
});

ipcMain.handle(AGENT_RUNTIME_CLI_EXEC_CHANNEL, (_event, payload) =>
  executeAgentRuntimeCli(payload, {
    bin: kungfuBinPath(),
    env: process.env,
    execFile,
    argsPrefix: kungfuCliInvocation.argsPrefix,
  }),
);
ipcMain.handle(PROFILE_CLI_EXEC_CHANNEL, (_event, payload) =>
  executeProfileCli(payload, {
    bin: kungfuBinPath(),
    env: process.env,
    execFile,
    argsPrefix: kungfuCliInvocation.argsPrefix,
  }),
);
const assignmentRuntimeBinding = bindElectronAssignmentRuntime(
  ipcMain,
  createAssignmentRuntimeHost({
    bin: kungfuBinPath(),
    env: process.env,
    argsPrefix: kungfuCliInvocation.argsPrefix,
    workspaceRoot: process.env.KF_WORKSPACE_ROOT,
    spawn: (file, args, options) => spawn(file, args, options),
  }),
);
const globalWorkObserverBinding = bindElectronGlobalWorkObserver(
  ipcMain,
  createGlobalWorkObserverHost({
    bin: kungfuBinPath(),
    env: process.env,
    argsPrefix: kungfuCliInvocation.argsPrefix,
    statePath: path.join(
      defaultConfigHome(),
      'gui',
      'global-work-observer.json',
    ),
    readState: (file) => readFileSync(file, 'utf8'),
    spawn: (file, args, options) => spawn(file, args, options),
    restart: (fn, delayMs) => setTimeout(fn, delayMs),
    cancelRestart: (timer) => clearTimeout(timer),
  }),
);
ipcMain.handle(WORK_LOOP_CLI_EXEC_CHANNEL, (_event, payload) =>
  executeWorkLoopCli(payload, {
    bin: kungfuBinPath(),
    env: process.env,
    execFile,
    argsPrefix: kungfuCliInvocation.argsPrefix,
  }),
);

function publishWindowChromeState(win: BrowserWindow) {
  win.webContents.send(WINDOW_CHROME_STATE_CHANNEL, {
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
  });
}

ipcMain.handle(WINDOW_CHROME_GET_CHANNEL, (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return {
    ...windowChrome,
    maximized: win?.isMaximized() ?? false,
    fullscreen: win?.isFullScreen() ?? false,
  };
});

ipcMain.handle(WINDOW_CHROME_CONTROL_CHANNEL, (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false };
  const control = (payload as { control?: WindowChromeControl }).control;
  if (control === 'minimize') {
    win.minimize();
  } else if (control === 'toggle-maximize') {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  } else if (control === 'close') {
    win.close();
  }
  return {
    ok: true,
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
  };
});

ipcMain.handle(RUNTIME_STATUS_GET_CHANNEL, () => readRuntimeStatus());
ipcMain.handle(RUNTIME_BACKUP_RESET_CHANNEL, async (_event, payload) => {
  const message = String((payload as { message?: unknown })?.message || '');
  if (!isResettableRuntimeFailure(message)) {
    return { ok: false, error: 'runtime failure is not resettable' };
  }
  const dataHome = process.env.KF_HOME || '';
  const runtimeDir = process.env.KF_RUNTIME_DIR || '';
  if (!dataHome || !runtimeDir || !workspaceRuntimeIsReady()) {
    return { ok: false, error: 'selected workspace runtime is unavailable' };
  }
  const confirmation = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Cancel', 'Back Up and Reset'],
    defaultId: 0,
    cancelId: 0,
    message: 'Back up and reset this workspace runtime?',
    detail:
      'Kungfu will stop the workspace runtime, move the complete runtime directory into .kungfu/backups/runtime-recovery, create a fresh runtime, and relaunch. Workspace source files are not changed.',
  });
  if (confirmation.response !== 1) return { ok: false, canceled: true };
  try {
    stopRuntimeForRecovery({
      kungfuBinary: kungfuBinPath(),
      argsPrefix: kungfuCliInvocation.argsPrefix,
      env: process.env,
    });
    const receipt = backupAndResetRuntime({
      dataHome,
      runtimeDir,
      reason: message,
    });
    setImmediate(() => {
      if (desktopWorkspaceIsRegistryManaged) {
        clearDesktopWorkspaceEnvForRelaunch(process.env);
      }
      app.relaunch();
      app.exit(0);
    });
    return { ok: true, receipt };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
});

function workspaceSnapshot() {
  const continuation = process.env.KF_HOME
    ? inspectDesktopContinuation(process.env.KF_HOME)
    : null;
  return {
    current: {
      workspaceId: process.env.KF_WORKSPACE_ID || '',
      workspaceKind: process.env.KF_WORKSPACE_KIND || 'home',
      workspaceRoot: process.env.KF_WORKSPACE_ROOT || null,
      displayPath: process.env.KF_WORKSPACE_DISPLAY_PATH || 'Home Workspace',
      dataHome: process.env.KF_HOME || '',
      state: process.env.KF_WORKSPACE_STATE || 'unavailable',
      diagnosis: process.env.KF_WORKSPACE_DIAGNOSIS || '',
      evidenceLevel: continuation?.evidenceLevel || 'none',
      settledEpisodeCount: continuation?.settledEpisodeCount || 0,
      projectCutCount: continuation?.projectCutCount || 0,
    },
    recent: listRecentDesktopWorkspaces(defaultConfigHome()),
  };
}

function relaunchWithWorkspaceSelection(
  args: string[],
  projectPresentationPath: string | null = null,
) {
  const out = execFileSync(kungfuBinPath(), kungfuCliArgs(args), {
    env: { ...process.env, KF_CONFIG_HOME: defaultConfigHome() },
    timeout: 10000,
  });
  const selected = JSON.parse(out.toString());
  applyDesktopProjectPresentationIntent(process.env, projectPresentationPath);
  const workspace = resolveLastDesktopWorkspace(defaultConfigHome());
  if (!workspace) {
    throw new Error('selected project workspace could not be resolved');
  }
  const developmentRestartExitCode = Number.parseInt(
    process.env.KUNGFU_GUI_DEV_RESTART_EXIT_CODE || '',
    10,
  );
  if (
    !app.isPackaged &&
    process.env.KUNGFU_GUI_DEV_SUPERVISOR === '1' &&
    Number.isInteger(developmentRestartExitCode)
  ) {
    setImmediate(() => {
      appQuitting = true;
      app.exit(developmentRestartExitCode);
    });
    return {
      ok: true,
      selected,
      transition: 'development-supervisor-restart',
    };
  }
  prepareDesktopWorkspaceEnvironmentForRelaunch(
    process.env,
    workspace,
    desktopWorkspaceIsRegistryManaged,
  );
  setImmediate(() => {
    app.relaunch();
    // This app normally hides its only window instead of closing it. Mark the
    // relaunch as a real quit first so the close guard cannot strand a
    // windowless tray process and prevent the replacement window from opening.
    quitGui();
  });
  return { ok: true, selected, transition: 'application-relaunch' };
}

ipcMain.handle(WORKSPACE_GET_CHANNEL, () => workspaceSnapshot());
ipcMain.handle(WORKSPACE_START_CONTINUATION_CHANNEL, () => {
  const workspaceRoot = process.env.KF_WORKSPACE_ROOT || '';
  if (!workspaceRoot || !existsSync(workspaceRoot)) {
    throw new Error(
      'start continuation requires an available project workspace',
    );
  }
  if (
    process.env.KF_WORKSPACE_STATE !== 'shadow-only' &&
    process.env.KF_WORKSPACE_STATE !== 'uninitialized'
  ) {
    throw new Error(
      `workspace state cannot start continuation: ${process.env.KF_WORKSPACE_STATE}`,
    );
  }
  const out = execFileSync(
    kungfuBinPath(),
    kungfuCliArgs([
      'workspace',
      'ensure',
      workspaceRoot,
      '--reason',
      'gui-start-continuation',
      '--json',
    ]),
    {
      env: { ...process.env, KF_CONFIG_HOME: defaultConfigHome() },
      timeout: 10000,
    },
  );
  const receipt = JSON.parse(out.toString());
  if (desktopWorkspaceIsRegistryManaged) {
    clearDesktopWorkspaceEnvForRelaunch(process.env);
  }
  setImmediate(() => {
    app.relaunch();
    app.exit(0);
  });
  return { ok: true, receipt };
});
ipcMain.handle(WORKSPACE_SELECT_HOME_CHANNEL, () =>
  relaunchWithWorkspaceSelection(['workspace', 'select-home', '--json'], null),
);
ipcMain.handle(WORKSPACE_SELECT_PATH_CHANNEL, (_event, payload) => {
  const requestedPath = String(
    (payload as { workspaceRoot?: unknown })?.workspaceRoot || '',
  );
  if (!requestedPath || !existsSync(requestedPath)) {
    throw new Error('project workspace path is unavailable');
  }
  const workspaceRoot = realpathSync(requestedPath);
  if (!statSync(workspaceRoot).isDirectory()) {
    throw new Error('project workspace path is not a directory');
  }
  return relaunchWithWorkspaceSelection(
    ['workspace', 'select', workspaceRoot, '--json'],
    workspaceRoot,
  );
});
ipcMain.handle(WORKSPACE_OPEN_CHANNEL, async () => {
  const result = await dialog.showOpenDialog({
    title: 'Open Kungfu Workspace',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false };
  return relaunchWithWorkspaceSelection(
    ['workspace', 'select', result.filePaths[0], '--json'],
    result.filePaths[0],
  );
});
ipcMain.handle(WORKSPACE_SELECT_RECENT_CHANNEL, (_event, payload) => {
  const workspaceId = String(
    (payload as { workspaceId?: unknown })?.workspaceId || '',
  );
  const selected = listRecentDesktopWorkspaces(defaultConfigHome()).find(
    (item) => item.workspace_id === workspaceId,
  );
  if (!selected) throw new Error('recent workspace was not found');
  if (selected.workspace_kind === 'home') {
    return relaunchWithWorkspaceSelection(
      ['workspace', 'select-home', '--json'],
      null,
    );
  }
  if (!selected.workspace_root || !existsSync(selected.workspace_root)) {
    throw new Error('recent project workspace is unavailable');
  }
  return relaunchWithWorkspaceSelection(
    ['workspace', 'select', selected.workspace_root, '--json'],
    selected.workspace_root,
  );
});
ipcMain.handle(ONBOARDING_GET_CHANNEL, () => desktopAgentFirstEntry());
ipcMain.handle(ONBOARDING_INSTALL_CLI_CHANNEL, () => {
  const result = installKungfuCliToPath();
  return { ...result, entry: desktopAgentFirstEntry() };
});
ipcMain.handle(ONBOARDING_SET_CHANNEL, (_event, payload) => {
  const requested = parseKungfuOnboardingState(
    (payload as { state?: unknown })?.state,
  );
  execFileSync(
    kungfuBinPath(),
    kungfuCliArgs([
      'config',
      'set',
      'ui.onboarding',
      JSON.stringify(requested),
      '--scope',
      'user',
      '--json',
    ]),
    {
      env: { ...process.env, KF_CONFIG_HOME: defaultConfigHome() },
      timeout: 10000,
    },
  );
  const entry = desktopAgentFirstEntry();
  process.env.KFE_ONBOARDING = JSON.stringify(entry);
  return entry;
});
// Application menu with the VS Code-style "Install 'kungfu' Command in PATH"
// action, so a real user who installed Kungfu.app can use `kungfu` in a shell.
function buildMenu() {
  const navigateShell = (request: ShellNavigateRequest) => {
    if (shellWindow && !shellWindow.isDestroyed()) {
      shellWindow.webContents.send(SHELL_NAVIGATE_CHANNEL, request);
    }
  };
  const cliSubmenu: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? []
      : [
          {
            label: `About ${PRODUCT_NAME}`,
            click: () => app.showAboutPanel(),
          },
          { type: 'separator' as const },
        ]),
    {
      label: 'Settings…',
      accelerator: 'CmdOrCtrl+,',
      click: () => navigateShell({ target: 'settings' }),
    },
    {
      label: 'Software Update…',
      click: () => void runDesktopSoftwareUpdate(),
    },
    { type: 'separator' },
    {
      label: "Install 'kungfu' Command in PATH",
      click: async () => {
        const r = installKungfuCliToPath();
        await dialog.showMessageBox({
          type: r.ok ? 'info' : 'error',
          message: r.ok
            ? "Shell command 'kungfu' installed"
            : "Could not install 'kungfu' command",
          detail: r.message,
        });
      },
    },
    {
      label: "Uninstall 'kungfu' Command from PATH",
      click: async () => {
        const r = uninstallKungfuCliFromPath();
        await dialog.showMessageBox({
          type: r.ok ? 'info' : 'error',
          message: r.ok
            ? "Shell command 'kungfu' removed"
            : "Could not remove 'kungfu' command",
          detail: r.message,
        });
      },
    },
  ];
  const helpSubmenu: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Onboarding',
      click: () => navigateShell({ target: 'onboarding' }),
    },
    { type: 'separator' },
    {
      label: 'GitHub Repository',
      click: () =>
        void shell.openExternal('https://github.com/kungfu-systems/kungfu'),
    },
    {
      label: 'Kungfu Website',
      click: () => void shell.openExternal('https://kungfu.tech'),
    },
    {
      label: 'Developer Platform',
      click: () => void shell.openExternal('https://libkungfu.dev'),
    },
  ];
  const planDeps: KfxPlanDeps = {
    fs: {
      existsSync,
      readFileSync: (file, encoding) =>
        readFileSync(file, encoding as BufferEncoding),
      readdirSync: (directory, options) => readdirSync(directory, options),
    },
    path,
    crypto: nodeCrypto as unknown as KfxPlanDeps['crypto'],
  };
  const entries = planKfx(process.env, planDeps).entries;
  const primaryNavigation = primaryProductNavigation(entries);
  const toolsNavigation = navigationForRole(entries, 'tool');
  const developerNavigation = navigationForRole(entries, 'devtool');

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { label: 'kungfu', submenu: cliSubmenu },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: '🧭 Profile Home',
          click: () => navigateShell({ target: 'profile-home' }),
        },
        ...primaryNavigation.map((item) => ({
          label: `${item.icon} ${item.title}`,
          click: () => navigateShell({ target: 'view', kfxId: item.id }),
        })),
        { type: 'separator' },
        {
          label: 'Refresh Product Data',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (shellWindow && !shellWindow.isDestroyed()) {
              shellWindow.webContents.send(SHELL_REFRESH_CHANNEL);
            }
          },
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Tools',
      submenu: toolsNavigation.map((item) => ({
        label: `${item.icon} ${item.title}`,
        click: () => navigateShell({ target: 'view', kfxId: item.id }),
      })),
    },
    {
      label: 'Developer',
      submenu: [
        ...developerNavigation.map((item) => ({
          label: `${item.icon} ${item.title}`,
          click: () => navigateShell({ target: 'view', kfxId: item.id }),
        })),
        { type: 'separator' as const },
        { role: 'toggleDevTools' as const },
      ],
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: helpSubmenu },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function completeQualification(win: BrowserWindow): Promise<void> {
  console.log('KF_GUI_QUALIFICATION_READY');
  if (!qualificationAllWork) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    quitGui();
    return;
  }
  try {
    await waitForQualifiedAllWork(win);
    console.log('KF_GUI_QUALIFICATION_ALL_WORK_READY');
  } catch (error) {
    console.error(
      `KF_GUI_QUALIFICATION_ALL_WORK_FAIL ${(error as Error).message}`,
    );
    process.exitCode = 1;
  }
  quitGui();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    frame: windowChrome.mode !== 'custom',
    titleBarStyle:
      windowChrome.mode === 'integrated' ? 'hiddenInset' : 'default',
    trafficLightPosition:
      windowChrome.platform === 'darwin' ? { x: 14, y: 14 } : undefined,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      // Moat: in-process zero-copy access to journal/state requires
      // nodeIntegration with contextIsolation/sandbox disabled.
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      offscreen: qualificationMode,
    },
  });
  shellWindow = win;

  if (!app.isPackaged) {
    win.webContents.on('console-message', (details) =>
      console.log(
        `KF_GUI_RENDERER_CONSOLE level=${details.level} source=${details.sourceId}:${details.lineNumber} ${details.message}`,
      ),
    );
    win.webContents.on(
      'did-fail-load',
      (_event, code, description, url, isMainFrame) => {
        if (!isMainFrame) return;
        console.error(
          `KF_GUI_RENDERER_LOAD_FAIL code=${code} url=${url} ${description}`,
        );
      },
    );
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error(
        `KF_GUI_RENDERER_GONE reason=${details.reason} exitCode=${details.exitCode}`,
      );
    });
  }

  win.on('maximize', () => publishWindowChromeState(win));
  win.on('unmaximize', () => publishWindowChromeState(win));
  win.on('enter-full-screen', () => publishWindowChromeState(win));
  win.on('leave-full-screen', () => publishWindowChromeState(win));
  win.on('close', (event) => {
    if (appQuitting) return;
    event.preventDefault();
    hideShellWindow(win);
  });
  win.on('closed', () => {
    if (shellWindow === win) {
      shellWindow = null;
      manager = null;
    }
    buildTrayMenu();
  });

  // The trusted renderer holds the real capabilities and runs the capability
  // host; this manager embeds sandboxed views and relays their invokes to it.
  // Qualification only proves that the packaged main process and trusted
  // renderer can boot. Avoid creating embedded native views there: Linux
  // display-less runners use Ozone headless, which cannot provide the GTK
  // surface those views require. Normal GUI launches remain unchanged.
  if (!qualificationMode) {
    manager = new SandboxManager({
      shell: win,
      ipcMain,
      WebContentsView,
      harnessEntry,
    });
  }

  if (qualificationMode) {
    win.webContents.once('did-finish-load', () => {
      void completeQualification(win);
    });
  } else {
    let revealed = false;
    const reveal = () => {
      if (revealed || win.isDestroyed()) return;
      revealed = true;
      win.show();
      if (process.platform === 'darwin') void app.dock?.show();
      buildTrayMenu();
    };
    win.once('ready-to-show', reveal);
    win.webContents.once('did-finish-load', reveal);
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  app.setName(PRODUCT_NAME);
  app.setAboutPanelOptions(productAboutPanelOptions(app.getVersion()));
  initializeDesktopUpdateProvider();
  // Menus require a real display backend on Linux. The bounded qualification
  // path keeps them disabled together with the already-disabled Tray.
  if (!qualificationMode) buildMenu();
  if (!qualificationMode) createTray();
  // KF-ADR-019f86da-4f90-7153-a6c1-ab7a0a3cf481 stage 1 (flagged): run the durable session host in main so it
  // outlives windows. The ipcMain handlers are global, so bind once; events are
  // sent back to whichever renderer subscribed. Default keeps the in-renderer
  // host, so the working app is untouched until this path is validated.
  if (process.env.KF_TERMINAL_HOST === 'main') {
    try {
      bindElectronTerminalHost(ipcMain, createMainTerminalHost());
    } catch (e) {
      console.log(`KF_TERMINAL_HOST_MAIN_FAIL ${(e as Error).message}`);
    }
  }
  // The detached host deliberately survives the Electron main process. An
  // installer qualification immediately uninstalls its temporary application,
  // so starting that durable worker would leave an executable under $INSTDIR
  // while NSIS is proving removal. Normal product launches retain the host.
  if (!qualificationMode) {
    try {
      const agentSessionHost = createMainAgentSessionHost(
        process.env.KF_RUNTIME_DIR || app.getPath('userData'),
      );
      bindElectronAgentSessionHost(ipcMain, agentSessionHost);
    } catch (e) {
      console.log(`KF_AGENT_SESSION_HOST_FAIL ${(e as Error).message}`);
    }
  }
  // KF-ADR-019f86da-4f90-7153-a6c1-ab7a0a3cf481 stage 2 (flagged): let a session pop out of the in-shell grid into
  // its own restorable OS window. The handlers are global, so bind once; the
  // registry pushes layout snapshots to the current shell window. Default off
  // keeps the single-window app untouched until this is validated on a machine.
  if (process.env.KF_SESSION_WINDOWS === '1') {
    try {
      bindSessionWindows({
        ipcMain,
        getShellWindow: () => shellWindow,
        isQuitting: () => appQuitting,
      });
    } catch (e) {
      console.log(`KF_SESSION_WINDOWS_FAIL ${(e as Error).message}`);
    }
  }
  createWindow();
  if (desktopUpdateProvider) {
    void desktopUpdateProvider
      .reconcileBundledRuntime(async () => readRuntimeStatus().ok)
      .catch((e: unknown) => {
        console.log(`KF_DESKTOP_UPDATE_RECONCILE_FAIL ${(e as Error).message}`);
      });
  }
});

app.on('activate', () => {
  if (shellWindow && !shellWindow.isDestroyed()) showShellWindow();
  else createWindow();
});

app.on('before-quit', () => {
  // Freeze the persisted session-window layout: the window closes that follow
  // are shutdown, not the user dropping windows, so they must not overwrite it.
  appQuitting = true;
  assignmentRuntimeBinding.dispose();
  globalWorkObserverBinding.dispose();
  desktopUpdateProvider?.stop();
});

app.on('window-all-closed', () => {
  if (!appQuitting && tray) return;
  if (process.platform !== 'darwin') app.quit();
});
