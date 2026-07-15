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
  type KfxContract,
  type KfxPlanDeps,
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

test('KFX plan projects the declared Mission Control GUI experience', () => {
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
    (candidate) => candidate.id === 'kungfu.mission-control',
  );
  assert.deepEqual(profile, {
    id: 'kungfu.mission-control',
    title: 'Mission Control',
    kfx: [
      'mission-control-actions',
      'mission-control-assessment',
      'mission-control-contract',
      'mission-control-views',
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

test('KFX package contract rejects unknown or duplicate product roles', () => {
  const manifest = {
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

test('product roles cannot elevate an untrusted runtime tier', () => {
  assert.equal(
    resolveRuntimeTier({ runtime: 'node-integrated', system: false }, false),
    'sandboxed-ipc',
  );
});

test('Node resolves exact Suite member package roots without lifecycle authority', () => {
  const source = mkdtempSync(path.join(os.tmpdir(), 'kungfu-profile-source-'));
  try {
    const members = ['week-contract', 'week-actions'];
    mkdirSync(path.join(source, 'members'), { recursive: true });
    writeFileSync(
      path.join(source, 'package.json'),
      JSON.stringify({
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
        path.join(directory, 'package.json'),
        JSON.stringify({
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
    rmSync(source, { recursive: true, force: true });
  }
});
