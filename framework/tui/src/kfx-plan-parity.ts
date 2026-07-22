// Dual-entry loading parity (ADR-0017 stage 3, acceptance #1): the TUI host must
// reach the SAME trust/tier verdict for the same kfx as the gui — because both
// import the one host-agnostic planKfx and neither reimplements the rule. This
// lays down a fixture extension root, runs the TUI's loadTuiKfxPlan over it, and
// checks each verdict is the shared rule's:
//   trusted (first-party) view    → node-integrated   (gui: mounts in renderer)
//   untrusted view                → sandboxed-ipc      (gui: isolated renderer)
//   trusted / untrusted service   → trusted flag       (stage 2d landing)
// It also asserts loadTuiKfxPlan is planKfx unmodified — the TUI adds no
// divergence — so "same verdict as the gui" holds by construction, not by luck.
//
// Run with tsx: pnpm --filter @kungfu-tech/tui exec tsx src/kfx-plan-parity.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { type KfxPlanDeps, planKfx } from '@kungfu-tech/kfx';

import { loadTuiKfxPlan } from './kfx-plan.js';

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

function pkg(root: string, dir: string, kungfuConfig: unknown): void {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, 'package.json'),
    JSON.stringify({ name: `@fixture/${dir}`, version: '1.0.0', kungfuConfig }),
  );
}

const root = mkdtempSync(join(tmpdir(), 'kfx-tui-parity-'));
pkg(root, 'trusted-view', {
  key: 'fixture.view.trusted',
  config: { view: { title: 'Trusted View' } },
});
pkg(root, 'untrusted-view', {
  key: 'fixture.view.untrusted',
  config: { view: { title: 'Untrusted View' } },
});
pkg(root, 'trusted-svc', {
  key: 'fixture.svc.trusted',
  config: { service: { runtimes: ['node'], entry: { node: 'svc.mjs' } } },
});
pkg(root, 'untrusted-svc', {
  key: 'fixture.svc.untrusted',
  config: { service: { runtimes: ['node'], entry: { node: 'svc.mjs' } } },
});
pkg(root, 'invalid-view', {
  key: 'fixture.invalid',
  config: { view: { title: 'Invalid', capabilities: 'ledger' } },
});

const manifest = join(root, 'first-party.json');
writeFileSync(
  manifest,
  JSON.stringify({
    schema: 'kungfu.first-party-manifest/v1',
    version: 1,
    keys: {
      'fixture.view.trusted': { sha256: null },
      'fixture.svc.trusted': { sha256: null },
    },
  }),
);

const env: Record<string, string | undefined> = {
  KUNGFU_KFX_CONTRACT: process.env.KUNGFU_KFX_CONTRACT,
  KF_EXTENSION_PATH: root,
  KF_FIRST_PARTY_MANIFEST: manifest,
};

console.log('kfx dual-entry loading parity (stage 3)\n');

const kfxRoot = nodePath.resolve(import.meta.dirname, '../../kfx');
const contract = JSON.parse(
  nodeFs.readFileSync(join(kfxRoot, 'kungfu-kfx.contract.json'), 'utf8'),
);
const standaloneFirstPartySchema = JSON.parse(
  nodeFs.readFileSync(
    join(kfxRoot, 'schema', 'first-party-manifest.schema.json'),
    'utf8',
  ),
);
ok(
  'standalone first-party schema matches the contract authority',
  JSON.stringify(standaloneFirstPartySchema) ===
    JSON.stringify(contract.firstPartyManifestSchema),
);

// the TUI's verdict, through loadTuiKfxPlan.
const plan = loadTuiKfxPlan(env);
const view = (id: string) => plan.entries.find((e) => e.id === id);
const svc = (id: string) => plan.services.find((s) => s.id === id);

ok(
  'TUI discovers both views',
  !!view('fixture.view.trusted') && !!view('fixture.view.untrusted'),
);
ok(
  'trusted view → node-integrated (gui mounts in renderer)',
  view('fixture.view.trusted')?.tier === 'node-integrated',
);
ok(
  'untrusted view → sandboxed-ipc (gui isolated renderer)',
  view('fixture.view.untrusted')?.tier === 'sandboxed-ipc',
);
ok('trusted service → trusted', svc('fixture.svc.trusted')?.trusted === true);
ok(
  'untrusted service → untrusted',
  svc('fixture.svc.untrusted')?.trusted === false,
);

// loadTuiKfxPlan is planKfx unmodified: the same env + equivalent node deps give
// an identical plan, so the TUI's verdict IS the shared rule's — the same one the
// gui reaches through its own planKfx call.
const deps: KfxPlanDeps = {
  fs: nodeFs as unknown as KfxPlanDeps['fs'],
  path: nodePath,
  crypto: nodeCrypto as unknown as KfxPlanDeps['crypto'],
};
const direct = planKfx(env, deps);
const tierMap = (p: typeof plan) =>
  JSON.stringify({
    views: p.entries.map((e) => [e.id, e.tier]).sort(),
    services: p.services.map((s) => [s.id, s.trusted]).sort(),
  });
ok(
  'loadTuiKfxPlan == planKfx (no host divergence; verdict is the shared rule)',
  tierMap(plan) === tierMap(direct),
);
ok(
  'invalid kfx manifest rejected by contract schema',
  plan.failures.some(
    (failure) =>
      failure.dir.endsWith('invalid-view') &&
      failure.error.includes('KFX package manifest validation failed'),
  ),
);
writeFileSync(
  manifest,
  JSON.stringify({
    version: 1,
    keys: {
      'fixture.view.trusted': { sha256: null },
      'fixture.svc.trusted': { sha256: null },
    },
  }),
);
const legacy = planKfx(env, deps);
ok(
  'schema-less pre-freeze v1 remains readable',
  legacy.entries.find((entry) => entry.id === 'fixture.view.trusted')?.tier ===
    'node-integrated',
);

rmSync(root, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
