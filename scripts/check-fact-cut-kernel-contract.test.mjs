// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { optionalAjv2020 } from './readonly-source-toolchain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));
const Ajv2020 = optionalAjv2020();
const contract = readJson(
  'framework/core/fact/kungfu-fact-cut-kernel.contract.json',
);
const fixtures = readJson('tests/fixtures/fact-cut-kernel-contract/cases.json');
const registry = readJson(
  'framework/spec/contract/kungfu-contracts.registry.json',
);
const canonicalPolicy = readJson(
  'framework/spec/contract/kungfu-agent-first-canonical-policy.json',
);
const portableAdr = read(
  'docs/adr/KF-ADR-019f86da-4f90-7acc-b6dc-d560f0fab367.md',
);
const writerAuthority = readJson(
  'framework/core/fact/kungfu-fact-writer-authority-v2.json',
);

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/;
const OBJECT_PATTERN = /^fact:[0-9a-f]{32}$/;
const REF_PATTERN = /^[a-z][a-z0-9._/-]{0,127}$/;

const canonicalJson = (value) => {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
};

function validateFixture(value) {
  if (value.operation === 'admit-version') {
    if (!OBJECT_PATTERN.test(value.objectId ?? '')) return 'invalid-identity';
    if (value.versionRoot && !ROOT_PATTERN.test(value.versionRoot))
      return 'invalid-identity';
    if (!value.versionRoot && value.observationRoot) return 'admission-missing';
    if (!ROOT_PATTERN.test(value.bodyRoot ?? '')) return 'body-missing';
    if (!ROOT_PATTERN.test(value.schemaRoot ?? '')) return 'schema-missing';
    if (!value.admissionRoots?.length) return 'admission-missing';
    return null;
  }

  if (value.operation === 'admit-cut') {
    if (value.wallClock !== undefined || value.inheritRelations === true)
      return 'invalid-cut';
    const requiredSets = [
      'parentCutRoots',
      'objectVersions',
      'activeRelationRoots',
      'declarationRoots',
      'admissionRoots',
      'episodeFrontier',
      'omissionRoots',
      'conflictRoots',
    ];
    if (requiredSets.some((field) => !Array.isArray(value[field])))
      return 'invalid-cut';
    if (
      value.parentCutRoots.some((root) => !ROOT_PATTERN.test(root)) ||
      value.activeRelationRoots.some((root) => !ROOT_PATTERN.test(root)) ||
      value.declarationRoots.some((root) => !ROOT_PATTERN.test(root)) ||
      value.admissionRoots.some((root) => !ROOT_PATTERN.test(root)) ||
      value.omissionRoots.some((root) => !ROOT_PATTERN.test(root)) ||
      value.conflictRoots.some((root) => !ROOT_PATTERN.test(root)) ||
      value.objectVersions.some(
        ([objectId, versionRoot]) =>
          !OBJECT_PATTERN.test(objectId) || !ROOT_PATTERN.test(versionRoot),
      )
    )
      return 'invalid-cut';
    if (value.kind === 'merge-view' && value.parentCutRoots.length < 2)
      return 'invalid-cut';
    return null;
  }

  if (value.operation === 'move-ref') {
    if (!REF_PATTERN.test(value.refName ?? '')) return 'invalid-identity';
    if (value.rewriteHistory === true) return 'invalid-cut';
    if (!ROOT_PATTERN.test(value.newCutRoot ?? '')) return 'unknown-cut';
    if (value.refExists) {
      if (
        !ROOT_PATTERN.test(value.expectedOldCutRoot ?? '') ||
        !Number.isSafeInteger(value.expectedOldRevision)
      )
        return 'expected-old-required';
      if (
        value.expectedOldCutRoot !== value.currentCutRoot ||
        value.expectedOldRevision !== value.currentRevision
      )
        return 'stale-ref';
    } else if (
      value.expectedOldCutRoot !== null ||
      value.expectedOldRevision !== 0
    ) {
      return 'expected-old-required';
    }
    if (value.kind === 'rollback' && !ROOT_PATTERN.test(value.reasonRoot ?? ''))
      return 'invalid-cut';
    return null;
  }

  if (value.operation === 'query-cut') {
    if (String(value.cutRoot ?? '').startsWith('episode:'))
      return 'invalid-cut';
    return ROOT_PATTERN.test(value.cutRoot ?? '') ? null : 'invalid-identity';
  }

  return 'unsupported-version';
}

