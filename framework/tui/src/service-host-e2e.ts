// End-to-end dogfood (ADR-0017 stage 2d): a REAL service kfx, discovered by
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
      JSON.stringify({ version: 1, keys: { [KEY]: { sha256: null } } }),
    );
  }

  const env: Record<string, string | undefined> = {
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

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
