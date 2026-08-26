// The service host: land a background-service kfx a host discovered through
// planKfx. Discovery remains inert; a caller must also provide the exact Core
// host authorization that roots Passport, policy, Work/Warrant, capability
// grant, cut and generation. No package identity or install origin selects the
// landing.
//
// Node may run co-resident when explicitly authorized. Python always runs in a
// separate interpreter process on the standard asyncio bootstrap; isolated
// placement adds the OS sandbox and integrated-explicit placement omits only
// that membrane. A C++ service ships a prebuilt per-platform binary
// (KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be): with no interpreter it needs no bootstrap — the host launches the
// binary directly and it speaks the relay through its linked guest proxy
// (framework/core/src/capability/guest.hpp). Unsupported runtime/platform
// combinations are refused rather than mis-launched.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  type GuestProcess,
  type KfxRuntimeWarrant,
  type KfxRuntimeWarrantAdoption,
  type KfxRuntimeWarrantAuthorization,
  type SandboxedGuest,
  type SpawnFn,
  type WindowsSandboxSpawn,
  createInProcessAsyncCaps,
  launchIntegratedGuest,
  launchSandboxedGuest,
  resolveServiceLanding,
} from '@kungfu-tech/api/capability';
import type { KfxServicePlanEntry } from '@kungfu-tech/kfx';

// The production node bootstrap shipped beside this module: it connects the
// stdio relay and runs the discovered service body inside the sandboxed child.
const DEFAULT_BOOTSTRAP = join(import.meta.dirname, 'service-bootstrap.mjs');

export type LaunchServiceOptions = {
  // the real capabilities the host resolves the service's relay calls against;
  // only the entry's declared capabilities are reachable.
  caps: Record<string, Record<string, unknown>>;
  authorization: KfxRuntimeWarrantAuthorization;
  // Product hosts may launch only while holding the Core-issued lease. The
  // transport is injected so tests and alternate native embeddings retain the
  // same authority path rather than reimplementing warrant state locally.
  runtimeWarrant: KfxRuntimeWarrant;
  runtimeWarrantHolder?: string;
  runtimeWarrantLeaseMs?: number;
  runtimeWarrantHeartbeatTtlMs?: number;
  runtimeWarrantNow?: () => number;
  runtimeWarrantNonce?: () => string;
  // override the node bootstrap path (defaults to the sibling service-bootstrap).
  bootstrap?: string;
  // injectable for tests; forwarded to launchSandboxedGuest.
  spawn?: SpawnFn;
  windowsSpawn?: WindowsSandboxSpawn;
  // Python's executable and import path are explicit host inputs. Production
  // installations normally need neither override; source-tree qualification
  // supplies pythonPath so `kungfu.kfx_host` resolves from this checkout.
  pythonCommand?: string;
  pythonPath?: string;
  pythonShutdownTimeoutMs?: number;
};

// A landed service, uniform across tiers: `done` resolves when the service ends
// (the child's exit code in the sandbox tier, null when a co-resident body
// returns), `dispose` stops it. `networkConsent` is present in the sandbox tier
// and true when the applied profile opened the network — the flag a host gates
// behind informed consent.
export type LaunchedService = {
  tier: 'co-resident' | 'sandbox';
  done: Promise<number | null>;
  dispose: () => void;
  networkConsent?: boolean;
};

// Map this Node platform to the C++ entry's per-platform key (KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be).
const CPP_PLATFORM: Partial<
  Record<NodeJS.Platform, 'darwin' | 'linux' | 'win'>
> = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'win',
};

