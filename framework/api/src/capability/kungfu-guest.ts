// The binding-less guest host (KF-ADR-019f86da-4f90-7789-8b48-620aa694acf9): the production caller the KF-ADR-019f86da-4f90-79f1-8716-aca36b142847
// runtime-plane primitives were built for. It composes the OS-sandbox launcher
// (./sandbox-launcher), the child-process relay transport (./subprocess), and a
// per-runtime guest proxy (./guest-node for Node, capability/guest.py for
// Python) into one host that presents a single uniform capability surface to
// every extension runtime — the trust tier selecting the channel underneath.
//
// The surface is uniform and asynchronous in both tiers (an extension never
// branches on which tier it runs in):
//
//   - Trusted, co-resident: createInProcessAsyncCaps short-circuits every call
//     in-process against the real capabilities and returns their results BY
//     REFERENCE — the zero-copy trusted channel of KF-ADR-019f86da-4f90-79f1-8716-aca36b142847, wrapped only in an
//     immediately-resolved promise so the surface matches the sandbox tier.
//   - Default, sandboxed: launchSandboxedGuest runs the guest in an OS sandbox
//     and serves its declared capabilities over the stdio relay, which returns
//     serialized copies. The performance split KF-ADR-019f86da-4f90-79f1-8716-aca36b142847 cut along the trust axis
//     is preserved; only the surface is unified.
//
// The host never hands the guest the native binding: it addresses only the
// capability surface either way. Undeclared capabilities are absent in both
// tiers — rejected at the relay host, and never built into the in-process proxy.
import {
  type AppContainerSpec,
  type SandboxProfile,
  osSandboxCommand,
  windowsAppContainerSpec,
} from './sandbox-launcher.js';
import { createCapabilityHost } from './sandbox.js';
import { serveSubprocessCapabilities } from './subprocess.js';

// ── trusted tier: in-process async surface, zero-copy by reference ───────────

// Build the uniform async capability object for a co-resident trusted guest. It
// contains exactly the declared capabilities; each method calls the real
// capability in-process and resolves immediately with the real return value —
// no serialization, no copy, journal handles kept by reference. The Promise
// wrapper is the only thing the trusted tier adds, so an extension's source is
// identical to the sandboxed tier's. An undeclared capability, or a method the
// capability does not have, rejects — the same boundary the relay host enforces.
export function createInProcessAsyncCaps(
  caps: Record<string, Record<string, unknown>>,
  declared: readonly string[],
): Record<string, unknown> {
  const allowed = new Set(declared);
  const out: Record<string, unknown> = {};
  for (const cap of declared) {
    out[cap] = new Proxy(
      {},
      {
        get(_target, method) {
          if (typeof method !== 'string') return undefined;
          return (...args: unknown[]): Promise<unknown> => {
            if (!allowed.has(cap)) {
              return Promise.reject(
                new Error(`capability '${cap}' is not declared by this kfx`),
              );
            }
            const handle = caps[cap];
            const fn = handle?.[method];
            if (typeof fn !== 'function') {
              return Promise.reject(
                new Error(`capability '${cap}' has no method '${method}'`),
              );
            }
            try {
              // apply in-process; the result — an array, a journal handle, a
              // Subscription — is returned by reference, then wrapped so the
              // surface is a Promise like the sandbox tier's.
              return Promise.resolve(
                (fn as (...a: unknown[]) => unknown).apply(handle, args),
              );
            } catch (e) {
              return Promise.reject(e as Error);
            }
          };
        },
      },
    );
  }
  return out;
}

// ── default tier: OS-sandboxed child served over the stdio relay ─────────────

// The subset of a spawned child process the host wires. Structural so a test can
// pass a double instead of a real ChildProcess.
export type GuestChild = {
  stdout: NodeJS.ReadableStream | null;
  stdin: { write: (chunk: string) => void } | null;
  on: (event: 'exit', cb: (code: number | null) => void) => void;
  once: (event: 'exit' | 'close', cb: () => void) => void;
  kill?: (signal?: NodeJS.Signals) => void;
};

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { stdio: ['pipe', 'pipe', 'inherit']; env: NodeJS.ProcessEnv },
) => GuestChild;

// The Windows launch seam (KF-ADR-019f86da-4f90-7789-8b48-620aa694acf9): on win32 the confinement is not a command
// wrapper Node can spawn — an AppContainer must be applied by a native
// CreateProcess. The host injects this launcher (backed by libkungfu
// `spawn_app_container`; see guest-windows.ts) so kungfu-guest stays binding-less
// and the injection point mirrors KF-ADR-019f86da-4f90-7e5e-ae22-2a8fc24086f1's capability injection. It returns a
// GuestChild (the same structural shape the relay serves over), so everything
// downstream is unchanged.
export type WindowsSandboxSpawn = (
  command: string,
  args: readonly string[],
  spec: AppContainerSpec,
  options: { env: NodeJS.ProcessEnv },
) => Promise<GuestChild>;

// How to boot the child-side guest proxy: the interpreter and its argv, plus any
// env the child bootstrap reads (e.g. the declared set and the facet entry). The
// command is wrapped in the OS sandbox before it is spawned.
export type GuestRuntimeLaunch = {
  command: string;
  args: readonly string[];
  env?: Record<string, string>;
};

