// Runtime access for the reference app: load the native kungfu binding
// in-process (nodeIntegration renderer), inject it into the capability SDK
// (KF-ADR-019f86da-4f90-7e5e-ae22-2a8fc24086f1), and hand capability handles to the shell and its kfx. This is
// the moat: the renderer reaches the runtime directly, no IPC copy.
import {
  type AgentRuntime,
  type AgentSession,
  type AgentWorkLab,
  type DomainState,
  type KfNativeBinding,
  type KfxControl,
  type Ledger,
  type Profile,
  type PtyModule,
  type RemoteWork,
  type Rewind,
  type Storage,
  type Terminal,
  type TmuxBinding,
  type Work,
  type WorkLoop,
  type WorkspaceGuidance,
  managedTmuxSocket,
  openAgentRuntime,
  openAgentWorkLab,
  openDomainState,
  openKfxControl,
  openLedger,
  openProfile,
  openRemoteWork,
  openRewind,
  openStorage,
  openTerminal,
  openWork,
  openWorkLoop,
  openWorkspaceGuidance,
} from '@kungfu-tech/api/capability';
import {
  AGENT_RUNTIME_CLI_EXEC_CHANNEL,
  PROFILE_CLI_EXEC_CHANNEL,
  WORK_LOOP_CLI_EXEC_CHANNEL,
} from '../../sandbox/channels';
import { createAgentSessionProxy } from './agent-session-proxy';
import { type IpcRendererLike, createTerminalProxy } from './terminal-proxy';

declare global {
  interface Window {
    require: NodeRequire;
    process: NodeJS.Process;
  }
}

export const APP_NAME = 'reference_app';

export function guiKungfuCliArgs(
  env: Record<string, string | undefined>,
  args: string[],
): string[] {
  const encoded = env.KUNGFU_CLI_ARGS_PREFIX;
  if (!encoded) return args;
  try {
    const prefix = JSON.parse(encoded) as unknown;
    return Array.isArray(prefix) &&
      prefix.every((value) => typeof value === 'string')
      ? [...prefix, ...args]
      : args;
  } catch {
    return args;
  }
}

