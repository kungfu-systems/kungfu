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
const { contractArtifacts } = require('../../../scripts/contract-registry.cjs');

function runJson(args, cwd = repoRoot) {
  const result = spawnSync(process.execPath, [sdk, ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function makeContractRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'kungfu-sdk-contract-'));
  const contractDir = join(root, 'framework', 'contract');
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

for (const [surface, source] of [
  ['config', 'framework/config/kungfu-config.contract.json'],
  ['kfx', 'framework/kfx/kungfu-kfx.contract.json'],
  ['skill', 'framework/skill/kungfu-skill.contract.json'],
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
  assert.equal(data.releaseGate.metadata.package.version, '1.0.0-alpha.2');
  assert.equal(
    data.releaseGate.metadata.schemaIds.contractWorld,
    'https://kfd.libkungfu.dev/schemas/kfd-1/contract-world.schema.json',
  );
  assert.equal(data.releaseGate.role, 'local-evidence');
  assert.deepEqual(data.summary.surfaces, ['config', 'kfx', 'skill']);
  assert.equal(data.summary.count, 3);
  assert.equal(data.contracts.length, 3);
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
  assert.equal(data.upstream.kfd.package.version, '1.0.0-alpha.2');
  assert.equal(data.upstream.buildchain.package.version, '2.8.0');
  assert.equal(
    data.upstream.buildchain.formatting.name,
    'buildchain-release-evidence-json-v1',
  );
  assert.equal(data.upstream.buildchain.releaseGate.passportKey, 'kfd-1');
  assert.deepEqual(
    data.surfaces.map((surface) => surface.surface),
    ['config', 'kfx', 'skill'],
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
  assert.equal(data.metadata.kfdPackage.version, '1.0.0-alpha.2');
  assert.equal(
    data.canonicalPolicy.path,
    'framework/contract/kungfu-agent-first-canonical-policy.json',
  );
  assert.match(data.contractWorld.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(
    data.surfaces.map((surface) => surface.name),
    ['kungfu-config', 'kungfu-kfx', 'kungfu-skill'],
  );
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
    ['current', 'current', 'current'],
  );
});

test('packages the agent-first canonical policy through the contract registry helper', () => {
  const artifacts = contractArtifacts();
  assert.ok(
    artifacts.some(
      (artifact) =>
        artifact.label === 'agent-first canonical policy' &&
        artifact.source ===
          'framework/contract/kungfu-agent-first-canonical-policy.json' &&
        artifact.artifact === 'config/kungfu-agent-first-canonical-policy.json',
    ),
  );
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
  assert.equal(data.source, 'framework/contract/demo-surface.contract.json');
  assert.equal(data.artifact, 'config/demo-surface.contract.json');
  assert.equal(data.env, 'KUNGFU_DEMO_SURFACE_CONTRACT');
  assert.equal(
    data.fixture.path,
    'framework/contract/fixtures/demo-surface.contract-evidence.json',
  );
  assert.equal(data.fixture.schema, 'kungfu.sdk.contract-drift-fixture/v1');
  assert.match(data.fixture.hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(data.next.evidence, /contract evidence demo-surface --json/);
  assert.match(data.next.versioning, /docs\/versioning\.md/);
  assert.match(data.next.knownLimits, /docs\/known-limits\.md/);
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
      join(root, 'framework', 'contract', 'kungfu-contracts.registry.json'),
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
