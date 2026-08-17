// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';

import type { TerminalDimensions } from './profile-shell.js';

export const ENTER_ALTERNATE_SCREEN = '\u001b[?1049h';
export const LEAVE_ALTERNATE_SCREEN = '\u001b[?1049l';
export const HIDE_CURSOR = '\u001b[?25l';
export const SHOW_CURSOR = '\u001b[?25h';
export const ENABLE_MOUSE_TRACKING = '\u001b[?1000h\u001b[?1002h\u001b[?1006h';
export const DISABLE_MOUSE_TRACKING = '\u001b[?1006l\u001b[?1002l\u001b[?1000l';

export type TerminalMouseEvent = {
  kind: 'press' | 'release' | 'wheel' | 'motion';
  button: 'left' | 'middle' | 'right' | 'wheel-up' | 'wheel-down';
  column: number;
  row: number;
  shift: boolean;
  alt: boolean;
  control: boolean;
};

export function decodeTerminalMouseInput(
  value: string | Buffer,
): TerminalMouseEvent[] {
  const input = String(value);
  const pattern = new RegExp(
    `${String.fromCharCode(27)}\\[<(\\d+);(\\d+);(\\d+)([Mm])`,
    'g',
  );
  const events: TerminalMouseEvent[] = [];
  let consumed = 0;
  for (const match of input.matchAll(pattern)) {
    if (match.index !== consumed) return [];
    consumed += match[0].length;
    const code = Number(match[1]);
    const column = Number(match[2]);
    const row = Number(match[3]);
    if (
      !Number.isSafeInteger(code) ||
      !Number.isSafeInteger(column) ||
      !Number.isSafeInteger(row) ||
      column < 1 ||
      row < 1
    ) {
      return [];
    }
    const wheel = (code & 64) !== 0;
    const motion = (code & 32) !== 0;
    const baseButton = code & 3;
    const button = wheel
      ? baseButton === 0
        ? 'wheel-up'
        : 'wheel-down'
      : baseButton === 0
        ? 'left'
        : baseButton === 1
          ? 'middle'
          : 'right';
    events.push({
      kind: wheel
        ? 'wheel'
        : motion
          ? 'motion'
          : match[4] === 'm'
            ? 'release'
            : 'press',
      button,
      column,
      row,
      shift: (code & 4) !== 0,
      alt: (code & 8) !== 0,
      control: (code & 16) !== 0,
    });
  }
  return consumed === input.length ? events : [];
}

export function resolveTuiCliRuntime({
  env,
  packagedBin,
}: {
  env: NodeJS.ProcessEnv;
  packagedBin: string;
}): {
  bin: string;
  sourceCliFallback: boolean;
  runtimeSurface: 'installed-product' | 'source-checkout';
  selectionReason: string;
} {
  const configuredBin = env.KUNGFU_CLI_BIN || env.KUNGFU_BIN || '';
  const explicitSource = !configuredBin && env.KUNGFU_TUI_SOURCE_CLI === '1';
  if (!configuredBin && !explicitSource && !fs.existsSync(packagedBin)) {
    throw new Error(
      'TUI runtime surface is unavailable: the packaged Kungfu CLI is missing. ' +
        'Set KUNGFU_CLI_BIN to one exact installed product, or set ' +
        'KUNGFU_TUI_SOURCE_CLI=1 for an explicit source-checkout session.',
    );
  }
  return {
    bin: explicitSource ? 'uv' : configuredBin || packagedBin,
    sourceCliFallback: explicitSource,
    runtimeSurface: explicitSource ? 'source-checkout' : 'installed-product',
    selectionReason: explicitSource
      ? 'explicit-source-environment'
      : configuredBin
        ? 'explicit-installed-command'
        : 'packaged-product-command',
  };
}

export function tuiChildCliEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const child = { ...env };
  // Re-enter the ordinary CLI instead of recursively selecting embedded
  // libnode. Keep the installed runtime and KFX authority roots because the
  // child CLI needs them to prove that its native binding belongs to the exact
  // Release Manifest selected by the product launcher.
  child.KUNGFU_AS_VARIANT = undefined;
  // The trunk pins the active embedded-Node entry while the TUI is running.
  // That pin belongs only to this process: a child CLI must be free to select
  // its own Agent Session entry instead of recursively entering tui.mjs.
  child.KUNGFU_NODE_VARIANT_ENTRY = undefined;
  return child;
}

