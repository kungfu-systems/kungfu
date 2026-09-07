import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sdk = join(repoRoot, 'developer', 'sdk', 'src', 'sdk.js');
const require = createRequire(import.meta.url);
const {
  contractArtifacts,
} = require('@kungfu-tech/workspaces/tooling/contract-registry');
const kfdPackage = require('@kungfu-tech/kfd/package.json');
const buildchainPackagePath = require.resolve(
  '@kungfu-tech/buildchain/package.json',
);
const buildchainRequire = createRequire(buildchainPackagePath);
const buildchainPackage = require(buildchainPackagePath);
const buildchainAlphaPackagePath = require.resolve(
  '@kungfu-tech/buildchain-alpha/package.json',
);
const buildchainAlphaRequire = createRequire(buildchainAlphaPackagePath);
const buildchainAlphaPackage = buildchainAlphaRequire(
  '@kungfu-tech/buildchain-alpha/package.json',
);
const corePackage = require('@kungfu-tech/core/package.json');
const buildchainKfdVersion = buildchainPackage.dependencies['@kungfu-tech/kfd'];
const sdkKfd2ReleaseClaims = JSON.parse(
  readFileSync(
    join(repoRoot, 'developer', 'sdk', 'kfd', 'kfd-2', 'release-claims.json'),
    'utf8',
  ),
);
const sdkKfd2ClaimCount = sdkKfd2ReleaseClaims.claims.length;
const contractRegistry = JSON.parse(
  readFileSync(
    join(
      repoRoot,
      'framework',
      'spec',
      'contract',
      'kungfu-contracts.registry.json',
    ),
    'utf8',
  ),
);
const registeredSurfaces = contractRegistry.contracts.map(
  (contract) => contract.surface,
);
const registeredContractIds = contractRegistry.contracts.map(
  (contract) => contract.id,
);
const registeredKfdProjectionIds = contractRegistry.contracts.flatMap(
  (contract) =>
    (contract.extraArtifacts || [])
      .filter((artifact) => typeof artifact.kfdId === 'string')
      .map((artifact) => artifact.kfdId),
);

