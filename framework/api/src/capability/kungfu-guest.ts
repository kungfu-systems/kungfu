// The binding-less guest host (ADR-0014): the production caller the ADR-0013
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
//     REFERENCE — the zero-copy trusted channel of ADR-0013, wrapped only in an
//     immediately-resolved promise so the surface matches the sandbox tier.
//   - Default, sandboxed: launchSandboxedGuest runs the guest in an OS sandbox
//     and serves its declared capabilities over the stdio relay, which returns
//     serialized copies. The performance split ADR-0013 cut along the trust axis
//     is preserved; only the surface is unified.
//
// The host never hands the guest the native binding: it addresses only the
// capability surface either way. Undeclared capabilities are absent in both
// tiers — rejected at the relay host, and never built into the in-process proxy.
import { type SandboxProfile, osSandboxCommand } from './sandbox-launcher.js';
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

// How to boot the child-side guest proxy: the interpreter and its argv, plus any
// env the child bootstrap reads (e.g. the declared set and the facet entry). The
// command is wrapped in the OS sandbox before it is spawned.
export type GuestRuntimeLaunch = {
  command: string;
  args: readonly string[];
  env?: Record<string, string>;
};

export type SandboxedGuestOptions = {
  runtime: GuestRuntimeLaunch;
  // the real capabilities the host resolves calls against
  caps: Record<string, Record<string, unknown>>;
  // the capability keys this guest declared; only these are reachable
  declared: readonly string[];
  // OS sandbox profile; defaults to the ADR-0014 permissive first-delivery
  // profile — able to run, not yet restricted. Turn a knob on to narrow it.
  profile?: SandboxProfile;
  // injectable for tests; defaults to node:child_process spawn
  spawn?: SpawnFn;
};

export type SandboxedGuest = {
  // stop serving and terminate the child
  dispose: () => void;
  // resolves with the child's exit code (null if signalled)
  exited: Promise<number | null>;
};

async function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { stdio: ['pipe', 'pipe', 'inherit']; env: NodeJS.ProcessEnv },
): Promise<GuestChild> {
  const { spawn } = await import('node:child_process');
  return spawn(command, args as string[], options) as unknown as GuestChild;
}

// Launch a guest inside the OS sandbox and serve its declared capabilities over
// the stdio relay. The interpreter runs confined; its only egress is the relay
// on its stdio (stderr is inherited for diagnostics). Returns a handle whose
// `exited` promise resolves when the child exits.
export async function launchSandboxedGuest(
  opts: SandboxedGuestOptions,
): Promise<SandboxedGuest> {
  const wrapped = osSandboxCommand(
    opts.runtime.command,
    opts.runtime.args,
    opts.profile ?? { base: 'permissive' },
  );
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.runtime.env };
  const spawnFn = opts.spawn;
  const child = spawnFn
    ? spawnFn(wrapped.command, wrapped.args, {
        stdio: ['pipe', 'pipe', 'inherit'],
        env,
      })
    : await defaultSpawn(wrapped.command, wrapped.args, {
        stdio: ['pipe', 'pipe', 'inherit'],
        env,
      });

  if (!child.stdout || !child.stdin) {
    throw new Error('sandboxed guest child has no piped stdio to relay over');
  }

  const host = serveSubprocessCapabilities(
    { stdout: child.stdout, stdin: child.stdin, once: child.once.bind(child) },
    (emit) => createCapabilityHost(opts.caps, opts.declared, emit),
  );

  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      host.dispose();
      resolve(code);
    });
  });

  return {
    dispose() {
      host.dispose();
      child.kill?.();
    },
    exited,
  };
}