export function bindTuiMockAgentEnvironment({
  env,
  packagedBin,
  mockPath,
}: {
  env: NodeJS.ProcessEnv;
  packagedBin: string;
  mockPath: string;
}): NodeJS.ProcessEnv {
  return {
    ...env,
    KUNGFU_MOCK_AGENT_EXECUTABLE:
      env.KUNGFU_MOCK_AGENT_EXECUTABLE || packagedBin,
    KUNGFU_MOCK_AGENT_SCRIPT: env.KUNGFU_MOCK_AGENT_SCRIPT || mockPath,
  };
}

export function resolveTuiAgentSessionExecutable({
  env,
  cliBin,
  sourceCliFallback,
  processExecPath,
}: {
  env: NodeJS.ProcessEnv;
  cliBin: string;
  sourceCliFallback: boolean;
  processExecPath: string;
}): string {
  return (
    env.KUNGFU_AGENT_SESSION_EXECUTABLE ||
    (sourceCliFallback ? processExecPath : cliBin)
  );
}

export function resolveTuiAgentSessionPaths({
  env,
  argvEntry,
  modulePath,
  exists = fs.existsSync,
}: {
  env: NodeJS.ProcessEnv;
  argvEntry?: string;
  modulePath: string;
  exists?: (candidate: string) => boolean;
}): {
  packageRoot: string;
  workerPath: string;
  mockPath: string;
} {
  const configuredEntry = env.KUNGFU_TUI_ENTRY;
  const extensionRoot = env.KF_BUNDLED_EXTENSION_ROOT;
  const extensionDerivedEntries = extensionRoot
    ? [
        path.resolve(extensionRoot, '..', 'tui', 'tui.mjs'),
        path.resolve(
          extensionRoot,
          '..',
          '..',
          'framework',
          'tui',
          'dist',
          'tui.mjs',
        ),
      ]
    : [];
  const activeEntry = [configuredEntry, argvEntry, ...extensionDerivedEntries]
    .filter((candidate): candidate is string => Boolean(candidate))
    .find(exists);
  const resolvedEntry = path.resolve(activeEntry || modulePath);
  const bundleDir = path.dirname(resolvedEntry);
  const packagedWorker = path.join(bundleDir, 'agent-session-worker.mjs');
  const packagedMock = path.join(bundleDir, 'mock-agent.mjs');
  const packageRoot = path.resolve(bundleDir, '..', '..', 'agent-session');

  return {
    packageRoot,
    workerPath: exists(packagedWorker)
      ? packagedWorker
      : path.join(packageRoot, 'src', 'product-worker.mjs'),
    mockPath: exists(packagedMock)
      ? packagedMock
      : path.join(packageRoot, 'src', 'mock-provider.mjs'),
  };
}

export function resolveTuiProductPaths({
  env,
  resolveCorePackageJson,
}: {
  env: NodeJS.ProcessEnv;
  resolveCorePackageJson: () => string;
}): {
  coreDir: string;
  kungfuDir: string;
  packagedBin: string;
} {
  const configuredKungfuDir = env.KUNGFU_DIR;
  const configuredSourceCoreDir = env.KUNGFU_TUI_SOURCE_CORE_DIR;
  const coreDir = configuredSourceCoreDir
    ? path.resolve(configuredSourceCoreDir)
    : configuredKungfuDir
      ? path.dirname(path.resolve(configuredKungfuDir))
      : path.dirname(resolveCorePackageJson());
  const kungfuDir = configuredKungfuDir
    ? path.resolve(configuredKungfuDir)
    : path.join(coreDir, 'dist', 'kungfu');
  return {
    coreDir,
    kungfuDir,
    packagedBin: path.join(
      kungfuDir,
      process.platform === 'win32' ? 'kungfu.exe' : 'kungfu',
    ),
  };
}

type Listener = (...args: unknown[]) => void;

export type TerminalInput = {
  isTTY?: boolean;
  isRaw?: boolean;
  readableFlowing?: boolean | null;
  setRawMode?: (enabled: boolean) => void;
  resume?: () => void;
  pause?: () => void;
};

