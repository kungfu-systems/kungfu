// Legacy discovery parity: GUI and TUI see the same inert presentation
// metadata, while neither can derive execution authority from identity or path.
//
// Run with tsx: pnpm --filter @kungfu-tech/tui exec tsx src/kfx-plan-parity.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import nodeCrypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import {
  KFX_MANIFEST_FILE,
  KFX_MANIFEST_SCHEMA,
  type KfxPlanDeps,
  planKfx,
} from '@kungfu-tech/kfx';

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
    join(d, KFX_MANIFEST_FILE),
    JSON.stringify({
      schema: KFX_MANIFEST_SCHEMA,
      name: `@fixture/${dir}`,
      version: '1.0.0',
      kungfuConfig,
    }),
  );
}

const root = mkdtempSync(join(tmpdir(), 'kfx-tui-parity-'));
pkg(root, 'bundled-view', {
  key: 'fixture.view.bundled',
  config: { view: { title: 'Bundled View', capabilities: [] } },
});
pkg(root, 'external-view', {
  key: 'fixture.view.external',
  config: { view: { title: 'External View', capabilities: [] } },
});
pkg(root, 'bundled-svc', {
  key: 'fixture.svc.bundled',
  config: {
    service: {
      runtimes: ['node'],
      entry: { node: 'svc.mjs' },
      capabilities: [],
    },
  },
});
pkg(root, 'external-svc', {
  key: 'fixture.svc.external',
  config: {
    service: {
      runtimes: ['node'],
      entry: { node: 'svc.mjs' },
      capabilities: [],
    },
  },
});
pkg(root, 'invalid-view', {
  key: 'fixture.invalid',
  config: { view: { title: 'Invalid', capabilities: 'ledger' } },
});

const env: Record<string, string | undefined> = {
  KUNGFU_KFX_CONTRACT: process.env.KUNGFU_KFX_CONTRACT,
  KF_EXTENSION_PATH: root,
};

console.log('kfx identity-neutral discovery parity\n');

// the TUI's verdict, through loadTuiKfxPlan.
const plan = loadTuiKfxPlan(env);
const view = (id: string) => plan.entries.find((e) => e.id === id);
const svc = (id: string) => plan.services.find((s) => s.id === id);

ok(
  'TUI discovers both views',
  !!view('fixture.view.bundled') && !!view('fixture.view.external'),
);
ok(
  'bundled view remains isolated without Core authorization',
  view('fixture.view.bundled')?.tier === 'sandboxed-ipc',
);
ok(
  'external view remains isolated without Core authorization',
  view('fixture.view.external')?.tier === 'sandboxed-ipc',
);
ok(
  'bundled and external services have equal zero ambient authority',
  svc('fixture.svc.bundled')?.executionAllowed === false &&
    svc('fixture.svc.external')?.executionAllowed === false,
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
    services: p.services.map((s) => [s.id, s.executionAllowed]).sort(),
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
rmSync(root, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