// Resolve the launch for a discovered service. Node runs the shipped bootstrap,
// Python runs `kungfu.kfx_host` on the supported interpreter, and C++ has no
// bootstrap: the prebuilt per-platform binary IS the guest. Every entry path is
// resolved against the package directory planKfx recorded.
export function resolveServiceRuntime(
  entry: KfxServicePlanEntry,
  bootstrap: string,
  declared: readonly string[],
  python: {
    command?: string;
    path?: string;
    shutdownTimeoutMs?: number;
    authorization?: KfxRuntimeWarrantAuthorization;
  } = {},
): {
  kind: 'node' | 'cpp' | 'python';
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  if (entry.runtimes.includes('node') && entry.entry.node) {
    return {
      kind: 'node',
      command: process.execPath,
      args: [bootstrap],
      env: {
        KFX_DECLARED: JSON.stringify(declared),
        KFX_SERVICE_ENTRY: join(entry.dir, entry.entry.node),
      },
    };
  }
  if (entry.runtimes.includes('cpp') && entry.entry.cpp) {
    // The prebuilt-artifact cpp entry: pick this platform's binary and launch it
    // with no bootstrap or argv — it links the guest proxy and its body into one
    // image. A platform absent from the map cannot run this service here.
    const key = CPP_PLATFORM[process.platform];
    const relBinary = key ? entry.entry.cpp[key] : undefined;
    if (!relBinary) {
      throw new Error(
        `service '${entry.id}' ships no cpp binary for platform '${process.platform}'`,
      );
    }
    return {
      kind: 'cpp',
      command: join(entry.dir, relBinary),
      args: [],
      env: { KFX_DECLARED: JSON.stringify(declared) },
    };
  }
  if (entry.runtimes.includes('python') && entry.entry.python) {
    const authorization = python.authorization;
    const shutdownTimeoutMs = python.shutdownTimeoutMs ?? 5_000;
    return {
      kind: 'python',
      command:
        python.command ?? (process.platform === 'win32' ? 'python' : 'python3'),
      args: ['-m', 'kungfu.kfx_host'],
      env: {
        KFX_DECLARED: JSON.stringify(declared),
        KFX_SERVICE_ENTRY: join(entry.dir, entry.entry.python),
        KFX_SERVICE_SHUTDOWN_TIMEOUT: String(shutdownTimeoutMs / 1_000),
        KFX_SERVICE_PACKAGE_KEY: authorization?.packageKey ?? entry.id,
        KFX_SERVICE_AUTHORIZATION_ROOT: authorization?.authorizationRoot ?? '',
        KFX_SERVICE_CAPABILITY_GRANT_ROOT:
          authorization?.capabilityGrantRoot ?? '',
        KFX_SERVICE_GENERATION_ROOT: authorization?.generationRoot ?? '',
        PYTHONDONTWRITEBYTECODE: '1',
        ...(python.path ? { PYTHONPATH: python.path } : {}),
      },
    };
  }
  throw new Error(
    `service '${entry.id}' declares no launchable runtime (node, cpp, or python)`,
  );
}

