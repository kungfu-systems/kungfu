#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { devMergeBaseCandidates } from './candidate-timeline-events.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

function run(label, command, args, env = process.env) {
  process.stdout.write(`[native-admission] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: isWin,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || `git ${args.join(' ')} exited with failure`,
    );
  }
  return result.stdout.trim();
}

function checkIdentityNeutralAuthority() {
  const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
  const json = (relative) => JSON.parse(read(relative));
  const sourceContract = json('config/kungfu-kfx.contract.json');
  const packageContract = json('framework/kfx/kungfu-kfx.contract.json');
  assert.deepEqual(
    packageContract,
    sourceContract,
    'KFX package contract diverged from the canonical config contract',
  );

  const native = sourceContract.nativeRuntime;
  assert.equal(native.contractVersion, 3);
  assert.deepEqual(native.versionNegotiation.supported, [3]);
  assert.equal(native.coreCapabilityPolicy.identityAuthority, false);
  assert.equal(native.coreCapabilityPolicy.originAuthority, false);
  assert.equal(native.coreCapabilityPolicy.productAssemblyAuthority, false);
  assert.equal(native.coreCapabilityPolicy.kfdAuthority, 'eligibility-only');
  assert.deepEqual(native.runtimeTiers, [
    'isolated',
    'integrated-explicit',
    'metadata-only',
  ]);
  assert.deepEqual(native.admissionGrades, [
    'unverified',
    'identity-verified',
    'kfd-attested',
  ]);

  const forbiddenSourcePattern =
    /firstParty|first_party|KF_FIRST_PARTY|isFirstParty|productSystem|product-system|system-role|systemAuthority|systemCapabilities|productSystemRoots/u;
  const authorityEdges = [
    'framework/kfx/src/index.ts',
    'framework/api/src/capability/kfx-host.ts',
    'framework/api/src/capability/service-authz.ts',
    'framework/gui/src/main/index.ts',
    'framework/gui/src/navigation.ts',
    'framework/gui/src/main/session-window-authorization.ts',
    'framework/gui/src/main/session-windows-host.ts',
    'framework/gui/src/renderer/src/kfx-loader.ts',
    'framework/gui/src/renderer/session-window/main.tsx',
    'framework/tui/src/kfx-host.ts',
    'framework/tui/src/kfx-plan-parity.ts',
    'framework/tui/src/service-host.ts',
    'framework/core/src/python/kungfu/cli/commands/kfx.py',
    'framework/core/src/python/kungfu/host.py',
    'framework/core/src/python/kungfu/rewind/adapters.py',
  ];
  for (const relative of authorityEdges) {
    assert.doesNotMatch(
      read(relative),
      forbiddenSourcePattern,
      `${relative} contains an identity- or origin-derived authority shortcut`,
    );
  }

  for (const removed of [
    'framework/kfx/schema/first-party-manifest.schema.json',
    'framework/gui/scripts/gen-first-party-manifest.mjs',
    'framework/gui/src/main/first-party-manifest.ts',
  ]) {
    assert.equal(
      fs.existsSync(path.join(root, removed)),
      false,
      `${removed} resurrected a parallel identity authority`,
    );
  }
  assert.match(
    read('framework/core/src/python/kungfu/rewind/first_party.py'),
    /raise ImportError\(/u,
    'retired first-party compatibility module must fail closed on import',
  );

  const forbiddenManifestKeys = new Set([
    'firstParty',
    'productSystem',
    'systemAuthority',
    'trusted',
    'supportsKFD',
    'system',
    'runtimeTier',
  ]);
  const inspectManifestObject = (value, relative) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(
        forbiddenManifestKeys.has(key),
        false,
        `${relative} self-declares forbidden authority key ${key}`,
      );
      inspectManifestObject(child, relative);
    }
  };

  const extensionRoot = path.join(root, 'extensions');
  const manifests = [];
  for (const suiteOrPackage of fs.readdirSync(extensionRoot)) {
    const first = path.join(extensionRoot, suiteOrPackage);
    const candidates = [first];
    if (fs.statSync(first).isDirectory()) {
      for (const child of fs.readdirSync(first))
        candidates.push(path.join(first, child));
    }
    for (const candidate of candidates) {
      const manifestPath = path.join(candidate, 'kungfu.kfx.json');
      if (fs.existsSync(manifestPath)) manifests.push(manifestPath);
      const transportPath = path.join(candidate, 'package.json');
      if (fs.existsSync(transportPath)) {
        const transport = JSON.parse(fs.readFileSync(transportPath, 'utf8'));
        assert.equal(
          Object.hasOwn(transport, 'kungfuConfig'),
          false,
          `${path.relative(root, transportPath)} claims KFX semantic authority`,
        );
      }
    }
  }

  assert.ok(manifests.length > 0, 'no product KFX manifests were inspected');
  for (const manifestPath of manifests) {
    const relative = path.relative(root, manifestPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    inspectManifestObject(manifest, relative);
    const facets = manifest.kungfuConfig?.config ?? {};
    for (const [facet, declaration] of Object.entries(facets)) {
      if (!['view', 'adapter', 'service', 'wasm'].includes(facet)) continue;
      assert.ok(
        Array.isArray(declaration.capabilities),
        `${relative} ${facet} must explicitly declare its least capability set`,
      );
    }
  }

  process.stdout.write(
    `[kfx-identity-neutral-authority] contract=v${native.contractVersion} manifests=${manifests.length} authorityEdges=${authorityEdges.length}\n`,
  );
}

function checkAgentWorkLabIsolation() {
  const baseline =
    process.env.KUNGFU_NATIVE_KFX_BASE_REF ??
    git(['merge-base', 'HEAD', devMergeBaseCandidates()[0]]);
  const agentWorkLabMerge = '1f7cfe58cc7699ac27106241430d77f6938eadcd';
  const protectedBranch = 'feature/agent-work-lab-kfx-suite';
  const protectedPaths = [
    'framework/core/src/python/kungfu/agent_work_lab.py',
    'framework/core/src/python/kungfu/cli/commands/agent_work_lab.py',
    'framework/api/src/capability/agent-work-lab.ts',
    'framework/gui/src/renderer/src/agent-work-lab.tsx',
    'framework/tui/src/agent-work-lab-view.tsx',
    'framework/tui/src/main.tsx',
  ];
  const branch = git(['branch', '--show-current']);
  if (branch === protectedBranch) {
    throw new Error(`refusing protected Qualification Lab branch ${branch}`);
  }
  git(['merge-base', '--is-ancestor', agentWorkLabMerge, 'HEAD']);
  const changed = new Set(
    git(['diff', '--name-only', baseline, '--']).split('\n').filter(Boolean),
  );
  const violations = protectedPaths.filter((item) => changed.has(item));
  if (violations.length > 0) {
    throw new Error(
      `protected Qualification Lab paths changed:\n${violations.join('\n')}`,
    );
  }
  process.stdout.write(
    `[native-kfx-isolation] PASS branch=${branch} baseline=${baseline} protected_changes=0 pr=1585 merge=${agentWorkLabMerge}\n`,
  );
}

checkIdentityNeutralAuthority();
if (process.argv.includes('--identity-neutral-only')) process.exit(0);

run('Core ABI, contract, and admission fixtures', 'ctest', [
  '--test-dir',
  path.join(root, 'framework/core/build'),
  '--build-config',
  'Release',
  '--output-on-failure',
  '--tests-regex',
  '^(kungfu_api_contract_tests|kungfu_native_kfx_contract_tests)$',
]);

const pythonPath = [
  path.join(root, 'framework/core/build/Release'),
  path.join(root, 'framework/core/src/python'),
  process.env.PYTHONPATH,
]
  .filter(Boolean)
  .join(path.delimiter);

run(
  'Python binding and ActionEnvelope qualification',
  'uv',
  [
    'run',
    '--project',
    path.join(root, 'framework/core'),
    '--frozen',
    'pytest',
    path.join(root, 'framework/core/tests/python/test_native_kfx_contract.py'),
    path.join(root, 'framework/core/tests/python/test_action_envelope.py'),
  ],
  {
    ...process.env,
    KUNGFU_ALLOW_FOREIGN_RUNTIME: '1',
    PYTHONPATH: pythonPath,
  },
);

run('public API transport projection', 'pnpm', [
  '--filter',
  '@kungfu-tech/tui',
  'exec',
  'tsx',
  '--test',
  path.join(root, 'framework/api/tests/storage.test.ts'),
  path.join(root, 'framework/api/tests/kfx-host.test.ts'),
]);

run(
  'native Node binding root parity',
  'node',
  [
    '--test',
    path.join(
      root,
      'framework/core/tests/native-kfx-registry-node-binding.test.js',
    ),
  ],
  {
    ...process.env,
    KUNGFU_DIR: path.join(root, 'framework/core/build/Release'),
    KUNGFU_REQUIRE_NATIVE: '1',
  },
);

run('public API type contract', 'pnpm', [
  '--filter',
  '@kungfu-tech/api',
  'run',
  'build',
]);

run('KFX type contract', 'pnpm', [
  '--filter',
  '@kungfu-tech/kfx',
  'run',
  'build',
]);

run('schema authority gate', 'node', [
  path.join(root, 'scripts/check-schema-authority.mjs'),
]);

run('incubation passport gate', 'node', [
  path.join(root, 'scripts/check-incubation-passport.mjs'),
]);

run('incubation passport contract tests', 'node', [
  '--test',
  path.join(root, 'scripts/check-incubation-passport.test.mjs'),
]);

run('layered API encoding authority', 'node', [
  '--test',
  path.join(root, 'scripts/check-layered-api-encoding-boundary.test.mjs'),
]);

process.stdout.write(
  '[native-admission] Qualification Lab and PR #1585 isolation\n',
);
checkAgentWorkLabIsolation();
