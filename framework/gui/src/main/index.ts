import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  BrowserWindow,
  Menu,
  Tray,
  WebContentsView,
  app,
  dialog,
  ipcMain,
  nativeImage,
} from 'electron';
// Minimal Electron main process for the kungfu reference app.
//
// The C++ runtime reads configuration through std::getenv, which only sees
// environment variables present when the process starts. The renderer process
// is spawned by this main process, so the runtime directory must be exported
// here, before any window (and therefore the renderer process) is created.
import { DEVELOPER_NAVIGATION, TOOLS_NAVIGATION } from '../navigation';

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
  PROFILE_CLI_EXEC_CHANNEL,
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
  WORKSPACE_SELECT_RECENT_CHANNEL,
} from '../sandbox/channels';
import { executeAgentRuntimeCli } from './agent-runtime-cli';
import {
  bindElectronAgentSessionHost,
  bindLocalAgentSessionHost,
  createMainAgentSessionHost,
} from './agent-session-host';
import {
  firstPartyManifestPath,
  generateFirstPartyManifest,
} from './first-party-manifest';
import {
  installKungfuCliToPath,
  uninstallKungfuCliFromPath,
} from './installCli';
import { executeProfileCli } from './profile-cli';
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
import {
  clearDesktopWorkspaceEnvForRelaunch,
  defaultHomeDesktopWorkspace,
  listRecentDesktopWorkspaces,
  resolveLastDesktopWorkspace,
} from './workspace-selection';

const PRODUCT_NAME = 'Kungfu Episodes';
const qualificationMode = process.env.KF_QUALIFICATION_MODE === '1';

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
const firstPartySourceRoot =
  process.env.KF_FIRST_PARTY_SOURCE_ROOT ||
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
  process.env.KF_WORKSPACE_ID = selected.workspaceId;
  process.env.KF_WORKSPACE_KIND = selected.workspaceKind;
  process.env.KF_WORKSPACE_ROOT = selected.workspaceRoot || '';
  process.env.KF_WORKSPACE_DISPLAY_PATH = selected.displayPath;
  process.env.KF_WORKSPACE_RESOLUTION_REASON = selected.resolutionReason;
  process.env.KF_WORKSPACE_STATE = selected.state;
  process.env.KF_WORKSPACE_DIAGNOSIS = selected.diagnosis || '';
  process.env.KF_HOME = selected.dataHome;
  process.env.KF_RUNTIME_DIR = selected.runtimeDir;
}

if (
  process.env.KF_HOME &&
  !process.env.KF_WORKSPACE_STATE &&
  (process.env.KF_WORKSPACE_ROOT ||
    path.basename(process.env.KF_HOME) === '.kungfu')
) {
  process.env.KF_WORKSPACE_STATE = existsSync(process.env.KF_HOME)
    ? 'ready'
    : 'selected-uninitialized';
}

// Explicit instance/runtime homes are compatibility execution roots rather
// than Desktop project selections. Preserve their existing eager-runtime
// behavior while the Workspace product path remains lazy.
process.env.KF_WORKSPACE_STATE = process.env.KF_WORKSPACE_STATE || 'ready';

const workspaceRuntimeReady = process.env.KF_WORKSPACE_STATE === 'ready';

// ADR-0016 parity is now the product path: the main-process host survives view
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
// source so the System Suite and the built-in views load from source builds. A
// packaged app always prepends its bundled first-party kfx root, so an inherited
// KF_EXTENSION_PATH can extend the product without hiding the shipped views.
const bundledExtensionRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'extensions')
  : firstPartySourceRoot;
process.env.KF_EXTENSION_PATH =
  app.isPackaged && process.env.KF_EXTENSION_PATH
    ? [bundledExtensionRoot, process.env.KF_EXTENSION_PATH].join(path.delimiter)
    : process.env.KF_EXTENSION_PATH || bundledExtensionRoot;

// The frozen first-party set (ADR-0013): which extension keys the renderer's
// loader may trust with node-integrated tier. It is derived from a *fixed
// first-party root* — never from KF_EXTENSION_PATH, which a user may extend, so
// dropping a package on the extension path can no longer confer trust.
//   dev: generate from the workspace extensions/ tree at startup, keys only
//        (bundles change on every rebuild, so they are trusted by key, unpinned).
//   packaged: point at a build-baked resource with pinned bundle hashes; if the
//        bake step has not run the manifest is absent and only system views are
//        trusted (safe by default). The pinned resource is baked at build time
//        by scripts/gen-first-party-manifest.mjs into dist/kungfu, which ships to
//        Resources/kungfu alongside the runtime.
if (!process.env.KF_FIRST_PARTY_MANIFEST && workspaceRuntimeReady) {
  if (app.isPackaged) {
    process.env.KF_FIRST_PARTY_MANIFEST = path.join(
      process.resourcesPath,
      'kungfu',
      'first-party.json',
    );
  } else if (process.env.KF_RUNTIME_DIR) {
    const manifest = generateFirstPartyManifest(firstPartySourceRoot, {
      pin: false,
    });
    const manifestPath = firstPartyManifestPath(process.env.KF_RUNTIME_DIR);
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    process.env.KF_FIRST_PARTY_MANIFEST = manifestPath;
  }
}
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
  workspaceRuntimeReady
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
  !process.env.KF_SKILL_MANAGER_FILE &&
  process.env.KF_RUNTIME_DIR &&
  workspaceRuntimeReady
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

