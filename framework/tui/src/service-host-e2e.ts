// End-to-end dogfood (KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be stage 2d): a REAL service kfx, discovered by
// planKfx, authorized by the stored grant, and landed by the service host —
// proving the whole path the earlier stages built in isolation now runs as one:
//
//   discover (planKfx, stage 2a) → the plan's trust verdict
//     → authorize (resolveServiceLanding + the user grant, stage 2c)
//       → land (co-resident, or launchSandboxedGuest over the relay, stage 2b)
//         → relay (the service reaches the host; the sandbox gates its egress)
//
// The dogfood is an OpenClaw-shaped background service (dogfood-service.mjs): it
// reaches an external endpoint and reads the ledger over the relay. Three cells
// exercise both tiers from a real discovery:
//   untrusted, no grant   → OS sandbox, external egress REFUSED, relay flows
//   untrusted, net granted → OS sandbox, external egress ALLOWED, relay flows
//   trusted (first-party)  → co-resident, egress allowed (unconfined), relay flows
//
// Run with tui's tsx (workspace .ts sources resolve directly):
//   pnpm --filter @kungfu-tech/tui exec tsx src/service-host-e2e.ts
// The sandboxed child is plain `node`, so it gets the dev TS resolver through
// NODE_OPTIONS to load the capability SDK source; a packaged app ships built JS
// and needs neither. Cells that grant the network need outbound connectivity.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type KfxLoadPlan, type KfxPlanDeps, planKfx } from '@kungfu-tech/kfx';

import type { ServiceAuthz } from '@kungfu-tech/api/capability';
import { launchDiscoveredService } from './service-host.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BODY_SRC = join(HERE, 'dogfood-service.mjs');
const KEY = 'dogfood.openclaw';
const KEY_CPP = 'dogfood.openclaw.cpp';

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean): void {
  if (cond) {
    pass += 1;
    console.log(`  ok    ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}`);
  }
}

// A minimal capability surface for the dogfood: a fixture ledger (three records,
// exercising the relay) and a report sink (the host observes the outcome). The
// same shape the guest-harness builds, inline so this host harness needs no
// internal api test helper.
function buildCaps() {
  let reported: Record<string, unknown> | null = null;
  const caps = {
    ledger: {
      records: (_opts?: { limit?: number }) => [
        { genTime: 1n },
        { genTime: 2n },
        { genTime: 3n },
      ],
    },
    report: {
      result: (value: Record<string, unknown>) => {
        reported = value;
      },
    },
  };
  return {
    caps: caps as unknown as Record<string, Record<string, unknown>>,
    readReport: () => reported,
  };
}

// Compile the C++ dogfood into a prebuilt binary — what a kfx author's build
// does, inlined here so this harness stays self-contained (the same reason
// buildCaps is inline rather than imported from api). A C++ service ships a
// prebuilt per-platform binary, not source (KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be): with no interpreter, the
// host launches the binary directly. The api guest-harness has a sibling helper
// (cpp-build.mjs), kept separate for the same package self-containment.
const CPP_SOURCE = join(HERE, 'dogfood-service.cpp');
// framework/tui/src → framework/core/src/capability (the guest proxy include).
const GUEST_INCLUDE = join(HERE, '..', '..', 'core', 'src', 'capability');
const CORE_CONANFILE = join(HERE, '..', '..', 'core', 'conanfile.py');
const CPP_PLATFORM_KEY: Partial<
  Record<NodeJS.Platform, 'darwin' | 'linux' | 'win'>
> = { darwin: 'darwin', linux: 'linux', win32: 'win' };

function toolAvailable(tool: string): boolean {
  const isWin = process.platform === 'win32';
  return (
    spawnSync(isWin ? 'where' : 'command', isWin ? [tool] : ['-v', tool], {
      stdio: 'ignore',
    }).status === 0
  );
}

