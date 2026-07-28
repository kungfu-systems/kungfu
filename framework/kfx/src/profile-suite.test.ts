// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  KFX_MANIFEST_FILE,
  KFX_MANIFEST_SCHEMA,
  type KfxContract,
  type KfxLoadPlan,
  type KfxPlanDeps,
  type NativeKfxPlanProjection,
  compareKfxShadowPlans,
  planKfx,
  resolveKfxProfileSuiteSource,
  resolveRuntimeTier,
  validateKfxPackageManifest,
  validateKfxProfileSuite,
} from './index';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const fixtureRoot = path.join(
  root,
  'tests',
  'fixtures',
  'kfx-profile-suite-contract',
);
const contract = JSON.parse(
  readFileSync(
    path.join(root, 'framework/kfx/kungfu-kfx.contract.json'),
    'utf8',
  ),
) as KfxContract;
const validProfile = JSON.parse(
  readFileSync(path.join(fixtureRoot, 'week-day.profile.json'), 'utf8'),
) as Record<string, unknown>;
const invalidCases = JSON.parse(
  readFileSync(path.join(fixtureRoot, 'invalid-cases.json'), 'utf8'),
) as Array<{
  id: string;
  operation: 'set' | 'remove';
  path: string[];
  value?: unknown;
}>;
const parityCases = JSON.parse(
  readFileSync(
    path.join(root, 'tests/fixtures/native-kfx-registry-parity/cases.json'),
    'utf8',
  ),
) as Array<{
  name: string;
  legacy: KfxLoadPlan;
  native: NativeKfxPlanProjection;
  expected: 'intended-match' | 'legacy-defect' | 'adr-required-divergence';
}>;

const planDeps: KfxPlanDeps = {
  fs: {
    existsSync,
    readFileSync: (file, encoding) =>
      readFileSync(file, encoding as BufferEncoding),
    readdirSync: (directory, options) => readdirSync(directory, options),
  },
  path,
  crypto: {
    createHash: (algorithm) => ({
      update: (data) => ({
        digest: (encoding) =>
          crypto
            .createHash(algorithm)
            .update(data)
            .digest(encoding as crypto.BinaryToTextEncoding),
      }),
    }),
  },
};

function applyCase(
  profile: Record<string, unknown>,
  fixture: (typeof invalidCases)[number],
): void {
  let target = profile;
  for (const segment of fixture.path.slice(0, -1)) {
    target = target[segment] as Record<string, unknown>;
  }
  const leaf = fixture.path.at(-1) as string;
  if (fixture.operation === 'remove') delete target[leaf];
  else target[leaf] = fixture.value;
}

test('Node validates the complete Week/Day Profile Suite closure', () => {
  validateKfxProfileSuite(validProfile, contract, [
    'week-day-contract',
    'week-day-actions',
    'week-day-assessment',
    'week-day-dashboard',
  ]);
});

test('Node keeps a Profile without a KFD-3 facet valid but not KFD-3 declared', () => {
  const profile = structuredClone(validProfile);
  assert.equal(Reflect.deleteProperty(profile, 'kfd3'), true);
  validateKfxProfileSuite(profile, contract, [
    'week-day-contract',
    'week-day-actions',
    'week-day-assessment',
    'week-day-dashboard',
  ]);
  assert.equal(profile.kfd3, undefined);
});

for (const fixture of invalidCases) {
  test(`Node rejects Profile Suite fixture: ${fixture.id}`, () => {
    const profile = structuredClone(validProfile);
    applyCase(profile, fixture);
    assert.throws(() => validateKfxProfileSuite(profile, contract));
  });
}

test('Node rejects Profile Suite package-member drift', () => {
  assert.throws(
    () =>
      validateKfxProfileSuite(validProfile, contract, [
        'week-day-contract',
        'week-day-actions',
      ]),
    /must match kungfuConfig\.suite\.members/,
  );
});

test('Node rejects a GUI Home outside the Profile Suite members', () => {
  const profile = structuredClone(validProfile);
  profile.experience = { homeView: 'unrelated-dashboard' };
  assert.throws(
    () => validateKfxProfileSuite(profile, contract),
    /experience\.homeView must be a profile member/,
  );
});

test('KFX plan projects the declared Work Control GUI experience', () => {
  const plan = planKfx(
    {
      KUNGFU_KFX_CONTRACT: path.join(
        root,
        'framework/kfx/kungfu-kfx.contract.json',
      ),
      KF_EXTENSION_PATH: path.join(root, 'extensions'),
    },
    planDeps,
  );
  const profile = plan.profiles.find(
    (candidate) => candidate.id === 'kungfu.work-control',
  );
  assert.deepEqual(profile, {
    id: 'kungfu.work-control',
    title: 'Work Control',
    kfx: [
      'work-control-actions',
      'work-control-assessment',
      'work-control-contract',
      'work-control-views',
      'work-dashboard',
    ],
    defaultView: 'work-dashboard',
  });
  assert.deepEqual(
    plan.entries.find((entry) => entry.id === 'work-dashboard')?.product,
    { roles: ['profile-view'], icon: '🧭', order: 10 },
  );
  assert.deepEqual(
    plan.entries.find((entry) => entry.id === 'terminal')?.product,
    { roles: ['agent-console'], icon: '💬', order: 20 },
  );
});