export type TerminalOutput = {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  write: (value: string) => unknown;
  on: (event: 'resize', listener: Listener) => unknown;
  off: (event: 'resize', listener: Listener) => unknown;
};

export type ProcessSignals = {
  on: (event: string, listener: Listener) => unknown;
  off: (event: string, listener: Listener) => unknown;
};

export function resolveTuiCoreDir({
  env,
  resolveCorePackage,
}: {
  env: NodeJS.ProcessEnv;
  resolveCorePackage: () => string;
}): string {
  const packagedRuntime = env.KUNGFU_DIR;
  return packagedRuntime
    ? path.dirname(path.resolve(packagedRuntime))
    : path.dirname(resolveCorePackage());
}

type RuntimeResolution = {
  runtimeHomeEnv?: string;
  defaultRuntimeHome?: Record<string, string>;
  environmentFallbacks?: Record<string, string>;
};

function expandTemplate(
  value: string,
  env: NodeJS.ProcessEnv,
  fallbacks: Record<string, string>,
  seen = new Set<string>(),
): string {
  const home = env.HOME || env.USERPROFILE || '';
  let expanded =
    value === '~'
      ? home
      : value.startsWith('~/')
        ? path.join(home, value.slice(2))
        : value;
  expanded = expanded.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
    if (env[name]) return env[name] as string;
    if (seen.has(name)) return '';
    const fallback = fallbacks[name];
    if (!fallback) return '';
    return expandTemplate(fallback, env, fallbacks, new Set([...seen, name]));
  });
  return path.resolve(expanded);
}

export function existingProjectWorkspaceRoot(
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  let current = path.resolve(cwd);
  if (fs.existsSync(current) && fs.statSync(current).isFile()) {
    current = path.dirname(current);
  }
  const legacyUserHome = path.resolve(
    env.HOME || env.USERPROFILE || '',
    '.kungfu',
  );
  while (true) {
    const candidate = path.join(current, '.kungfu');
    if (
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isDirectory() &&
      path.resolve(candidate) !== legacyUserHome
    ) {
      return fs.realpathSync(current);
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function workspaceDataHome(
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const existingRoot = existingProjectWorkspaceRoot(cwd, env);
  if (existingRoot) return fs.realpathSync(path.join(existingRoot, '.kungfu'));
  let current = path.resolve(cwd);
  if (fs.existsSync(current) && fs.statSync(current).isFile()) {
    current = path.dirname(current);
  }
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return path.join(current, '.kungfu');
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function platformKey(): string {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'linux') return 'linux';
  return 'default';
}

function fallbackMachineHome(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'darwin') {
    return path.join(
      env.HOME || '',
      'Library',
      'Application Support',
      'kungfu',
      'home',
    );
  }
  if (process.platform === 'win32') {
    return path.join(
      env.APPDATA || path.join(env.USERPROFILE || '', 'AppData', 'Roaming'),
      'kungfu',
      'home',
    );
  }
  return path.join(
    env.XDG_CONFIG_HOME || path.join(env.HOME || '', '.config'),
    'kungfu',
    'home',
  );
}

export function resolveTuiRuntimeDir({
  env,
  cwd,
  contractPath,
}: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  contractPath: string;
}): string {
  if (env.KF_RUNTIME_DIR) {
    return path.resolve(expandTemplate(env.KF_RUNTIME_DIR, env, {}));
  }

  let resolution: RuntimeResolution = {};
  try {
    resolution =
      (
        JSON.parse(fs.readFileSync(contractPath, 'utf8')) as {
          resolution?: RuntimeResolution;
        }
      ).resolution ?? {};
  } catch {
    // The packaged product carries this contract. Source-only TUI development
    // keeps the same platform fallback when the product tree is not assembled.
  }
  const runtimeHomeEnv = resolution.runtimeHomeEnv || 'KF_HOME';
  const explicitHome = env[runtimeHomeEnv];
  const workspaceHome = workspaceDataHome(cwd, env);
  const templates = resolution.defaultRuntimeHome ?? {};
  const template = templates[platformKey()] || templates.default;
  const machineHome = template
    ? expandTemplate(template, env, resolution.environmentFallbacks ?? {})
    : fallbackMachineHome(env);
  return path.join(
    explicitHome
      ? expandTemplate(explicitHome, env, {})
      : workspaceHome || machineHome,
    'runtime',
  );
}

function terminalText(value: string | Buffer | undefined): string {
  return value === undefined ? '' : String(value).trim();
}

function structuredDiagnosis(value: string): string {
  if (!value) return '';
  try {
    const parsed = JSON.parse(value) as {
      code?: unknown;
      message?: unknown;
    };
    if (typeof parsed.message !== 'string' || !parsed.message.trim()) return '';
    const code =
      typeof parsed.code === 'string' && parsed.code.trim()
        ? `${parsed.code.trim()}: `
        : '';
    return `${code}${parsed.message.trim()}`;
  } catch {
    return '';
  }
}

function conciseStderr(value: string): string {
  if (!value.includes('Traceback (most recent call last):')) return value;
  const last = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!last) return 'Kungfu CLI failed without a diagnostic.';
  if (last === 'StopIteration') {
    return 'Kungfu CLI routing produced no command result.';
  }
  return last.replace(/^click\.exceptions\./, '');
}