// Resolve the nlohmann/json include dir via conan (pinned by core/conanfile.py;
// already cached once core is configured — this only reads the graph).
function nlohmannInclude(): string {
  const version = fs
    .readFileSync(CORE_CONANFILE, 'utf8')
    .match(/nlohmann_json\/([\d.]+)/)?.[1];
  if (!version) {
    throw new Error('cannot find nlohmann_json version in core/conanfile.py');
  }
  // Run conan in a throwaway dir: `conan install` writes activation-script
  // generators into its cwd, which must not leak into the source tree. Only the
  // JSON graph on stdout is used.
  const scratch = mkdtempSync(join(tmpdir(), 'kfx-conan-'));
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync(
      'conan',
      ['install', `--requires=nlohmann_json/${version}`, '--format=json'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, cwd: scratch },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (r.status !== 0) {
    throw new Error(
      `conan install nlohmann_json/${version} failed:\n${r.stderr || r.stdout}`,
    );
  }
  const graph = JSON.parse(r.stdout as string) as {
    graph: {
      nodes: Record<string, { name?: string; package_folder?: string }>;
    };
  };
  for (const node of Object.values(graph.graph.nodes)) {
    if (node.name === 'nlohmann_json' && node.package_folder) {
      const inc = join(node.package_folder, 'include');
      if (fs.existsSync(inc)) return inc;
    }
  }
  throw new Error(
    'nlohmann_json include dir not resolved from the conan graph',
  );
}

// Compile CPP_SOURCE into `outFile`. Returns false when a toolchain or conan is
// absent, so the cpp lane degrades to a clean skip rather than a failure.
function buildCppDogfood(outFile: string): boolean {
  const isWin = process.platform === 'win32';
  const cxx = process.env.CXX ?? (isWin ? 'cl' : 'c++');
  if (!toolAvailable(cxx) || !toolAvailable('conan')) return false;
  const inc = nlohmannInclude();
  const args = isWin
    ? [
        '/std:c++17',
        '/EHsc',
        '/O2',
        '/nologo',
        `/I${GUEST_INCLUDE}`,
        `/I${inc}`,
        CPP_SOURCE,
        `/Fe${outFile}`,
      ]
    : [
        '-std=c++17',
        '-O2',
        '-pthread',
        '-I',
        GUEST_INCLUDE,
        '-isystem',
        inc,
        CPP_SOURCE,
        '-o',
        outFile,
      ];
  const r = spawnSync(cxx, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`C++ compile failed (${cxx}):\n${r.stderr || r.stdout}`);
  }
  return true;
}