function runJson(args, cwd = repoRoot) {
  const result = spawnSync(process.execPath, [sdk, ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function runText(args, cwd = repoRoot, env = process.env) {
  const result = spawnSync(process.execPath, [sdk, ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('stable SDK dispatcher rejects an unknown command without an internal error', () => {
  const result = spawnSync(process.execPath, [sdk, 'definitely-unknown'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /kungfu sdk: unknown command: definitely-unknown/u,
  );
  assert.doesNotMatch(result.stderr, /ReferenceError/u);
});

function makeContractRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'kungfu-sdk-contract-'));
  const contractDir = join(root, 'framework', 'spec', 'contract');
  mkdirSync(contractDir, { recursive: true });
  writeFileSync(
    join(contractDir, 'kungfu-contracts.registry.json'),
    `${JSON.stringify(
      {
        schema: 'kungfu.contract-registry/v1',
        id: 'kungfu-contract-registry',
        version: 1,
        description: 'test registry',
        contracts: [],
      },
      null,
      2,
    )}\n`,
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('keeps stable and dev Buildchain KFD metadata on their declared lines', () => {
  const stableKfd = buildchainRequire('@kungfu-tech/kfd/package.json');
  const devKfd = buildchainAlphaRequire('@kungfu-tech/kfd/package.json');
  assert.equal(
    stableKfd.version,
    buildchainPackage.dependencies['@kungfu-tech/kfd'],
  );
  assert.equal(
    devKfd.version,
    buildchainAlphaPackage.dependencies['@kungfu-tech/kfd'],
  );
});

for (const [surface, source] of [
  ['config', 'framework/core/config/kungfu-config.contract.json'],
  ['kfx', 'framework/kfx/kungfu-kfx.contract.json'],
  ['skill', 'framework/skill/kungfu-skill.contract.json'],
  ['runtime', 'framework/core/runtime/kungfu-runtime.contract.json'],
  ['upgrade', 'product/upgrade/kungfu-upgrade.contract.json'],
]) {
  test(`adopts the registered ${surface} source contract file`, () => {
    const data = runJson([
      'contract',
      'adopt',
      surface,
      '--source',
      source,
      '--json',
    ]);
    assert.equal(data.schema, 'kungfu.sdk.contract-adopt/v1');
    assert.equal(data.ok, true);
    assert.equal(data.surface, surface);
    assert.equal(data.source, source);
    assert.match(data.contract.hash, /^sha256:[0-9a-f]{64}$/);
  });

  test(`renders the registered ${surface} contract as canonical JSON`, () => {
    const data = runJson(['contract', 'render', surface, '--check', '--json']);
    assert.equal(data.schema, 'kungfu.sdk.contract-render-check/v1');
    assert.equal(data.ok, true);
    assert.equal(data.surface, surface);
    assert.equal(data.source, source);
    assert.equal(data.mode, 'canonical-json');
    assert.equal(typeof data.byteForByte, 'boolean');
    assert.match(data.hash, /^sha256:[0-9a-f]{64}$/);
    assert.match(data.renderedHash, /^sha256:[0-9a-f]{64}$/);
  });
}

test('emits KFD-1 contract evidence for registered surfaces', () => {
  const data = runJson(['contract', 'evidence', '--json']);
  assert.equal(data.schema, 'kungfu.sdk.contract-evidence/v1');
  assert.equal(data.ok, true);
  assert.equal(data.releaseGate.kfd, 'KFD-1');
  assert.equal(data.releaseGate.key, 'kfd-1');
  assert.equal(data.releaseGate.metadata.package.version, buildchainKfdVersion);
  assert.equal(
    data.releaseGate.metadata.schemaIds.contractWorld,
    'https://kfd.libkungfu.dev/schemas/kfd-1/contract-world.schema.json',
  );
  assert.equal(data.releaseGate.role, 'local-evidence');
  assert.deepEqual(data.summary.surfaces, registeredSurfaces);
  assert.equal(data.summary.count, registeredSurfaces.length);
  assert.equal(data.contracts.length, registeredSurfaces.length);
  for (const contract of data.contracts) {
    assert.match(contract.contract.sourceHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(contract.contract.renderedHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(typeof contract.contract.byteForByte, 'boolean');
  }

  const skill = runJson(['contract', 'evidence', 'skill', '--json']);
  assert.deepEqual(skill.summary.surfaces, ['skill']);
  assert.equal(skill.contracts[0].surface, 'skill');
});

test('prints the agent-first canonical policy from upstream KFD and Buildchain metadata', () => {
  const data = runJson(['contract', 'policy', '--json']);
  assert.equal(data.schema, 'kungfu.agent-first-canonical-policy/v1');
  assert.equal(data.upstream.kfd.standard.key, 'kfd-1');
  assert.equal(data.upstream.kfd.package.version, buildchainKfdVersion);
  assert.equal(
    data.upstream.buildchain.package.version,
    buildchainPackage.version,
  );
  assert.equal(
    data.upstream.buildchain.formatting.name,
    'buildchain-release-evidence-json-v1',
  );
  assert.equal(data.upstream.buildchain.releaseGate.passportKey, 'kfd-1');
  assert.deepEqual(
    data.surfaces.map((surface) => surface.surface),
    registeredSurfaces,
  );
  for (const surface of data.surfaces) {
    assert.match(surface.source.sha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(surface.source.byteForByte, true);
    assert.equal(surface.artifact.expectedSha256, surface.source.sha256);
  }
});

test('emits a Buildchain KFD-1 contract-world witness for registered surfaces', () => {
  const data = runJson(['contract', 'witness', '--json']);
  assert.equal(data.contract, 'kungfu-buildchain-kfd-1-witness-set');
  assert.equal(data.standard, 'kfd-1');
  assert.equal(data.metadata.kfdPackage.version, buildchainKfdVersion);
  assert.equal(
    data.canonicalPolicy.path,
    'framework/spec/contract/kungfu-agent-first-canonical-policy.json',
  );
  assert.match(data.contractWorld.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(
    data.surfaces.map((surface) => surface.name),
    contractRegistry.contracts.flatMap((contract) => [
      contract.id,
      ...(contract.extraArtifacts || [])
        .filter((artifact) => typeof artifact.kfdId === 'string')
        .map((artifact) => artifact.kfdId),
    ]),
  );
  for (const id of registeredKfdProjectionIds) {
    const projection = data.surfaces.find((surface) => surface.name === id);
    assert.ok(projection, `missing KFD-1 projection ${id}`);
    assert.match(projection.sourceSha256, /^[0-9a-f]{64}$/);
    assert.equal(projection.expectedSha256, projection.sourceSha256);
    assert.equal(projection.byteForByte, true);
  }
});

test('audits the contract world as current and Buildchain-release-gate compatible', () => {
  const data = runJson(['contract', 'audit', '--json']);
  assert.equal(data.schema, 'kungfu.sdk.contract-audit/v1');
  assert.equal(data.ok, true);
  assert.equal(data.status, 'current');
  assert.equal(data.policy.status, 'current');
  assert.equal(
    data.releaseGate.contract,
    'kungfu-buildchain-kfd-1-release-gate',
  );
  assert.equal(data.releaseGate.status, 'passed');
  assert.equal(data.failures.length, 0);
  assert.deepEqual(
    data.contracts.map((contract) => contract.status),
    registeredSurfaces.map(() => 'current'),
  );
});

test('packages the agent-first canonical policy through the contract registry helper', () => {
  const artifacts = contractArtifacts();
  assert.ok(
    artifacts.some(
      (artifact) =>
        artifact.label === 'agent-first canonical policy' &&
        artifact.source ===
          'framework/spec/contract/kungfu-agent-first-canonical-policy.json' &&
        artifact.artifact === 'config/kungfu-agent-first-canonical-policy.json',
    ),
  );
});

test('product exposes dry-run commands for GUI and TUI products', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kungfu-sdk-product-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), '{"name":"product-demo"}\n');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'main.tsx'), 'export default null;\n');

  const gui = runText(['product', 'gui', 'dist', '--dir', root, '--dry-run']);
  assert.match(gui, /electron-vite/);
  assert.match(gui, /electron-builder/);
  assert.match(gui, /config\.electronDist/);

  const tui = runText(['product', 'tui', 'bundle', '--dir', root, '--dry-run']);
  assert.match(tui, /esbuild src\/main\.tsx/);
  assert.match(tui, /dist\/tui\.mjs/);
});

test('product gui dev dry-run supports a single kfx package directory', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kungfu-sdk-kfx-product-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'demo-kfx',
        version: '0.1.0',
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, 'kungfu.kfx.json'),
    `${JSON.stringify(
      {
        schema: 'kungfu.kfx.manifest/v1',
        name: 'demo-kfx',
        version: '0.1.0',
        kungfuConfig: {
          key: 'demo-kfx',
          name: 'Demo KFX',
          config: { view: { title: 'Demo KFX', capabilities: [] } },
        },
      },
      null,
      2,
    )}\n`,
  );

  const output = runText(['product', 'gui', 'dev', '--dir', root, '--dry-run']);
  assert.match(output, /sdk\.js kfx build/);
  assert.match(output, /KF_EXTENSION_PATH=/);
  assert.match(output, /KF_BUNDLED_EXTENSION_ROOT=/);
  assert.match(output, /run dev/);
});

test('installed SDK builds an optional custom KFX member without rebuilding Kungfu', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kungfu-sdk-profile-member-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src', 'node'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: '@example/custom-member',
        version: '1.0.0',
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(root, 'kungfu.kfx.json'),
    `${JSON.stringify(
      {
        schema: 'kungfu.kfx.manifest/v1',
        name: '@example/custom-member',
        version: '1.0.0',
        kungfuConfig: {
          key: 'example-custom-member',
          config: {
            adapter: {
              targets: ['example'],
              runtimes: ['node'],
              entry: { node: 'src/node/index.js' },
              capabilities: [],
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(root, 'src', 'node', 'index.js'), 'export default {};\n');

  const output = runText(['kfx', 'build'], root, {
    ...process.env,
    KUNGFU_KFX_CONTRACT: join(
      repoRoot,
      'framework',
      'kfx',
      'kungfu-kfx.contract.json',
    ),
  });

  assert.match(output, /ships source \(no bundle step\)/);
  assert.equal(existsSync(join(root, 'dist')), false);
});

test('product gui dist dry-run supports a product assembly directory', () => {
  const output = runText([
    'product',
    'gui',
    'dist',
    '--dir',
    join(repoRoot, 'product'),
    '--dry-run',
  ]);
  assert.match(output, /system[\\/]status/);
  assert.match(output, /assemble kfx ->/);
  assert.match(output, /framework[\\/]tui/);
  assert.match(output, /framework[\\/]gui/);
  assert.match(output, /run-electron-builder\.mjs/);
  assert.match(output, /electron-builder\.yml/);
});

test('product cli dist dry-run supports a product assembly directory', () => {
  const output = runText([
    'product',
    'cli',
    'dist',
    '--dir',
    join(repoRoot, 'product'),
    '--dry-run',
  ]);
  assert.match(output, /run dist:cli/);
});

test('kfd query exposes Kungfu KFD-3 capability facts', () => {
  const data = runJson(['kfd', 'query', '--json']);
  assert.equal(data.contract, 'kungfu-buildchain-kfd-3-capability-query');
  assert.equal(data.product, 'Kungfu');
  assert.ok(data.capabilities.length >= 1);
  assert.ok(data.capabilities.some((row) => row.id === 'kungfu.sdk.kfd.query'));
  assert.equal(data.kfd.kfd3, 'declared');
});

test('kfd check verifies the packaged KFD-3 registry projection', () => {
  const data = runJson(['kfd', 'check', '--json']);
  assert.equal(data.schema, 'kungfu.sdk.kfd-check/v1');
  assert.equal(data.ok, true);
  assert.match(data.registry.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.ok(data.registry.surfaceCount >= 1);
  assert.equal(
    data.registry.strict.registryPath,
    '.buildchain/kfd/kfd-3/surfaces.json',
  );
  assert.equal(
    data.registry.strict.sourceOfTruth,
    '.buildchain/kfd/kfd-3/surfaces.json',
  );
  assert.equal(data.registry.strict.mode, 'strict-buildchain-managed-registry');
  assert.equal(
    data.registry.strict.contract,
    'kungfu-buildchain-kfd-3-surface-registry',
  );
  assert.equal(data.upstreamAggregate.upstreamCount, 3);
  assert.equal(data.supportMatrix.rowCount, 13);
  assert.match(data.supportMatrix.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(data.query.kfd.kfd3, 'declared');
  assert.equal(data.query.kfd.kfd4, 'verified-candidate-not-shipped');
  assert.equal(data.standards['kfd-1'].status, 'source-supported');
  assert.equal(data.standards['kfd-2'].status, 'source-supported');
  assert.equal(data.standards['kfd-3'].status, 'source-supported');
  assert.equal(data.standards['kfd-4'].status, 'candidate');
  assert.equal(data.standards['kfd-6'].status, 'unsupported');
  assert.equal(data.standards['kfd-7'].status, 'source-supported');
  assert.equal(data.standards['kfd-13'].status, 'draft-adopter-evidence');
});

test('kfd status exposes the governed KFD-1 through KFD-13 support matrix', () => {
  const data = runJson(['kfd', 'status', '--json']);
  assert.equal(data.contract, 'kungfu-sdk-kfd-standards-status');
  assert.equal(data.packages.kfd, kfdPackage.version);
  assert.equal(data.packages.buildchain, buildchainPackage.version);
  assert.equal(data.matrix.rowCount, 13);
  assert.equal(data.matrix.shippedSupportCount, 4);
  assert.deepEqual(
    Object.keys(data.standards).sort((left, right) => {
      const leftNumber = Number(left.slice(4));
      const rightNumber = Number(right.slice(4));
      return leftNumber - rightNumber;
    }),
    Array.from({ length: 13 }, (_, index) => `kfd-${index + 1}`),
  );
  assert.equal(data.standards['kfd-1'].status, 'source-supported');
  assert.equal(data.standards['kfd-2'].mode, 'release-claims');
  assert.equal(data.standards['kfd-3'].status, 'source-supported');
  assert.equal(data.standards['kfd-4'].status, 'candidate');
  assert.ok(data.standards['kfd-4'].schemaCount >= 1);
  assert.equal(data.standards['kfd-5'].status, 'candidate');
  assert.equal(data.standards['kfd-6'].status, 'unsupported');
  assert.equal(data.standards['kfd-7'].status, 'source-supported');
  for (const number of [8, 9, 10, 11, 12, 13]) {
    assert.equal(
      data.standards[`kfd-${number}`].status,
      'draft-adopter-evidence',
    );
    assert.equal(
      data.standards[`kfd-${number}`].releaseQualification.shippedSupport,
      false,
    );
  }
  assert.equal(data.agentRuntime.profile.id, 'kfd-agent-runtime');
  assert.equal(data.agentRuntime.suite.id, 'kfd-runtime-100');
  assert.match(data.agentRuntime.suite.vectorRoot, /^sha256:[0-9a-f]{64}$/);
});

test('kfd schema exposes installed schemas beyond the old KFD-1 through KFD-4 boundary', () => {
  const data = runJson(['kfd', 'schema', 'kfd-13', '--json']);
  assert.equal(data.standard, 'kfd-13');
  assert.equal(data.name, 'metadata');
  assert.equal(
    data.schemaId,
    'https://kfd.libkungfu.dev/schemas/kfd-standards.schema.json',
  );
});

test('kfd agent-runtime exposes bounded adapter and report discovery', () => {
  const data = runJson(['kfd', 'agent-runtime', 'status', '--json']);
  assert.equal(data.contract, 'kungfu.sdk.kfd-agent-runtime-status/v1');
  assert.equal(data.profile.version, '0.1.0-alpha.1');
  assert.equal(data.suite.vectorCount, 100);
  assert.equal(data.runtimeBoundary.bootstrap, 'kungfu_get_api');
  assert.equal(data.runtimeBoundary.abi, 1);
  assert.deepEqual(data.runtimeBoundary.interfaces, [
    'stream',
    'ledger-action',
    'maintenance',
  ]);
  assert.equal(data.runtimeBoundary.languageHosts, 0);
  assert.equal(data.latestReport.status, 'not-provided');
  assert.ok(data.nonClaims.includes('industry-standard-adoption'));
});

test('kfd standard commands expose KFD-1, KFD-2, and KFD-4 facts', () => {
  const kfd1 = runJson(['kfd', '1', 'witness', '--json']);
  assert.equal(kfd1.contract, 'kungfu-buildchain-kfd-1-witness-set');
  assert.equal(kfd1.standard, 'kfd-1');
  assert.ok(kfd1.surfaces.length >= 1);

  const kfd1Gate = runJson(['kfd', '1', 'gate', '--json']);
  assert.equal(kfd1Gate.contract, 'kungfu-buildchain-kfd-1-release-gate');
  assert.equal(kfd1Gate.status, 'passed');
  assert.equal(kfd1Gate.contractWorlds.length, 1);

  const kfd1Verify = runJson(['kfd', '1', 'verify', '--json']);
  assert.equal(kfd1Verify.contract, 'kungfu-buildchain-kfd-1-verify-result');
  assert.equal(kfd1Verify.ok, true);
  assert.deepEqual(kfd1Verify.issues, []);

  const kfd2 = runJson(['kfd', '2', 'claims', '--json']);
  assert.equal(kfd2.contract, 'kungfu-sdk-kfd-2-release-claims');
  assert.equal(kfd2.standard, 'kfd-2');
  assert.equal(kfd2.releaseClaims.contract, 'kfd-2-release-claims');
  assert.equal(kfd2.releaseClaims.claims.length, sdkKfd2ClaimCount);
  assert.equal(kfd2.buildchainProjection.claimCount, sdkKfd2ClaimCount);
  assert.equal(kfd2.buildchainProjection.claims.length, sdkKfd2ClaimCount);
  assert.equal(kfd2.releaseGate.passportInput, '--kfd-2-claim-json');

  const kfd4 = runJson(['kfd', '4', 'schema', '--json']);
  assert.equal(kfd4.contract, 'kungfu-buildchain-kfd-schema');
  assert.equal(kfd4.standard, 'kfd-4');
  assert.equal(typeof kfd4.schema, 'object');
});

test('kfd witness emits an installed SDK KFD-3 witness', () => {
  const data = runJson(['kfd', 'witness', '--json']);
  assert.equal(data.id, 'kungfu-sdk-kfd3-capability-witness');
  assert.equal(data.standard, 'kfd-3');
  assert.equal(data.witnessKind, 'installed-sdk-query');
  assert.ok(data.exposedSurfaces.some((row) => row.id === 'kungfu.kfd.query'));
});

test('kfd upstream exposes aggregated upstream KFD package facts', () => {
  const data = runJson(['kfd', 'upstream', '--json']);
  assert.equal(data.contract, 'kungfu-upstream-kfd-aggregate');
  assert.equal(data.summary.upstreamCount, 3);
  assert.equal(data.summary.packageVersions.kfd, kfdPackage.version);
  assert.equal(
    data.summary.packageVersions.buildchain,
    buildchainPackage.version,
  );
  assert.ok(
    data.upstreams.some(
      (row) =>
        row.id === 'libnode' &&
        row.package.version ===
          corePackage.devDependencies['@kungfu-tech/libnode'],
    ),
  );
  assert.equal(data.ownKfd.kfd1.status, 'supported');
  assert.equal(data.ownKfd.kfd2.claimCount, sdkKfd2ClaimCount);
  assert.equal(data.ownKfd.kfd4.status, 'candidate');
  assert.equal(data.ownKfd.kfd4.releaseQualification, 'not-qualified');
  assert.equal(data.ownKfd.kfd4.shippedSupport, false);
});

test('kfd aggregate joins own KFD-3 query facts with upstream KFD facts', () => {
  const data = runJson(['kfd', 'aggregate', '--json']);
  assert.equal(data.contract, 'kungfu-sdk-kfd-aggregate');
  assert.equal(data.own.surfaceCount >= 1, true);
  assert.equal(data.upstream.summary.upstreamCount, 3);
  assert.equal(data.kfd.kfd3, 'declared-and-aggregated');
  assert.equal(data.kfd.kfd4, 'verified-candidate-not-shipped');
  assert.match(data.source.upstreamAggregate.sha256, /^sha256:[0-9a-f]{64}$/);
});

test('adopt refuses a source path that does not match the registry', () => {
  const result = spawnSync(
    process.execPath,
    [
      sdk,
      'contract',
      'adopt',
      'config',
      '--source',
      'framework/kfx/kungfu-kfx.contract.json',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--source does not match registry source/);
});

test('adds a new contract source and registry entry in a repo fixture', (t) => {
  const root = makeContractRepo(t);
  const data = runJson(['contract', 'add', 'demo-surface', '--json'], root);
  assert.equal(data.schema, 'kungfu.sdk.contract-add/v1');
  assert.equal(data.ok, true);
  assert.equal(data.surface, 'demo-surface');
  assert.equal(
    data.source,
    'framework/spec/contract/demo-surface.contract.json',
  );
  assert.equal(data.artifact, 'config/demo-surface.contract.json');
  assert.equal(data.env, 'KUNGFU_DEMO_SURFACE_CONTRACT');
  assert.equal(
    data.fixture.path,
    'framework/spec/contract/fixtures/demo-surface.contract-evidence.json',
  );
  assert.equal(data.fixture.schema, 'kungfu.sdk.contract-drift-fixture/v1');
  assert.match(data.fixture.hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(data.next.evidence, /contract evidence demo-surface --json/);
  assert.match(data.next.versioning, /docs\/development\/versioning\.md/);
  assert.match(data.next.knownLimits, /docs\/qualification\/known-limits\.md/);
  assert.match(data.contract.hash, /^sha256:[0-9a-f]{64}$/);

  const sourcePath = join(root, data.source);
  const fixturePath = join(root, data.fixture.path);
  assert.equal(existsSync(sourcePath), true);
  assert.equal(existsSync(fixturePath), true);
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.equal(fixture.schema, 'kungfu.sdk.contract-drift-fixture/v1');
  assert.equal(fixture.surface, 'demo-surface');
  assert.equal(fixture.source, data.source);
  assert.match(fixture.expected.sourceHash, /^sha256:[0-9a-f]{64}$/);
  const registry = JSON.parse(
    readFileSync(
      join(
        root,
        'framework',
        'spec',
        'contract',
        'kungfu-contracts.registry.json',
      ),
      'utf8',
    ),
  );
  assert.equal(registry.contracts.length, 1);
  assert.equal(registry.contracts[0].surface, 'demo-surface');
  assert.equal(registry.contracts[0].probeFixture, data.fixture.path);

  const adopt = runJson(
    ['contract', 'adopt', 'demo-surface', '--source', data.source, '--json'],
    root,
  );
  assert.equal(adopt.ok, true);

  const evidence = runJson(
    ['contract', 'evidence', 'demo-surface', '--json'],
    root,
  );
  assert.equal(evidence.schema, 'kungfu.sdk.contract-evidence/v1');
  assert.equal(evidence.summary.fixtures, 1);
  assert.equal(evidence.contracts[0].fixture.exists, true);
  assert.equal(evidence.contracts[0].fixture.path, data.fixture.path);
});

test('add refuses an already registered surface', (t) => {
  const root = makeContractRepo(t);
  runJson(['contract', 'add', 'demo-surface', '--json'], root);
  const result = spawnSync(
    process.execPath,
    [sdk, 'contract', 'add', 'demo-surface'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already registered/);
});

test('render --write canonicalizes only when explicitly requested', (t) => {
  const root = makeContractRepo(t);
  const added = runJson(['contract', 'add', 'demo-surface', '--json'], root);
  const sourcePath = join(root, added.source);
  const contract = JSON.parse(readFileSync(sourcePath, 'utf8'));
  writeFileSync(sourcePath, JSON.stringify(contract));

  const check = runJson(
    ['contract', 'render', 'demo-surface', '--check', '--json'],
    root,
  );
  assert.equal(check.ok, true);
  assert.equal(check.byteForByte, false);

  const written = runJson(
    ['contract', 'render', 'demo-surface', '--write', '--json'],
    root,
  );
  assert.equal(written.schema, 'kungfu.sdk.contract-render-write/v1');
  assert.equal(written.ok, true);
  assert.equal(written.changed, true);
  assert.match(written.previousHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(written.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    readFileSync(sourcePath, 'utf8'),
    `${JSON.stringify(contract, null, 2)}\n`,
  );

  const after = runJson(
    ['contract', 'render', 'demo-surface', '--check', '--json'],
    root,
  );
  assert.equal(after.ok, true);
  assert.equal(after.byteForByte, true);
});