test('registers one accepted contract with the native writer stage implemented', () => {
  assert.equal(contract.status.specification, 'accepted');
  assert.equal(contract.status.authoritativeWriter, 'implemented');
  assert.equal(contract.status.runtimeProjection, 'implemented');
  assert.equal(contract.status.releaseQualification, 'not-qualified');
  const entry = registry.contracts.find(
    (candidate) => candidate.surface === 'fact-cut-kernel',
  );
  assert.ok(entry);
  assert.equal(
    entry.source,
    'framework/core/fact/kungfu-fact-cut-kernel.contract.json',
  );
  assert.equal(entry.weldedSurface, 'fact-cut-kernel-contract');
  assert.equal(
    entry.contractSchemaRoot,
    `sha256:${crypto
      .createHash('sha256')
      .update(canonicalJson(contract.contractSchema))
      .digest('hex')}`,
  );
  const sourceRoot = `sha256:${crypto
    .createHash('sha256')
    .update(read('framework/core/fact/kungfu-fact-cut-kernel.contract.json'))
    .digest('hex')}`;
  const policyEntry = canonicalPolicy.surfaces.find(
    (candidate) => candidate.surface === 'fact-cut-kernel',
  );
  assert.ok(policyEntry);
  assert.equal(policyEntry.source.sha256, sourceRoot);
  assert.equal(policyEntry.source.renderedSha256, sourceRoot);
  assert.equal(policyEntry.artifact.expectedSha256, sourceRoot);
  assert.equal(
    canonicalPolicy.contractWorld.digest,
    `sha256:${crypto
      .createHash('sha256')
      .update(canonicalJson(canonicalPolicy.contractWorld.value))
      .digest('hex')}`,
  );
});

test('keeps Fact lifecycle claims aligned with current implementation evidence', () => {
  assert.match(portableAdr, /^implementation_status: implemented$/mu);
  assert.match(
    portableAdr,
    /^implementation_prs: \[https:\/\/github\.com\/kungfu-systems\/kungfu\/pull\/1115, https:\/\/github\.com\/kungfu-systems\/kungfu\/pull\/1116, https:\/\/github\.com\/kungfu-systems\/kungfu\/pull\/1139\]$/mu,
  );
  assert.match(
    portableAdr,
    /^closure_pr: https:\/\/github\.com\/kungfu-systems\/kungfu\/pull\/1139$/mu,
  );
  assert.match(
    portableAdr,
    /KFR2 is the explicit native writer\n {2}authority, while release qualification remains a separate decision/u,
  );
  assert.equal(contract.rootCanonical.legacy.writerDefault, false);
  assert.equal(contract.rootCanonical.portable.writerDefault, true);
  assert.deepEqual(contract.qualification.requiredNextEvidence, [
    'physical-power-loss-on-exact-Fact-composed-path',
    'independent-failure-domain-restore',
    'production-profile-admission',
  ]);
  assert.deepEqual(
    contract.qualification.completedEvidence.map((evidence) => evidence.id),
    [
      'rebuild-and-replaceable-backend-parity',
      'fsck-portable-export-import-root-preservation',
      'portable-kfr2-independent-conformance',
      'positive-and-negative-cas-concurrency',
      'legacy-v1-exact-replay-and-reader-retention',
      'kfr2-writer-mapping-rollback-and-exact-candidate',
      'fact-durable-success-replay-and-fresh-reopen-reconciliation',
      'fact-durable-profile-and-provider-fail-closed',
      'fact-durable-cut-point-fault-matrix',
      'fact-durable-retained-candidate-report',
    ],
  );
  for (const evidence of contract.qualification.completedEvidence) {
    const [relative, testName] = evidence.test.split('::');
    assert.equal(fs.existsSync(path.join(ROOT, relative)), true, evidence.id);
    if (testName)
      assert.match(read(relative), new RegExp(`def ${testName}\\b`, 'u'));
  }
});