// A non-interactive shell must not rely on a `tmux` shell-function shim, so we
// resolve an absolute binary. Candidates cover Homebrew (arm64/x86) and system
// paths; `KF_TMUX_BIN` overrides. Returns null when no tmux is available, in
// which case the terminal handle simply runs without a durability backend.
function resolveTmuxBinding(win: Window): TmuxBinding | null {
  try {
    const fs = win.require('node:fs');
    // Minimal local type for execFile rather than `typeof import('…')`, whose
    // formatted multiline form is fragile; we only need this one call shape.
    type ExecFile = (
      file: string,
      args: string[],
      options: { encoding: 'utf8' },
      cb: (
        err: (Error & { code?: number }) | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) => void;
    const { execFile } = win.require('node:child_process') as {
      execFile: ExecFile;
    };
    // Per-home socket (KF_TMUX_SOCKET overrides): a dedicated `-L kungfu-managed-*`
    // socket that still cannot touch the user's own default-socket tmux, and whose
    // server belongs to exactly this runtime home so its frozen env never leaks
    // across homes.
    const socket =
      win.process.env.KF_TMUX_SOCKET ||
      managedTmuxSocket(win.process.env.KF_RUNTIME_DIR ?? '');
    const candidates = [
      win.process.env.KF_TMUX_BIN,
      '/opt/homebrew/bin/tmux',
      '/usr/local/bin/tmux',
      '/usr/bin/tmux',
    ].filter((p): p is string => typeof p === 'string' && p.length > 0);
    const bin = candidates.find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    if (!bin) return null;
    return {
      config: { socket, bin },
      control: {
        run: (args) =>
          new Promise((resolve) => {
            execFile(bin, args, { encoding: 'utf8' }, (err, stdout, stderr) => {
              // A non-zero tmux exit (e.g. has-session miss) arrives as an
              // error carrying the numeric exit code; surface it as a code,
              // not a rejection, so callers branch on it.
              const code =
                err && typeof (err as { code?: unknown }).code === 'number'
                  ? (err as { code: number }).code
                  : err
                    ? 1
                    : 0;
              resolve({
                code,
                stdout: stdout ?? '',
                stderr: stderr ?? '',
              });
            });
          }),
      },
    };
  } catch {
    return null;
  }
}

export type Runtime = {
  ok: boolean;
  message: string;
  runtimeDir: string;
  kungfuVersion: string;
  buildInfo: Record<string, unknown> | null;
  skillManager: Record<string, unknown> | null;
  exports: string[];
  schemaTypes: { name: string; fields: string[] }[];
  binding: KfNativeBinding | null;
  ledger: Ledger | null;
  domain: DomainState | null;
  rewind: Rewind | null;
  storage: Storage | null;
  remoteWork: RemoteWork | null;
  terminal: Terminal | null;
  work: Work | null;
  workLoop: WorkLoop | null;
  kfxControl: KfxControl | null;
  profile: Profile | null;
  agentRuntime: AgentRuntime | null;
  agentSession: AgentSession | null;
  workspace: WorkspaceGuidance | null;
  agentWorkLab: AgentWorkLab;
};

export function openRendererAgentWorkLab(): AgentWorkLab {
  const env = window.process.env as Record<string, string | undefined>;
  const runtimeDir = env.KF_RUNTIME_DIR || '';
  const path = window.require('node:path') as {
    dirname: (value: string) => string;
    join: (...values: string[]) => string;
  };
  type ExecOptions = {
    encoding: 'utf8';
    env: Record<string, string | undefined>;
    maxBuffer: number;
  };
  const childProcess = window.require('node:child_process') as {
    execFileSync: (
      file: string,
      args: string[],
      options: ExecOptions,
    ) => string;
    execFile: (
      file: string,
      args: string[],
      options: ExecOptions,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => void;
    spawn: (
      file: string,
      args: string[],
      options: {
        env: Record<string, string | undefined>;
        stdio: ['ignore', 'pipe', 'pipe'];
      },
    ) => {
      stdout: {
        on: (event: 'data', listener: (chunk: unknown) => void) => void;
      };
      stderr: {
        on: (event: 'data', listener: (chunk: unknown) => void) => void;
      };
      once: {
        (event: 'error', listener: (error: Error) => void): void;
        (
          event: 'close',
          listener: (code: number | null, signal: string | null) => void,
        ): void;
      };
      kill: () => void;
    };
  };
  const bindingPath = env.KFE_PATH || '';
  const bin =
    env.KUNGFU_CLI_BIN ||
    env.KUNGFU_BIN ||
    path.join(
      path.dirname(bindingPath),
      process.platform === 'win32' ? 'kungfu.exe' : 'kungfu',
    );
  return openAgentWorkLab({
    runtimeDir,
    bin,
    env,
    execFileSync: (file, args, options) =>
      childProcess.execFileSync(file, guiKungfuCliArgs(env, args), options),
    execFile: (file, args, options) =>
      new Promise<string>((resolve, reject) => {
        childProcess.execFile(
          file,
          guiKungfuCliArgs(env, args),
          options,
          (error, stdout, stderr) => {
            if (error) reject(new Error(stderr.trim() || error.message));
            else resolve(stdout);
          },
        );
      }),
    execFileEvents: (file, args, options, onLine) =>
      new Promise<void>((resolve, reject) => {
        const child = childProcess.spawn(file, guiKungfuCliArgs(env, args), {
          env: options.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdoutBuffer = '';
        let stderr = '';
        let outputSize = 0;
        let settled = false;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          child.kill();
          reject(error);
        };
        const emitLine = (line: string) => {
          if (!line.trim()) return true;
          try {
            onLine(line);
            return true;
          } catch (reason) {
            fail(
              reason instanceof Error
                ? reason
                : new Error(`invalid qualification event: ${String(reason)}`),
            );
            return false;
          }
        };
        child.stdout.on('data', (chunk) => {
          const text = String(chunk);
          outputSize += text.length;
          if (outputSize > options.maxBuffer) {
            fail(new Error('qualification event stream exceeded maxBuffer'));
            return;
          }
          stdoutBuffer += text;
          const lines = stdoutBuffer.split(/\r?\n/);
          stdoutBuffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!emitLine(line)) return;
          }
        });
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.once('error', fail);
        child.once('close', (code, signal) => {
          if (settled) return;
          if (!emitLine(stdoutBuffer)) return;
          if (code !== 0) {
            fail(
              new Error(
                stderr.trim() ||
                  `qualification event stream exited ${code ?? signal ?? 'unknown'}`,
              ),
            );
            return;
          }
          settled = true;
          resolve();
        });
      }),
  });
}

export function deferredRuntime(
  agentWorkLab: AgentWorkLab,
  message: string,
): Runtime {
  return {
    ok: false,
    message,
    runtimeDir: window.process.env.KF_RUNTIME_DIR || '',
    kungfuVersion: window.process.env.KUNGFU_VERSION || '',
    buildInfo: null,
    skillManager: null,
    exports: [],
    schemaTypes: [],
    binding: null,
    ledger: null,
    domain: null,
    rewind: null,
    storage: null,
    remoteWork: null,
    terminal: null,
    work: null,
    workLoop: null,
    kfxControl: null,
    profile: null,
    agentRuntime: null,
    agentSession: null,
    workspace: null,
    agentWorkLab,
  };
}

function readSchemaTypes(
  binding: KfNativeBinding,
): { name: string; fields: string[] }[] {
  if (!binding.Schema) return [];
  const schema = new binding.Schema();
  return Object.keys(schema.types).map((name) => {
    let fields: string[] = [];
    try {
      fields = Object.keys(schema.types[name]());
    } catch {
      fields = [];
    }
    return { name, fields };
  });
}

let bootedRuntime: Runtime | null = null;

export function bootRuntime(): Runtime {
  if (bootedRuntime) return bootedRuntime;
  bootedRuntime = createRuntime();
  return bootedRuntime;
}

function createRuntime(): Runtime {
  const env = window.process.env;
  const runtimeDir = env.KF_RUNTIME_DIR || '';
  const agentWorkLab = openRendererAgentWorkLab();
  const base: Omit<Runtime, 'ok' | 'message'> = {
    runtimeDir,
    kungfuVersion: env.KUNGFU_VERSION || '',
    buildInfo: null,
    skillManager: null,
    exports: [],
    schemaTypes: [],
    binding: null,
    ledger: null,
    domain: null,
    rewind: null,
    storage: null,
    remoteWork: null,
    terminal: null,
    work: null,
    workLoop: null,
    kfxControl: null,
    profile: null,
    agentRuntime: null,
    agentSession: null,
    workspace: null,
    agentWorkLab,
  };
  if (
    env.KF_WORKSPACE_STATE === 'uninitialized' ||
    env.KF_WORKSPACE_STATE === 'shadow-only' ||
    env.KF_WORKSPACE_STATE === 'evidence-degraded'
  ) {
    return {
      ...base,
      ok: false,
      message: `workspace runtime unavailable (${env.KF_WORKSPACE_STATE})`,
    };
  }
  try {
    const bindingPath = env.KFE_PATH;
    if (!bindingPath) {
      return { ...base, ok: false, message: 'KFE_PATH not set' };
    }
    const binding = window.require(bindingPath) as KfNativeBinding;
    const path = window.require('node:path') as {
      dirname: (p: string) => string;
      join: (...parts: string[]) => string;
    };
    const bindingDir = path.dirname(bindingPath);
    let buildInfo: Record<string, unknown> | null = null;
    try {
      const fs = window.require('node:fs');
      buildInfo = JSON.parse(
        fs.readFileSync(path.join(bindingDir, 'kungfubuildinfo.json'), 'utf8'),
      );
    } catch {
      buildInfo = null;
    }
    let skillManager: Record<string, unknown> | null = null;
    try {
      const fs = window.require('node:fs');
      const managerPaths = [
        env.KF_SKILL_MANAGER_FILE,
        runtimeDir
          ? path.join(runtimeDir, 'skill-manager', 'default.json')
          : '',
      ].filter((p): p is string => Boolean(p));
      for (const managerPath of managerPaths) {
        try {
          skillManager = JSON.parse(fs.readFileSync(managerPath, 'utf8'));
          break;
        } catch {
          skillManager = null;
        }
      }
    } catch {
      skillManager = null;
    }
    // Joining initializes a fresh runtime home's layout and connects to a
    // live coordinator when one is running; the domain handle needs the layout.
    const ledger = openLedger({
      binding,
      locator: { runtimeDir },
      join: { name: APP_NAME },
    });
    const domain = openDomainState({ binding, locator: { runtimeDir } });
    const rewindFs = window.require('node:fs');
    const rewind = openRewind({
      binding,
      locator: { runtimeDir },
      readFile: (p: string) => rewindFs.readFileSync(p),
      readDir: (d: string) => rewindFs.readdirSync(d),
    });
    const storage = openStorage({ binding, locator: { runtimeDir } });
    const kfxControl = openKfxControl({ binding, locator: { runtimeDir } });
    const work = openWork({
      binding,
      locator: { runtimeDir },
      readFile: (p: string) => rewindFs.readFileSync(p),
    });
    const childProcess = window.require('node:child_process') as {
      execFileSync: (
        file: string,
        args: string[],
        options: {
          encoding: 'utf8';
          env: Record<string, string | undefined>;
          maxBuffer?: number;
        },
      ) => string;
    };
    const cliIpc = (
      window.require('electron') as {
        ipcRenderer: {
          invoke: (
            channel: string,
            payload: unknown,
          ) => Promise<
            { ok: true; stdout: string } | { ok: false; error: string }
          >;
        };
      }
    ).ipcRenderer;
    const cliOptions = {
      runtimeDir,
      execFileSync: (
        file: string,
        args: string[],
        options: {
          encoding: 'utf8';
          env: Record<string, string | undefined>;
          maxBuffer?: number;
        },
      ) =>
        childProcess.execFileSync(file, guiKungfuCliArgs(env, args), options),
      env: window.process.env as Record<string, string | undefined>,
      bin:
        env.KUNGFU_CLI_BIN ||
        env.KUNGFU_BIN ||
        path.join(
          bindingDir,
          process.platform === 'win32' ? 'kungfu.exe' : 'kungfu',
        ),
    };
    const profile = openProfile({
      ...cliOptions,
      execFile: async (_file: string, args: string[]) => {
        const result = await cliIpc.invoke(PROFILE_CLI_EXEC_CHANNEL, {
          args,
        });
        if (!result.ok) throw new Error(result.error);
        return result.stdout;
      },
    });
    const workLoop = openWorkLoop({
      runtimeDir,
      repoRoot: env.KF_WORKSPACE_ROOT || '',
      bin: cliOptions.bin,
      env: cliOptions.env,
      execFile: async (_file: string, args: string[]) => {
        const result = await cliIpc.invoke(WORK_LOOP_CLI_EXEC_CHANNEL, {
          args,
        });
        if (!result.ok) throw new Error(result.error);
        return result.stdout;
      },
    });
    const agentRuntime = openAgentRuntime({
      bin: cliOptions.bin,
      env: cliOptions.env,
      execFile: async (_file: string, args: string[]) => {
        const result = await cliIpc.invoke(AGENT_RUNTIME_CLI_EXEC_CHANNEL, {
          args,
        });
        if (!result.ok) throw new Error(result.error);
        return result.stdout;
      },
    });
    // Installer qualification is intentionally one-shot. Do not expose the
    // durable Agent Session capability there: its worker outlives Electron and
    // would keep the temporary installation active during the uninstall gate.
    const agentSession =
      env.KF_QUALIFICATION_MODE === '1'
        ? null
        : createAgentSessionProxy(cliIpc);
    const workspace = openWorkspaceGuidance(cliOptions);
    const remoteWork = openRemoteWork({
      binding,
      locator: { runtimeDir },
      readFile: (p: string) => rewindFs.readFileSync(p),
      readDir: (d: string) => rewindFs.readdirSync(d),
    });
    // node-pty is a native addon loaded like the kungfu binding; if it is
    // absent or built for another ABI the terminal handle stays null and the
    // terminal view surfaces the absence rather than crashing the runtime.
    let terminal: Terminal | null = null;
    try {
      if (env.KF_TERMINAL_HOST === 'main') {
        // KF-ADR-019f86da-4f90-7153-a6c1-ab7a0a3cf481: the durable host runs in the main process; reach it over the
        // terminal relay. The host outlives windows and (later) is shared by
        // every window.
        const ipcRenderer = (
          window.require('electron') as { ipcRenderer: IpcRendererLike }
        ).ipcRenderer;
        terminal = createTerminalProxy(ipcRenderer);
      } else {
        // Default: the host runs in this renderer. The tmux durability backend
        // is optional; without a tmux binary sessions run directly.
        const ptyModule = window.require('node-pty') as PtyModule;
        const tmux = resolveTmuxBinding(window) ?? undefined;
        terminal = openTerminal({
          pty: ptyModule,
          tmux,
          baseEnv: window.process.env as Record<string, string | undefined>,
        });
      }
    } catch {
      terminal = null;
    }
    return {
      ...base,
      ok: true,
      message: `in-process binding loaded · ${Object.keys(binding).length} exports`,
      buildInfo,
      skillManager,
      exports: Object.keys(binding),
      schemaTypes: readSchemaTypes(binding),
      binding,
      ledger,
      domain,
      rewind,
      storage,
      remoteWork,
      terminal,
      work,
      workLoop,
      kfxControl,
      profile,
      agentRuntime,
      agentSession,
      workspace,
    };
  } catch (e) {
    return { ...base, ok: false, message: (e as Error).message };
  }
}