export function describeCliFailure(
  error: Error,
  stdout?: string | Buffer,
  stderr?: string | Buffer,
): string {
  const output = terminalText(stdout);
  const diagnostic = structuredDiagnosis(output);
  if (diagnostic) return diagnostic;
  const errorOutput = terminalText(stderr);
  return (
    (errorOutput ? conciseStderr(errorOutput) : '') || output || error.message
  );
}

export class TerminalLifecycle {
  private active = false;
  private previousRaw = false;
  private previousFlowing: boolean | null = null;
  private readonly listeners: Array<[string, Listener]> = [];
  private resizeListener: Listener | null = null;

  constructor(
    private readonly input: TerminalInput,
    private readonly output: TerminalOutput,
    private readonly signals: ProcessSignals,
  ) {}

  dimensions(): TerminalDimensions {
    return {
      columns: Math.max(20, this.output.columns ?? 80),
      rows: Math.max(10, this.output.rows ?? 24),
    };
  }

  start(options: {
    onExit: (signal?: NodeJS.Signals) => void;
    onResize: (dimensions: TerminalDimensions) => void;
  }): void {
    if (this.active) return;
    if (this.input.isTTY !== true || this.output.isTTY !== true) {
      throw new Error('interactive terminal required');
    }
    this.active = true;
    this.previousRaw = this.input.isRaw === true;
    this.previousFlowing = this.input.readableFlowing ?? null;
    try {
      this.output.write(
        `${ENTER_ALTERNATE_SCREEN}${HIDE_CURSOR}${ENABLE_MOUSE_TRACKING}`,
      );
      this.input.setRawMode?.(true);
      this.input.resume?.();

      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        const leave = () => {
          try {
            options.onExit(signal);
          } finally {
            this.restore();
          }
        };
        this.signals.on(signal, leave);
        this.listeners.push([signal, leave]);
      }
      const processExit = () => this.restore();
      this.signals.on('exit', processExit);
      this.listeners.push(['exit', processExit]);
      this.resizeListener = () => options.onResize(this.dimensions());
      this.output.on('resize', this.resizeListener);
    } catch (error) {
      this.restore();
      throw error;
    }
  }

  async run<T>(
    options: {
      onExit: (signal?: NodeJS.Signals) => void;
      onResize: (dimensions: TerminalDimensions) => void;
    },
    task: () => Promise<T>,
  ): Promise<T> {
    try {
      this.start(options);
      return await task();
    } finally {
      this.restore();
    }
  }

  restore(): void {
    if (!this.active) return;
    this.active = false;
    const attempt = (operation: () => unknown) => {
      try {
        operation();
      } catch {
        // Restoration is best-effort and must continue through every owner.
      }
    };
    attempt(() => this.input.setRawMode?.(this.previousRaw));
    if (this.previousFlowing !== true) attempt(() => this.input.pause?.());
    attempt(() =>
      this.output.write(
        `${DISABLE_MOUSE_TRACKING}${SHOW_CURSOR}${LEAVE_ALTERNATE_SCREEN}`,
      ),
    );
    if (this.resizeListener) {
      const resizeListener = this.resizeListener;
      attempt(() => this.output.off('resize', resizeListener));
      this.resizeListener = null;
    }
    for (const [event, listener] of this.listeners.splice(0)) {
      attempt(() => this.signals.off(event, listener));
    }
  }
}