export type GuestProcessOptions = {
  runtime: GuestRuntimeLaunch;
  // the real capabilities the host resolves calls against
  caps: Record<string, Record<string, unknown>>;
  // the capability keys this guest declared; only these are reachable
  declared: readonly string[];
  // injectable for tests; defaults to node:child_process spawn (unix path)
  spawn?: SpawnFn;
  // Existing callers inherit for compatibility. KFX services set false so
  // credentials and unrelated host state never become ambient child authority.
  inheritEnv?: boolean;
  // Python services support a relay control frame before the host escalates to
  // process termination.
  gracefulShutdown?: { timeoutMs: number };
};

export type SandboxedGuestOptions = GuestProcessOptions & {
  // OS sandbox profile; defaults to the KF-ADR-019f86da-4f90-7789-8b48-620aa694acf9 permissive first-delivery
  // profile — able to run, not yet restricted. Turn a knob on to narrow it.
  profile?: SandboxProfile;
  // required on win32: the AppContainer launcher (libkungfu-backed). Injected by
  // the host so kungfu-guest holds no native binding itself.
  windowsSpawn?: WindowsSandboxSpawn;
};

export type GuestProcess = {
  // stop serving and terminate the child
  dispose: () => void;
  // resolves with the child's exit code (null if signalled)
  exited: Promise<number | null>;
};

export type SandboxedGuest = GuestProcess;

async function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { stdio: ['pipe', 'pipe', 'inherit']; env: NodeJS.ProcessEnv },
): Promise<GuestChild> {
  const { spawn } = await import('node:child_process');
  return spawn(command, args as string[], options) as unknown as GuestChild;
}

const MINIMAL_ENV_KEYS = [
  'HOME',
  'LANG',
  'LC_ALL',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
] as const;

function guestEnvironment(opts: GuestProcessOptions): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  if (opts.inheritEnv !== false) {
    Object.assign(base, process.env);
  } else {
    for (const key of MINIMAL_ENV_KEYS) {
      if (process.env[key] !== undefined) base[key] = process.env[key];
    }
  }
  return { ...base, ...opts.runtime.env };
}

function wireGuest(
  child: GuestChild,
  opts: GuestProcessOptions,
  label: string,
): GuestProcess {
  if (!child.stdout || !child.stdin) {
    throw new Error(`${label} guest child has no piped stdio to relay over`);
  }

  const host = serveSubprocessCapabilities(
    { stdout: child.stdout, stdin: child.stdin, once: child.once.bind(child) },
    (emit) => createCapabilityHost(opts.caps, opts.declared, emit),
  );
  let exitedAlready = false;
  let disposed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let exitCode: number | null = null;
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      exitedAlready = true;
      exitCode = code;
      if (killTimer) clearTimeout(killTimer);
    });
    // Resolve the public lifecycle only after stdio has closed. The relay owns
    // final capability frames until this boundary; resolving on `exit` can
    // otherwise race a graceful Python service's last awaited call.
    child.once('close', () => {
      host.dispose();
      resolve(exitCode);
    });
  });

  return {
    dispose() {
      if (disposed || exitedAlready) return;
      disposed = true;
      if (opts.gracefulShutdown) {
        host.requestShutdown();
        killTimer = setTimeout(() => {
          if (!exitedAlready) child.kill?.();
        }, opts.gracefulShutdown.timeoutMs);
        killTimer.unref?.();
        return;
      }
      host.dispose();
      child.kill?.();
    },
    exited,
  };
}

// Launch an explicitly integrated guest subprocess without an OS sandbox.
// Authorization remains the caller's responsibility; the relay still exposes
// only the exact declared capability set.
export async function launchIntegratedGuest(
  opts: GuestProcessOptions,
): Promise<GuestProcess> {
  const env = guestEnvironment(opts);
  const child = opts.spawn
    ? opts.spawn(opts.runtime.command, opts.runtime.args, {
        stdio: ['pipe', 'pipe', 'inherit'],
        env,
      })
    : await defaultSpawn(opts.runtime.command, opts.runtime.args, {
        stdio: ['pipe', 'pipe', 'inherit'],
        env,
      });
  return wireGuest(child, opts, 'integrated');
}

// Launch a guest inside the OS sandbox and serve its declared capabilities over
// the stdio relay. The interpreter runs confined; its only egress is the relay
// on its stdio (stderr is inherited for diagnostics). Returns a handle whose
// `exited` promise resolves when the child exits.
export async function launchSandboxedGuest(
  opts: SandboxedGuestOptions,
): Promise<SandboxedGuest> {
  const profile = opts.profile ?? { base: 'permissive' };
  const env = guestEnvironment(opts);

  let child: GuestChild;
  if (process.platform === 'win32') {
    // Windows: an AppContainer is applied by the injected native launcher; there
    // is no command wrapper to spawn. The launcher CreateProcess-es the guest
    // into the AppContainer and returns a GuestChild.
    if (!opts.windowsSpawn) {
      throw new Error(
        'windows sandbox requires a windowsSpawn launcher (libkungfu-backed) ' +
          'to be injected; refusing to launch an untrusted guest unconfined',
      );
    }
    child = await opts.windowsSpawn(
      opts.runtime.command,
      opts.runtime.args,
      windowsAppContainerSpec(profile),
      { env },
    );
  } else {
    // macOS / Linux: wrap the command in the OS sandbox CLI, then spawn it.
    const wrapped = osSandboxCommand(
      opts.runtime.command,
      opts.runtime.args,
      profile,
    );
    child = opts.spawn
      ? opts.spawn(wrapped.command, wrapped.args, {
          stdio: ['pipe', 'pipe', 'inherit'],
          env,
        })
      : await defaultSpawn(wrapped.command, wrapped.args, {
          stdio: ['pipe', 'pipe', 'inherit'],
          env,
        });
  }

  return wireGuest(child, opts, 'sandboxed');
}
