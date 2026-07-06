// Runtime access for the reference app: load the native kungfu binding
// in-process (nodeIntegration renderer), inject it into the capability SDK
// (ADR-0011), and hand capability handles to the shell and its kfx. This is
// the moat: the renderer reaches the runtime directly, no IPC copy.
import {
  type DomainState,
  type KfNativeBinding,
  type Ledger,
  type PtyModule,
  type Rewind,
  type Terminal,
  type TmuxBinding,
  type Work,
  openDomainState,
  openLedger,
  openRewind,
  openTerminal,
  openWork,
} from '@kungfu-tech/api/capability';
import { type IpcRendererLike, createTerminalProxy } from './terminal-proxy';

declare global {
  interface Window {
    require: NodeRequire;
    process: NodeJS.Process;
  }
}

export const APP_NAME = 'reference_app';

// Dedicated tmux socket for Kungfu managed sessions. Every managed tmux command
// carries `-L <socket>`, so it physically cannot touch the user's own
// default-socket tmux sessions. Overridable for tests/other hosts.
const TMUX_SOCKET = 'kungfu-managed';

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
    const socket = win.process.env.KF_TMUX_SOCKET || TMUX_SOCKET;
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
  longfistTypes: { name: string; fields: string[] }[];
  binding: KfNativeBinding | null;
  ledger: Ledger | null;
  domain: DomainState | null;
  rewind: Rewind | null;
  terminal: Terminal | null;
  work: Work | null;
};

function readLongfistTypes(
  binding: KfNativeBinding,
): { name: string; fields: string[] }[] {
  if (!binding.Longfist) return [];
  const lf = new binding.Longfist();
  return Object.keys(lf.types).map((name) => {
    let fields: string[] = [];
    try {
      fields = Object.keys(lf.types[name]());
    } catch {
      fields = [];
    }
    return { name, fields };
  });
}

export function bootRuntime(): Runtime {
  const env = window.process.env;
  const runtimeDir = env.KF_RUNTIME_DIR || '';
  const base: Omit<Runtime, 'ok' | 'message'> = {
    runtimeDir,
    kungfuVersion: env.KUNGFU_VERSION || '',
    buildInfo: null,
    skillManager: null,
    exports: [],
    longfistTypes: [],
    binding: null,
    ledger: null,
    domain: null,
    rewind: null,
    terminal: null,
    work: null,
  };
  try {
    const bindingPath = env.KFE_PATH;
    if (!bindingPath) {
      return { ...base, ok: false, message: 'KFE_PATH not set' };
    }
    const binding = window.require(bindingPath) as KfNativeBinding;
    let buildInfo: Record<string, unknown> | null = null;
    try {
      const fs = window.require('node:fs');
      const path = window.require('node:path');
      buildInfo = JSON.parse(
        fs.readFileSync(
          path.join(path.dirname(bindingPath), 'kungfubuildinfo.json'),
          'utf8',
        ),
      );
    } catch {
      buildInfo = null;
    }
    let skillManager: Record<string, unknown> | null = null;
    try {
      const fs = window.require('node:fs');
      const path = window.require('node:path');
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
    // live master when one is running; the domain handle needs the layout.
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
    const work = openWork({ binding, locator: { runtimeDir } });
    // node-pty is a native addon loaded like the kungfu binding; if it is
    // absent or built for another ABI the terminal handle stays null and the
    // terminal view surfaces the absence rather than crashing the runtime.
    let terminal: Terminal | null = null;
    try {
      if (env.KF_TERMINAL_HOST === 'main') {
        // ADR-0016: the durable host runs in the main process; reach it over the
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
      longfistTypes: readLongfistTypes(binding),
      binding,
      ledger,
      domain,
      rewind,
      terminal,
      work,
    };
  } catch (e) {
    return { ...base, ok: false, message: (e as Error).message };
  }
}
