// The service host: land a background-service kfx a host discovered through
// planKfx (KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be). This is where the three runtime-plane pieces the earlier
// stages built compose into one production caller — the plan entry (stage 2a),
// the user grant → sandbox profile (stage 2c), and the OS-sandbox launch + stdio
// relay (stage 2b) — so a discovered service is landed by the same rule on any
// host that consumes the plan.
//
// The trust verdict picks the landing, the user grant only tunes it:
//   - trusted  → co-resident: the body runs in this host process against the
//     zero-copy in-process capability surface, unconfined (it is trusted).
//   - untrusted → OS sandbox: the body runs in a sandboxed child whose profile
//     is resolved from the stored grants (resolveServiceLanding), reaching the
//     host only over the stdio relay. A grant can loosen this sandbox; it can
//     never promote the service to co-resident (the tier is not user-pierceable).
//
// This delivery lands the NODE runtime and the UNTRUSTED (OS-sandboxed) C++
// runtime end to end. A C++ service ships a prebuilt per-platform binary
// (KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be): with no interpreter it needs no bootstrap — the host launches the
// binary directly and it speaks the relay through its linked guest proxy
// (framework/core/src/capability/guest.hpp). Trusted co-resident C++/Python
// (an unsandboxed interpreter/binary subprocess) remains the tier x runtime
// host-wiring follow-up; an unsupported runtime is refused here rather than
// mis-launched.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  type SandboxedGuest,
  type ServiceAuthz,
  type SpawnFn,
  type WindowsSandboxSpawn,
  createInProcessAsyncCaps,
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
  // the stored three-layer authorization; an ungranted untrusted service lands
  // default-deny.
  authz: ServiceAuthz;
  // override the node bootstrap path (defaults to the sibling service-bootstrap).
  bootstrap?: string;
  // injectable for tests; forwarded to launchSandboxedGuest.
  spawn?: SpawnFn;
  windowsSpawn?: WindowsSandboxSpawn;
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
// which imports the service's node entry and speaks the relay. C++ has no
// bootstrap: the prebuilt per-platform binary IS the guest, so the host launches
// it directly. Every entry path is resolved against the package directory
// planKfx recorded.
export function resolveServiceRuntime(
  entry: KfxServicePlanEntry,
  bootstrap: string,
  declared: readonly string[],
): { command: string; args: string[]; env: Record<string, string> } {
  if (entry.runtimes.includes('node') && entry.entry.node) {
    return {
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
      command: join(entry.dir, relBinary),
      args: [],
      env: { KFX_DECLARED: JSON.stringify(declared) },
    };
  }
  throw new Error(
    `service '${entry.id}' declares no launchable runtime (node or cpp); a trusted co-resident python/cpp interpreter is the tier x runtime host-wiring follow-up`,
  );
}

// Land a discovered service. The verdict on the plan entry chooses the tier; the
// grant only tunes an untrusted service's sandbox profile.
export async function launchDiscoveredService(
  entry: KfxServicePlanEntry,
  opts: LaunchServiceOptions,
): Promise<LaunchedService> {
  const declared = entry.capabilities as readonly string[];
  const landing = resolveServiceLanding(opts.authz, entry.id, entry.trusted);

  if (landing.tier === 'co-resident') {
    // trusted: run the body in-process against the zero-copy async surface. Only
    // node can run in this host process; a trusted python/cpp service is a
    // co-resident interpreter subprocess — the stage-3 matrix, refused here.
    if (!entry.runtimes.includes('node') || !entry.entry.node) {
      throw new Error(
        `trusted service '${entry.id}' has no node body; a co-resident python/cpp interpreter is the stage-3 host-wiring follow-up`,
      );
    }
    const caps = createInProcessAsyncCaps(opts.caps, declared);
    const bodyPath = join(entry.dir, entry.entry.node);
    const done = import(pathToFileURL(bodyPath).href)
      .then((mod: { run: (c: Record<string, unknown>) => Promise<void> }) =>
        mod.run(caps),
      )
      .then(() => null);
    return { tier: 'co-resident', done, dispose: () => {} };
  }

  // untrusted: OS-sandboxed child, profile resolved from the grants.
  const runtime = resolveServiceRuntime(
    entry,
    opts.bootstrap ?? DEFAULT_BOOTSTRAP,
    declared,
  );
  const guest: SandboxedGuest = await launchSandboxedGuest({
    runtime,
    caps: opts.caps,
    declared,
    profile: landing.profile,
    spawn: opts.spawn,
    windowsSpawn: opts.windowsSpawn,
  });
  return {
    tier: 'sandbox',
    done: guest.exited,
    dispose: guest.dispose,
    networkConsent: landing.networkConsent,
  };
}