// Lay down a real service kfx package in a temp extension root and discover it
// with planKfx. `trusted` writes a first-party manifest that pins the key, so the
// plan's verdict comes out trusted; otherwise the key is unknown and untrusted.
function discoverDogfood(trusted: boolean): {
  plan: KfxLoadPlan;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'kfx-dogfood-'));
  const pkgDir = join(root, 'openclaw');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: '@dogfood/openclaw',
      version: '1.0.0',
      kungfuConfig: {
        key: KEY,
        config: {
          service: {
            runtimes: ['node'],
            entry: { node: 'service.mjs' },
            capabilities: ['ledger', 'report'],
          },
        },
      },
    }),
  );
  // the service body ships in the package, exactly where entry.node points.
  cpSync(BODY_SRC, join(pkgDir, 'service.mjs'));

  let manifestPath: string | undefined;
  if (trusted) {
    manifestPath = join(root, 'first-party.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schema: 'kungfu.first-party-manifest/v1',
        version: 1,
        keys: { [KEY]: { sha256: null } },
      }),
    );
  }

  const env: Record<string, string | undefined> = {
    KUNGFU_KFX_CONTRACT: process.env.KUNGFU_KFX_CONTRACT,
    KF_EXTENSION_PATH: root,
    KF_FIRST_PARTY_MANIFEST: manifestPath,
  };
  const deps: KfxPlanDeps = {
    fs: fs as unknown as KfxPlanDeps['fs'],
    path,
    crypto: crypto as unknown as KfxPlanDeps['crypto'],
  };
  const plan = planKfx(env, deps);
  return {
    plan,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

type Outcome = { tier: string; report: Record<string, unknown> | null };

async function landDogfood(
  trusted: boolean,
  authz: ServiceAuthz,
): Promise<Outcome> {
  const { plan, cleanup } = discoverDogfood(trusted);
  try {
    const entry = plan.services.find((s) => s.id === KEY);
    if (!entry) throw new Error('planKfx did not discover the dogfood service');
    const { caps, readReport } = buildCaps();
    // the sandboxed child inherits NODE_OPTIONS (tsx loader) from this process,
    // set once in main() — it loads the capability SDK .ts source.
    const service = await launchDiscoveredService(entry, { caps, authz });
    const code = await service.done;
    if (service.tier === 'sandbox' && code !== 0) {
      throw new Error(`sandboxed service exited ${code}`);
    }
    return { tier: service.tier, report: readReport() };
  } finally {
    cleanup();
  }
}

// The C++ lane: lay down a service kfx whose body is a PREBUILT cpp binary (not
// source), discover it with planKfx, and land it. `binary` is compiled once by
// main and copied into the package where entry.cpp points — the shape a real
// C++ service ships (KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be). Only the untrusted (OS-sandbox) tier is landed;
// trusted co-resident cpp is the tier x runtime host-wiring follow-up.
function discoverDogfoodCpp(binary: string): {
  plan: KfxLoadPlan;
  cleanup: () => void;
} {
  const platformKey = CPP_PLATFORM_KEY[process.platform];
  if (!platformKey) {
    throw new Error(`no cpp entry key for platform '${process.platform}'`);
  }
  const root = mkdtempSync(join(tmpdir(), 'kfx-dogfood-cpp-'));
  const pkgDir = join(root, 'openclaw-cpp');
  mkdirSync(pkgDir, { recursive: true });
  // the prebuilt binary ships in the package, exactly where entry.cpp points;
  // cpSync preserves its executable mode.
  cpSync(binary, join(pkgDir, 'service-bin'));
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: '@dogfood/openclaw-cpp',
      version: '1.0.0',
      kungfuConfig: {
        key: KEY_CPP,
        config: {
          service: {
            runtimes: ['cpp'],
            entry: { cpp: { [platformKey]: 'service-bin' } },
            capabilities: ['ledger', 'report'],
          },
        },
      },
    }),
  );
  const env: Record<string, string | undefined> = {
    KUNGFU_KFX_CONTRACT: process.env.KUNGFU_KFX_CONTRACT,
    KF_EXTENSION_PATH: root,
  };
  const deps: KfxPlanDeps = {
    fs: fs as unknown as KfxPlanDeps['fs'],
    path,
    crypto: crypto as unknown as KfxPlanDeps['crypto'],
  };
  const plan = planKfx(env, deps);
  return {
    plan,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function landDogfoodCpp(
  binary: string,
  authz: ServiceAuthz,
): Promise<Outcome> {
  const { plan, cleanup } = discoverDogfoodCpp(binary);
  try {
    const entry = plan.services.find((s) => s.id === KEY_CPP);
    if (!entry) throw new Error('planKfx did not discover the cpp dogfood');
    const { caps, readReport } = buildCaps();
    // the cpp child is a native binary, not node — no tsx loader needed.
    const service = await launchDiscoveredService(entry, { caps, authz });
    const code = await service.done;
    if (service.tier === 'sandbox' && code !== 0) {
      throw new Error(`sandboxed cpp service exited ${code}`);
    }
    return { tier: service.tier, report: readReport() };
  } finally {
    cleanup();
  }
}

async function main(): Promise<void> {
  console.log(
    'kfx service dogfood — discover → plan → authorize → land → relay\n',
  );
  // the sandboxed child is plain `node`; give it tsx's loader so it can load the
  // capability SDK source (.ts, incl. enums) service-bootstrap imports. Children
  // inherit this from the harness process; a packaged app ships built JS.
  process.env.NODE_OPTIONS = '--import tsx';

  // untrusted + no grant: default-deny sandbox.
  const a = await landDogfood(false, {});
  ok('untrusted lands in the sandbox tier', a.tier === 'sandbox');
  ok('no grant → relay flows', a.report?.relayRecordCount === 3);
  ok('no grant → external egress refused', a.report?.reachedNetwork === false);

  // untrusted + network grant: sandbox with egress opened by the grant.
  const b = await landDogfood(false, { perKfx: { [KEY]: { network: true } } });
  ok('granted service stays in the sandbox tier', b.tier === 'sandbox');
  ok('network grant → relay flows', b.report?.relayRecordCount === 3);
  ok(
    'network grant → external egress allowed',
    b.report?.reachedNetwork === true,
  );

  // trusted (first-party): co-resident, unconfined, grants irrelevant.
  const c = await landDogfood(true, {});
  ok('trusted lands co-resident', c.tier === 'co-resident');
  ok('co-resident → relay flows', c.report?.relayRecordCount === 3);
  ok(
    'co-resident → egress allowed (unconfined)',
    c.report?.reachedNetwork === true,
  );

  // C++ lane: a prebuilt cpp binary discovered by planKfx (entry.cpp map) and
  // landed through the same untrusted OS-sandbox path as node. Compile once;
  // skip cleanly where no toolchain is present (a build we cannot do is not a
  // failed proof).
  console.log('');
  const cppWork = mkdtempSync(join(tmpdir(), 'kfx-cpp-build-'));
  const cppBinary = join(cppWork, 'dogfood-service');
  try {
    if (!buildCppDogfood(cppBinary)) {
      console.log('  skip  cpp lane (no C++ toolchain or conan)');
    } else {
      // untrusted + no grant: default-deny sandbox.
      const d = await landDogfoodCpp(cppBinary, {});
      ok('cpp untrusted lands in the sandbox tier', d.tier === 'sandbox');
      ok('cpp no grant → relay flows', d.report?.relayRecordCount === 3);
      ok(
        'cpp no grant → external egress refused',
        d.report?.reachedNetwork === false,
      );

      // untrusted + network grant: sandbox with egress opened by the grant.
      const e = await landDogfoodCpp(cppBinary, {
        perKfx: { [KEY_CPP]: { network: true } },
      });
      ok('cpp granted service stays in the sandbox tier', e.tier === 'sandbox');
      ok('cpp network grant → relay flows', e.report?.relayRecordCount === 3);
      ok(
        'cpp network grant → external egress allowed',
        e.report?.reachedNetwork === true,
      );
    }
  } finally {
    rmSync(cppWork, { recursive: true, force: true });
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