test('the embedded Draft 2020-12 schema validates the exact contract', (t) => {
  if (!Ajv2020) {
    t.skip('ajv is not installed; CI enforces JSON Schema conformance');
    return;
  }
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
    contract.contractSchema,
  );
  assert.equal(validate(contract), true, JSON.stringify(validate.errors));
});

test('separates every authoritative role and freezes the Cut root inputs', () => {
  assert.equal(contract.rootCanonical.legacy.status, 'required-legacy-reader');
  assert.equal(contract.rootCanonical.legacy.portable, false);
  assert.equal(
    contract.rootCanonical.portable.id,
    'kungfu.fact-root.canonical/v2',
  );
  assert.equal(contract.rootCanonical.portable.status, 'authoritative-writer');
  assert.equal(contract.rootCanonical.portable.writerDefault, true);
  assert.equal(
    contract.rootCanonical.portable.writerAuthority,
    'framework/core/fact/kungfu-fact-writer-authority-v2.json',
  );
  assert.equal(
    writerAuthority.writer.rootProtocol,
    contract.rootCanonical.portable.id,
  );
  assert.equal(writerAuthority.migration.inPlaceRewrite, false);
  assert.equal(writerAuthority.rollback.downgradeWrite, 'fail-closed');
  assert.deepEqual(contract.rootCanonical.portable.implementations, [
    'libkungfu-cpp',
    'independent-python',
  ]);
  assert.equal(
    contract.rootCanonical.portable.contract,
    'framework/core/fact/kungfu-fact-root-canonical-v2.json',
  );
  assert.equal(
    contract.rootCanonical.portable.corpus,
    'tests/fixtures/fact-root-canonical/vectors.json',
  );
  assert.deepEqual(
    contract.boundaries.map((row) => row.kind),
    [
      'observation',
      'admission-record',
      'fact-object',
      'fact-version',
      'fact-cut',
      'episode',
      'projection',
    ],
  );
  assert.deepEqual(Object.keys(contract.cut.composition), [
    'parentCutRoots',
    'objectVersions',
    'activeRelationRoots',
    'declarationRoots',
    'admissionRoots',
    'episodeFrontier',
    'omissionRoots',
    'conflictRoots',
  ]);
  assert.ok(contract.cut.identityExcludes.includes('wall-clock'));
  assert.equal(contract.relations.inheritance, 'none');
  assert.equal(contract.refs.cas.required, true);
  assert.equal(contract.refs.cas.staleCaller, 'reject-without-write');
});

test('declares one owner for closed metadata, typed bodies, bytes, and projections', () => {
  assert.equal(
    contract.ownership.closedKernelMetadata.owner,
    'hana-pod-journal',
  );
  assert.equal(
    contract.ownership.domainTypedBodies.owner,
    'flatbuffers-single-schema-owner',
  );
  assert.equal(contract.ownership.opaqueBodies.owner, 'content-store');
  assert.equal(contract.ownership.json.owner, 'edge-projection-only');
  assert.equal(
    contract.ownership.sqliteAndIndexes.owner,
    'rebuildable-projection-only',
  );
});

test('accepts the positive fixtures', () => {
  for (const fixture of fixtures.valid)
    assert.equal(validateFixture(fixture), null, fixture.id);
});

test('every declared falsifier fails for the declared reason', () => {
  const declared = new Map(
    contract.falsifiers.map((row) => [row.id, row.expectedFailure]),
  );
  assert.equal(declared.size, contract.falsifiers.length);
  assert.deepEqual(
    new Set(fixtures.invalid.map((row) => row.id)),
    new Set(declared.keys()),
  );
  for (const fixture of fixtures.invalid) {
    assert.equal(fixture.expectedFailure, declared.get(fixture.id), fixture.id);
    assert.equal(validateFixture(fixture), fixture.expectedFailure, fixture.id);
  }
});

test('the machine contract contains no product workflow vocabulary', () => {
  const machineContract = read(
    'framework/core/fact/kungfu-fact-cut-kernel.contract.json',
  ).toLowerCase();
  for (const forbidden of ['pursuit', 'warrant', 'mission', 'goal', 'go-card'])
    assert.equal(
      new RegExp(`\\b${forbidden}\\b`, 'u').test(machineContract),
      false,
      forbidden,
    );
});