// Prove the frozen runtime CLI runs standalone next to the binding, and hand
// the result to the renderer for display.
try {
  const kungfuBin = path.join(path.dirname(process.env.KFE_PATH), 'kungfu');
  const out = execFileSync(kungfuBin, ['--version'], { timeout: 10000 });
  process.env.KUNGFU_VERSION = out.toString().trim();
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

// The current shell window, tracked so the per-session window host (ADR-0016
// stage 2) can push layout snapshots back to it for persistence.
let shellWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let lastRuntimeStatus: RuntimeStatusResult | null = null;

// Set once the app is quitting; the session-window host reads it so window
// closes during shutdown do not overwrite the persisted layout restore needs.
let appQuitting = false;

function kungfuBinPath(): string {
  const binName = process.platform === 'win32' ? 'kungfu.exe' : 'kungfu';
  return path.join(path.dirname(process.env.KFE_PATH || bindingPath), binName);
}

// Finder-launched apps do not inherit an interactive shell PATH. Make the
// packaged CLI discoverable to agents launched by the Console while retaining
// the exact absolute path for adapters that do not perform PATH lookup.
process.env.KUNGFU_CLI_BIN = process.env.KUNGFU_CLI_BIN || kungfuBinPath();
const kungfuBinDir = path.dirname(process.env.KUNGFU_CLI_BIN);
process.env.PATH = [kungfuBinDir, process.env.PATH || '']
  .filter(Boolean)
  .join(path.delimiter);

function readRuntimeStatus(): RuntimeStatusResult {
  if (!workspaceRuntimeReady) {
    return {
      ok: false,
      payload: null,
      error: 'Workspace selected but not initialized',
      updatedAt: Date.now(),
    };
  }
  try {
    const out = execFileSync(kungfuBinPath(), ['runtime', 'status', '--json'], {
      env: process.env,
      timeout: 10000,
    });
    const payload = JSON.parse(out.toString()) as RuntimeStatusPayload;
    try {
      const assessmentOut = execFileSync(
        kungfuBinPath(),
        ['runtime', 'assessments', '--json'],
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
    const out = execFileSync(kungfuBinPath(), args, {
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
  }),
);
ipcMain.handle(PROFILE_CLI_EXEC_CHANNEL, (_event, payload) =>
  executeProfileCli(payload, {
    bin: kungfuBinPath(),
    env: process.env,
    execFile,
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

function workspaceSnapshot() {
  return {
    current: {
      workspaceId: process.env.KF_WORKSPACE_ID || '',
      workspaceKind: process.env.KF_WORKSPACE_KIND || 'home',
      workspaceRoot: process.env.KF_WORKSPACE_ROOT || null,
      displayPath: process.env.KF_WORKSPACE_DISPLAY_PATH || 'Home Workspace',
      dataHome: process.env.KF_HOME || '',
      state: process.env.KF_WORKSPACE_STATE || 'unavailable',
      diagnosis: process.env.KF_WORKSPACE_DIAGNOSIS || '',
    },
    recent: listRecentDesktopWorkspaces(defaultConfigHome()),
  };
}

function relaunchWithWorkspaceSelection(args: string[]) {
  const out = execFileSync(kungfuBinPath(), args, {
    env: { ...process.env, KF_CONFIG_HOME: defaultConfigHome() },
    timeout: 10000,
  });
  const selected = JSON.parse(out.toString());
  if (desktopWorkspaceIsRegistryManaged) {
    clearDesktopWorkspaceEnvForRelaunch(process.env);
  }
  setImmediate(() => {
    app.relaunch();
    app.exit(0);
  });
  return { ok: true, selected };
}

ipcMain.handle(WORKSPACE_GET_CHANNEL, () => workspaceSnapshot());
ipcMain.handle(WORKSPACE_SELECT_HOME_CHANNEL, () =>
  relaunchWithWorkspaceSelection(['workspace', 'select-home', '--json']),
);
ipcMain.handle(WORKSPACE_OPEN_CHANNEL, async () => {
  const result = await dialog.showOpenDialog({
    title: 'Open Kungfu Workspace',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false };
  return relaunchWithWorkspaceSelection([
    'workspace',
    'select',
    result.filePaths[0],
    '--json',
  ]);
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
    return relaunchWithWorkspaceSelection([
      'workspace',
      'select-home',
      '--json',
    ]);
  }
  if (!selected.workspace_root || !existsSync(selected.workspace_root)) {
    throw new Error('recent project workspace is unavailable');
  }
  return relaunchWithWorkspaceSelection([
    'workspace',
    'select',
    selected.workspace_root,
    '--json',
  ]);
});
// Application menu with the VS Code-style "Install 'kungfu' Command in PATH"
// action, so a real user who installed Kungfu Episodes.app can use `kungfu` in a shell.
function buildMenu() {
  const navigateShell = (request: ShellNavigateRequest) => {
    if (shellWindow && !shellWindow.isDestroyed()) {
      shellWindow.webContents.send(SHELL_NAVIGATE_CHANNEL, request);
    }
  };
  const cliSubmenu: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Settings…',
      accelerator: 'CmdOrCtrl+,',
      click: () => navigateShell({ target: 'settings' }),
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
    {
      label: 'Show Agent Onboarding Brief',
      click: async () => {
        const kungfuBin = path.join(
          path.dirname(process.env.KFE_PATH),
          'kungfu',
        );
        try {
          const out = execFileSync(kungfuBin, ['agent', 'brief'], {
            timeout: 10000,
          });
          await dialog.showMessageBox({
            type: 'info',
            message: 'Kungfu Agent Onboarding',
            detail: out.toString().slice(0, 4000),
          });
        } catch (e) {
          await dialog.showMessageBox({
            type: 'error',
            message: 'Could not read Agent Onboarding brief',
            detail: (e as Error).message,
          });
        }
      },
    },
  ];

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
        {
          label: '💬 Agent Console',
          click: () => navigateShell({ target: 'view', kfxId: 'terminal' }),
        },
        {
          label: '🧩 Profiles',
          click: () => navigateShell({ target: 'view', kfxId: 'kfx-manager' }),
        },
        {
          label: '🧠 Skills',
          click: () =>
            navigateShell({ target: 'view', kfxId: 'skill-manager' }),
        },
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
      submenu: TOOLS_NAVIGATION.map((item) => ({
        label: `${item.icon} ${item.title}`,
        click: () => navigateShell({ target: 'view', kfxId: item.id }),
      })),
    },
    {
      label: 'Developer',
      submenu: [
        ...DEVELOPER_NAVIGATION.map((item) => ({
          label: `${item.icon} ${item.title}`,
          click: () => navigateShell({ target: 'view', kfxId: item.id }),
        })),
        { type: 'separator' as const },
        { role: 'toggleDevTools' as const },
      ],
    },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
      console.log('KF_GUI_QUALIFICATION_READY');
      setTimeout(quitGui, 250);
    });
  } else {
    win.on('ready-to-show', () => {
      win.show();
      if (process.platform === 'darwin') void app.dock?.show();
      buildTrayMenu();
    });
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  app.setName(PRODUCT_NAME);
  // Menus require a real display backend on Linux. The bounded qualification
  // path keeps them disabled together with the already-disabled Tray.
  if (!qualificationMode) buildMenu();
  if (!qualificationMode) createTray();
  // ADR-0016 stage 1 (flagged): run the durable session host in main so it
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
  try {
    const agentSessionHost = createMainAgentSessionHost();
    bindElectronAgentSessionHost(ipcMain, agentSessionHost);
    if (process.platform !== 'win32') {
      const endpointDir = path.join(
        process.env.KF_RUNTIME_DIR || app.getPath('userData'),
        'agent-session',
      );
      mkdirSync(endpointDir, { recursive: true, mode: 0o700 });
      const endpoint = path.join(endpointDir, `surface-${process.pid}.sock`);
      process.env.KUNGFU_AGENT_SESSION_ENDPOINT = endpoint;
      const localHost = bindLocalAgentSessionHost(agentSessionHost, endpoint);
      void localHost.ready.catch((error: Error) => {
        console.log(`KF_AGENT_SESSION_RPC_FAIL ${error.message}`);
      });
    }
  } catch (e) {
    console.log(`KF_AGENT_SESSION_HOST_FAIL ${(e as Error).message}`);
  }
  // ADR-0016 stage 2 (flagged): let a session pop out of the in-shell grid into
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
});

app.on('activate', () => {
  if (shellWindow && !shellWindow.isDestroyed()) showShellWindow();
  else createWindow();
});

app.on('before-quit', () => {
  // Freeze the persisted session-window layout: the window closes that follow
  // are shutdown, not the user dropping windows, so they must not overwrite it.
  appQuitting = true;
});

app.on('window-all-closed', () => {
  if (!appQuitting && tray) return;
  if (process.platform !== 'darwin') app.quit();
});