// Land a discovered service only through its exact Core authorization.
export async function launchDiscoveredService(
  entry: KfxServicePlanEntry,
  opts: LaunchServiceOptions,
): Promise<LaunchedService> {
  const declared = entry.capabilities as readonly string[];
  const required = opts.authorization.requiredCapabilities;
  if (
    opts.authorization.packageKey !== entry.id ||
    required.length !== declared.length ||
    required.some((capability) => !declared.includes(capability)) ||
    declared.some(
      (capability) =>
        !required.includes(capability) ||
        !opts.authorization.grantedCapabilities.includes(capability),
    )
  ) {
    throw new Error(
      'KF_KFX_HOST_NOT_AUTHORIZED: service discovery and authorization do not match',
    );
  }
  const runtime = resolveServiceRuntime(
    entry,
    opts.bootstrap ?? DEFAULT_BOOTSTRAP,
    declared,
    {
      command: opts.pythonCommand,
      path: opts.pythonPath,
      shutdownTimeoutMs: opts.pythonShutdownTimeoutMs,
      authorization: opts.authorization,
    },
  );
  const expectedHost = `service-${runtime.kind}`;
  if (opts.authorization.host !== expectedHost) {
    throw new Error(
      'KF_KFX_HOST_NOT_AUTHORIZED: service runtime and authorization host do not match',
    );
  }
  const landing = resolveServiceLanding(opts.authorization);
  const now = opts.runtimeWarrantNow ?? Date.now;
  const issuedAt = now();
  const leaseMs = opts.runtimeWarrantLeaseMs ?? 60_000;
  const heartbeatTtl = opts.runtimeWarrantHeartbeatTtlMs ?? 15_000;
  const holder =
    opts.runtimeWarrantHolder ??
    `kungfu-service-host:${process.pid}:${entry.id}`;
  const adoption = opts.runtimeWarrant.adopt(opts.authorization, {
    holder,
    purpose: `run authorized ${expectedHost} product adapter`,
    leaseNonce: opts.runtimeWarrantNonce?.() ?? randomUUID(),
    issuedAt,
    expiresAt: issuedAt + leaseMs,
    heartbeatTtl,
    residualResponsibility: 'retained-by-kungfu-core',
    requestedCapabilities: [...declared],
  });

  let guestDone: Promise<number | null>;
  let guestDispose: () => void;
  let tier: LaunchedService['tier'];
  let networkConsent: boolean | undefined;

  try {
    if (landing.tier === 'co-resident') {
      tier = 'co-resident';
      // Integrated execution is an explicit placement in the rooted grant.
      if (runtime.kind === 'node' && entry.entry.node) {
        const caps = createInProcessAsyncCaps(opts.caps, declared);
        const bodyPath = join(entry.dir, entry.entry.node);
        guestDone = import(pathToFileURL(bodyPath).href)
          .then((mod: { run: (c: Record<string, unknown>) => Promise<void> }) =>
            mod.run(caps),
          )
          .then(() => null);
        guestDispose = () => {};
      } else {
        if (runtime.kind !== 'python') {
          throw new Error(
            `integrated service '${entry.id}' has no node or python body`,
          );
        }
        const guest: GuestProcess = await launchIntegratedGuest({
          runtime,
          caps: opts.caps,
          declared,
          spawn: opts.spawn,
          inheritEnv: false,
          gracefulShutdown: {
            timeoutMs: (opts.pythonShutdownTimeoutMs ?? 5_000) + 1_000,
          },
        });
        guestDone = guest.exited;
        guestDispose = guest.dispose;
      }
    } else {
      // Isolated execution is physically confined by the Core-derived profile.
      const guest: SandboxedGuest = await launchSandboxedGuest({
        runtime,
        caps: opts.caps,
        declared,
        profile: landing.profile,
        spawn: opts.spawn,
        windowsSpawn: opts.windowsSpawn,
        inheritEnv: runtime.kind !== 'python',
        gracefulShutdown:
          runtime.kind === 'python'
            ? { timeoutMs: (opts.pythonShutdownTimeoutMs ?? 5_000) + 1_000 }
            : undefined,
      });
      tier = 'sandbox';
      guestDone = guest.exited;
      guestDispose = guest.dispose;
      networkConsent = landing.networkConsent;
    }
  } catch (error) {
    settleRuntimeWarrant(opts.runtimeWarrant, adoption, now(), 'failed');
    throw error;
  }

  let disposed = false;
  let rejectLease: (reason: unknown) => void = () => {};
  const leaseFailure = new Promise<never>((_resolve, reject) => {
    rejectLease = reject;
  });
  const interval = setInterval(
    () => {
      try {
        const transition = opts.runtimeWarrant.heartbeat(adoption, now());
        if (transition.leaseState.state !== 'active') {
          throw new Error('KFX Runtime Warrant heartbeat was not retained');
        }
      } catch (error) {
        guestDispose();
        rejectLease(error);
      }
    },
    Math.max(1, Math.floor(heartbeatTtl / 2)),
  );
  interval.unref();
  const done = Promise.race([guestDone, leaseFailure])
    .then(
      (exitCode) => {
        settleRuntimeWarrant(
          opts.runtimeWarrant,
          adoption,
          now(),
          disposed
            ? 'cancelled'
            : exitCode === null || exitCode === 0
              ? 'completed'
              : 'failed',
        );
        return exitCode;
      },
      (error) => {
        settleRuntimeWarrant(opts.runtimeWarrant, adoption, now(), 'failed');
        throw error;
      },
    )
    .finally(() => clearInterval(interval));
  return {
    tier,
    done,
    dispose: () => {
      disposed = true;
      guestDispose();
    },
    ...(networkConsent === undefined ? {} : { networkConsent }),
  };
}

function settleRuntimeWarrant(
  warrant: KfxRuntimeWarrant,
  adoption: KfxRuntimeWarrantAdoption,
  recordedAt: number,
  outcome: 'completed' | 'failed' | 'cancelled',
): void {
  const transition = warrant.settle(adoption, {
    recordedAt,
    outcome,
    residualResponsibilityDisposition: 'retained-by-kungfu-core',
  });
  if (transition.leaseState.state !== 'settled') {
    throw new Error('KFX Runtime Warrant terminal settlement was not retained');
  }
}