test('KFX plan discovers the stable Agent Work Lab Suite membership', () => {
  const plan = planKfx(
    {
      KUNGFU_KFX_CONTRACT: path.join(
        root,
        'framework/kfx/kungfu-kfx.contract.json',
      ),
      KF_EXTENSION_PATH: path.join(root, 'extensions'),
    },
    planDeps,
  );
  assert.deepEqual(plan.suites['kungfu.agent-work-lab'], {
    title: 'Agent Work Lab',
    members: [
      'agent-work-lab-catalog',
      'agent-work-lab-gui',
      'agent-work-lab-tui',
    ],
  });
  assert.equal(
    plan.failures.some((failure) =>
      failure.dir.includes(path.join('extensions', 'agent-work-lab')),
    ),
    false,
  );
});

test('KFX package contract rejects unknown or duplicate product roles', () => {
  const manifest = {
    schema: KFX_MANIFEST_SCHEMA,
    name: '@example/view',
    version: '1.0.0',
    kungfuConfig: {
      key: 'example-view',
      product: { roles: ['unknown-role'] },
      config: { view: { title: 'Example', capabilities: [] } },
    },
  };
  assert.throws(() => validateKfxPackageManifest(manifest, contract));
  manifest.kungfuConfig.product.roles = ['tool', 'tool'];
  assert.throws(() => validateKfxPackageManifest(manifest, contract));
  manifest.kungfuConfig.product.roles = ['tool'];
  validateKfxPackageManifest(manifest, contract);
});

test('Node rejects legacy-only and dual KFX manifest authority', () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'kungfu-kfx-authority-'));
  const legacy = path.join(parent, 'legacy-only');
  const dual = path.join(parent, 'dual');
  const legacyClaim = {
    name: '@example/legacy',
    version: '1.0.0',
    kungfuConfig: { key: 'legacy' },
  };
  try {
    mkdirSync(legacy);
    writeFileSync(
      path.join(legacy, 'package.json'),
      JSON.stringify(legacyClaim),
    );
    mkdirSync(dual);
    writeFileSync(path.join(dual, 'package.json'), JSON.stringify(legacyClaim));
    writeFileSync(
      path.join(dual, KFX_MANIFEST_FILE),
      JSON.stringify({
        schema: KFX_MANIFEST_SCHEMA,
        name: '@example/dual',
        version: '1.0.0',
        kungfuConfig: { key: 'dual' },
      }),
    );

    const plan = planKfx(
      {
        KUNGFU_KFX_CONTRACT: path.join(
          root,
          'framework/kfx/kungfu-kfx.contract.json',
        ),
        KF_EXTENSION_PATH: parent,
      },
      planDeps,
    );
    assert.deepEqual(
      plan.failures.map(({ error }) => error.split(':', 1)[0]).sort(),
      ['KF_KFX_MANIFEST_CONFLICT', 'KF_KFX_MANIFEST_MISSING'],
    );
    assert.deepEqual(plan.entries, []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('product roles cannot elevate an untrusted runtime tier', () => {
  assert.equal(
    resolveRuntimeTier({ runtime: 'node-integrated', system: false }, false),
    'sandboxed-ipc',
  );
});

test('Node resolves exact Suite member package roots without lifecycle authority', () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'kungfu-profile-source-'));
  const source = path.join(parent, 'suite');
  try {
    const members = ['week-contract', 'week-actions'];
    mkdirSync(source);
    mkdirSync(path.join(source, 'members'), { recursive: true });
    writeFileSync(
      path.join(source, KFX_MANIFEST_FILE),
      JSON.stringify({
        schema: KFX_MANIFEST_SCHEMA,
        name: '@example/week',
        version: '1.0.0',
        kungfuConfig: {
          key: 'example.week',
          suite: { title: 'Week', members, profile: 'profile.json' },
        },
      }),
    );
    const profile = structuredClone(validProfile) as Record<string, unknown>;
    (profile.members as Record<string, unknown>).required = members;
    (profile.members as Record<string, unknown>).optional = [];
    writeFileSync(path.join(source, 'profile.json'), JSON.stringify(profile));
    for (const member of members) {
      const directory = path.join(source, 'members', member);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, KFX_MANIFEST_FILE),
        JSON.stringify({
          schema: KFX_MANIFEST_SCHEMA,
          name: `@example/${member}`,
          version: '1.0.0',
          kungfuConfig: { key: member },
        }),
      );
    }
    const resolved = resolveKfxProfileSuiteSource(source, contract, {
      fs: { existsSync, readFileSync, readdirSync },
      path,
      crypto,
    });
    assert.deepEqual(Object.keys(resolved.memberRoots), [...members].sort());
    assert.ok(
      Object.values(resolved.memberRoots).every((value) =>
        value.startsWith('sha256:'),
      ),
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('shadow parity corpus classifies matches, legacy defects, and ADR divergences', () => {
  for (const fixture of parityCases) {
    const report = compareKfxShadowPlans(fixture.legacy, fixture.native);
    assert.equal(report.schema, 'kungfu.kfx.shadow-parity/v1', fixture.name);
    assert.equal(report.nativeRegistryRoot, fixture.native.registryRoot);
    assert.equal(report.nativePlanRoot, fixture.native.planRoot);
    assert.equal(report.findings.length, 1, fixture.name);
    assert.equal(
      report.findings[0]?.classification,
      fixture.expected,
      fixture.name,
    );
    assert.equal(report.counts[fixture.expected], 1, fixture.name);
  }
});
