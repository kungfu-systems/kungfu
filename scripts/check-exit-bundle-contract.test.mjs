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
const contract = readJson('framework/exit/kungfu-exit-bundle.contract.json');
const fixtures = readJson('tests/fixtures/exit-bundle-contract/cases.json');
const registry = readJson('framework/contract/kungfu-contracts.registry.json');
const exitQualification = readJson(
  'docs/qualification/evidence/exit-clean-runtime/520a61af87/report.json',
);
const providerQualification = readJson(
  'docs/qualification/evidence/provider-migration-product/bb6f4a42c1/report.json',
);
const canonicalPolicy = readJson(
  'framework/contract/kungfu-agent-first-canonical-policy.json',
);
const Ajv2020 = optionalAjv2020();

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const THIN_CAPABILITIES = new Set(['inspect', 'verify-inventory']);

function canonicalJson(value) {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function root(domain, value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(`kungfu.exit-bundle.root/v1\0${domain}\0${canonicalJson(value)}`)
    .digest('hex')}`;
}

function schemaRoot(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

function bundleRoot(bundle) {
  const { bundleRoot: _bundleRoot, ...body } = bundle;
  return root('manifest', body);
}

function validateBundle(bundle) {
  if (bundle?.schema !== 'kungfu.exit-bundle/v1')
    return 'unsupported-top-level-protocol';

  const memberIds = new Set();
  const identityRoots = new Map();
  for (const member of bundle.members) {
    if (memberIds.has(member.memberId)) return 'duplicate-member-identity';
    memberIds.add(member.memberId);
    const identity = `${member.authority}\0${member.identityRoot}`;
    const prior = identityRoots.get(identity);
    if (prior && prior !== member.contentRoot)
      return 'conflicting-member-roots';
    identityRoots.set(identity, member.contentRoot);
  }

  if (
    bundle.requirements.requiredMembers.some(
      (memberId) => !memberIds.has(memberId),
    )
  )
    return 'required-member-missing';

  for (const member of bundle.members) {
    if (!fixtures.supportedMemberSchemas.includes(member.schema)) {
      if (member.requiredForScope) return 'unsupported-required-member';
      return 'unsupported-optional-member';
    }
    if (!fixtures.supportedMemberProtocols.includes(member.protocol))
      return 'unsupported-member-protocol';
  }

  if (Ajv2020) {
    const validateSchema = new Ajv2020({
      allErrors: true,
      strict: true,
    }).compile(contract.manifestSchema);
    if (!validateSchema(bundle)) return 'manifest-schema-invalid';
  }

  if (bundle.mode === 'thin') {
    const required = {
      selfContained: false,
      completeForScope: false,
      materialMissing: true,
      degraded: true,
    };
    if (
      Object.entries(required).some(
        ([field, expected]) => bundle.closure[field] !== expected,
      ) ||
      bundle.capabilities.some(
        (capability) => !THIN_CAPABILITIES.has(capability),
      ) ||
      bundle.requirements.requiredCapabilities.some(
        (capability) => !THIN_CAPABILITIES.has(capability),
      ) ||
      bundle.members.some(
        (member) =>
          member.material.included ||
          member.capabilities.some(
            (capability) => !THIN_CAPABILITIES.has(capability),
          ) ||
          member.import.execute,
      )
    )
      return 'thin-capability-overclaim';
  } else {
    const required = {
      selfContained: true,
      completeForScope: true,
      materialMissing: false,
      degraded: false,
    };
    if (
      Object.entries(required).some(
        ([field, expected]) => bundle.closure[field] !== expected,
      )
    )
      return 'full-closure-invalid';
    if (
      bundle.omissions.some((omission) => omission.requiredForScope) ||
      bundle.members.some(
        (member) => member.requiredForScope && !member.material.included,
      )
    )
      return 'required-omission';
  }

  if (bundle.bundleRoot !== bundleRoot(bundle)) return 'bundle-root-mismatch';
  return null;
}

function mutateBase(kind) {
  const bundle = structuredClone(fixtures.base);
  const recompute = () => {
    bundle.bundleRoot = bundleRoot(bundle);
  };
  if (kind === 'none') return bundle;
  if (kind === 'thin' || kind === 'thin-overclaim') {
    bundle.bundleId = 'exit:fixture-thin';
    bundle.mode = 'thin';
    bundle.closure = {
      selfContained: false,
      completeForScope: false,
      materialMissing: true,
      degraded: true,
    };
    bundle.members[0].material = {
      included: false,
      encoding: null,
      byteLength: 0,
      sha256: null,
    };
    bundle.members[0].capabilities = ['inspect', 'verify-inventory'];
    bundle.members[0].import.execute = false;
    bundle.requirements.requiredCapabilities = ['inspect', 'verify-inventory'];
    bundle.requirements.equivalenceLevels = ['exact-record-roots'];
    bundle.omissions = [
      {
        omissionId: 'missing-episode-material',
        memberId: 'episode-primary',
        kind: 'missing',
        requiredForScope: true,
        affectsCapabilities: [
          'verify-content',
          'materialize',
          'rebuild-projections',
          'continue',
        ],
        detailRoot:
          'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      },
    ];
    bundle.loss = [
      {
        lossId: 'thin-capability-loss',
        memberId: 'episode-primary',
        kind: 'capability',
        reversible: true,
        affectsCapabilities: [
          'verify-content',
          'materialize',
          'rebuild-projections',
          'continue',
        ],
        detailRoot:
          'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      },
    ];
    bundle.capabilities = ['inspect', 'verify-inventory'];
    if (kind === 'thin-overclaim') bundle.capabilities.push('materialize');
    recompute();
    return bundle;
  }
  if (kind === 'tampered-root') {
    bundle.scope.id = 'tampered-after-root';
    return bundle;
  }
  if (kind === 'unknown-member') {
    bundle.members[0].schema = 'example.unknown-bundle/v9';
  } else if (kind === 'unsupported-protocol') {
    bundle.members[0].protocol = 'episode-sealed-content-root/v9';
  } else if (kind === 'redacted') {
    bundle.omissions.push({
      omissionId: 'redacted-required',
      memberId: 'episode-primary',
      kind: 'redacted',
      requiredForScope: true,
      affectsCapabilities: ['materialize', 'continue'],
      detailRoot:
        'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    });
  } else if (kind === 'missing-member') {
    bundle.members = [];
  } else if (kind === 'duplicate-identity') {
    bundle.members.push(structuredClone(bundle.members[0]));
  } else if (kind === 'conflicting-roots') {
    const conflicting = structuredClone(bundle.members[0]);
    conflicting.memberId = 'episode-conflict';
    conflicting.contentRoot =
      'sha256:4444444444444444444444444444444444444444444444444444444444444444';
    bundle.members.push(conflicting);
  } else if (kind === 'top-level-version') {
    bundle.schema = 'kungfu.exit-bundle/v2';
  } else {
    throw new Error(`unknown fixture mutation: ${kind}`);
  }
  recompute();
  return bundle;
}

test('registers one packaged KFD-1 Exit Bundle contract', () => {
  const entry = registry.contracts.find(
    (candidate) => candidate.surface === 'exit-bundle',
  );
  assert.ok(entry);
  assert.equal(entry.source, 'framework/exit/kungfu-exit-bundle.contract.json');
  assert.equal(entry.weldedSurface, 'exit-bundle-contract');
  assert.equal(entry.contractSchemaRoot, schemaRoot(contract.contractSchema));
  assert.deepEqual(entry.extraArtifacts, [
    {
      label: 'Exit verifier contract',
      source: 'framework/core/src/python/kungfu/exit_verifier.contract.json',
      artifact: 'config/exit_verifier.contract.json',
    },
    {
      label: 'Exit verifier corpus',
      source: 'framework/core/src/python/kungfu/exit_verifier.corpus.json',
      artifact: 'config/exit_verifier.corpus.json',
    },
  ]);
  assert.equal(contract.status.specification, 'accepted');
  assert.equal(contract.status.composition, 'implemented');
  assert.equal(contract.status.installedVerifier, 'implemented');
  assert.equal(contract.status.releaseQualification, 'not-qualified');
  const sourceRoot = `sha256:${crypto
    .createHash('sha256')
    .update(read('framework/exit/kungfu-exit-bundle.contract.json'))
    .digest('hex')}`;
  const policyEntry = canonicalPolicy.surfaces.find(
    (candidate) => candidate.surface === 'exit-bundle',
  );
  assert.ok(policyEntry);
  assert.equal(policyEntry.source.sha256, sourceRoot);
  assert.equal(policyEntry.source.renderedSha256, sourceRoot);
  assert.equal(policyEntry.artifact.expectedSha256, sourceRoot);
  assert.equal(
    canonicalPolicy.contractWorld.digest,
    schemaRoot(canonicalPolicy.contractWorld.value),
  );
  const freeze = read('framework/core/.gyp/run-freeze.js');
  assert.match(
    freeze,
    /kungfu-exit-bundle\.contract\.json[\s\S]+exit_bundle\.contract\.json/,
    'assembled product must stage the registry-free verifier contract beside the package',
  );
});

test('embedded schemas validate the exact contract and full fixture', () => {
  if (Ajv2020) {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validateContract = ajv.compile(contract.contractSchema);
    assert.equal(
      validateContract(contract),
      true,
      JSON.stringify(validateContract.errors),
    );
    const validateManifest = ajv.compile(contract.manifestSchema);
    ajv.compile(contract.requestSchema);
    ajv.compile(contract.packageSchema);
    ajv.compile(contract.receiptSchema);
    assert.equal(
      validateManifest(fixtures.base),
      true,
      JSON.stringify(validateManifest.errors),
    );
  }
  assert.equal(
    fixtures.base.contractSchemaRoot,
    schemaRoot(contract.manifestSchema),
  );
  assert.equal(fixtures.base.bundleRoot, bundleRoot(fixtures.base));
});

test('public compatibility policy is bounded by exact retained evidence', () => {
  const policy = contract.supportPolicy;
  assert.equal(policy.schema, 'kungfu.exit-compatibility-policy/v1');
  assert.equal(
    policy.productVersioning.stableSameMinor.commitment,
    'registered-authoritative-semantics-unchanged',
  );
  assert.equal(
    policy.productVersioning.preRelease.commitment,
    'exact-evidence-only',
  );
  assert.equal(
    policy.productVersioning.crossMinor.commitment,
    'declared-reader-or-qualified-migration-only',
  );
  assert.equal(
    policy.supportWindow.status,
    'not-frozen-before-first-stable-v4',
  );
  assert.equal(policy.supportWindow.supportedPriorMinors, null);
  assert.equal(policy.supportWindow.duration, null);
  assert.equal(policy.qualification.overallReleaseStatus, 'not-qualified');
  assert.deepEqual(policy.qualification.unqualifiedPlatforms, [
    'linux-x86_64',
    'windows-x86_64',
  ]);

  const evidence = new Map(
    policy.qualification.retainedEvidence.map((row) => [row.kind, row]),
  );
  assert.deepEqual(evidence.get('clean-runtime-exit'), {
    kind: 'clean-runtime-exit',
    path: 'docs/qualification/evidence/exit-clean-runtime/520a61af87/report.json',
    reportRoot: exitQualification.reportRoot,
    artifactDigest: exitQualification.artifact.digest,
    platform: 'darwin-arm64',
    verdict: exitQualification.status,
  });
  assert.deepEqual(evidence.get('provider-migration'), {
    kind: 'provider-migration',
    path: 'docs/qualification/evidence/provider-migration-product/bb6f4a42c1/report.json',
    reportRoot: providerQualification.reportRoot,
    artifactDigest: providerQualification.artifact.digest,
    platform: providerQualification.qualifiedPlatforms[0],
    verdict: providerQualification.verdict,
  });
});

test('machine inventory stays bound to current domain authorities', () => {
  const schemas = new Set();
  for (const member of contract.memberInventory) {
    assert.equal(
      fs.existsSync(path.join(ROOT, member.source)),
      true,
      member.id,
    );
    const source = read(member.schemaSource ?? member.source);
    for (const schema of member.schemas) {
      assert.equal(schemas.has(schema), false, `duplicate inventory ${schema}`);
      schemas.add(schema);
      assert.match(source, new RegExp(schema.replaceAll('.', '\\.'), 'u'));
    }
    assert.ok(member.owner);
    assert.ok(member.identityRoot);
    assert.ok(member.protocol);
    assert.ok(member.material.length);
    assert.equal(typeof member.import.validateDefault, 'boolean');
    assert.equal(typeof member.import.executeExplicit, 'boolean');
    assert.equal(typeof member.import.idempotent, 'boolean');
    assert.ok(member.import.destinationPreflight);
    assert.ok(member.gap);
  }
  assert.deepEqual(
    [...fixtures.supportedMemberSchemas].sort(),
    contract.memberInventory
      .filter((member) => member.eligibleMember)
      .flatMap((member) => member.schemas)
      .sort(),
  );
});

test('full and thin semantics remain mutually exclusive', () => {
  assert.deepEqual(contract.modeSemantics.full.required, {
    selfContained: true,
    completeForScope: true,
    materialMissing: false,
    degraded: false,
  });
  assert.deepEqual(contract.modeSemantics.thin.required, {
    selfContained: false,
    completeForScope: false,
    materialMissing: true,
    degraded: true,
  });
  assert.deepEqual(contract.modeSemantics.thin.maximumCapabilities, [
    'inspect',
    'verify-inventory',
  ]);
});

test('positive and negative corpus pins fail-closed diagnostics', () => {
  assert.deepEqual(
    fixtures.cases.map((fixture) => fixture.id),
    [
      'complete-full',
      'honest-thin',
      'tampered-root',
      'unknown-required-member',
      'member-version-mismatch',
      'redacted-required-material',
      'required-member-missing',
      'duplicate-member-identity',
      'conflicting-member-roots',
      'thin-capability-overclaim',
      'top-level-version-mismatch',
    ],
  );
  for (const fixture of fixtures.cases) {
    const diagnostic = validateBundle(mutateBase(fixture.mutation));
    assert.equal(
      diagnostic,
      fixture.expected.ok ? null : fixture.expected.diagnostic,
      fixture.id,
    );
  }
});

test('history surfaces share one honest authority projection', () => {
  assert.equal(
    contract.historySurface.schema,
    'kungfu.exit-history.surface/v1',
  );
  assert.match(
    contract.historySurface.statusSemantics['contract-ready'],
    /coverage has not been evaluated/u,
  );
  assert.match(
    contract.historySurface.statusSemantics['inventory-verified'],
    /explicit loss/u,
  );
  assert.deepEqual(Object.keys(contract.historySurface.commands).sort(), [
    'export',
    'import',
    'rebuild',
    'status',
    'verify',
  ]);
  assert.match(contract.historySurface.observerRule, /same Core status/u);
  assert.match(contract.historySurface.rebuildRule, /never copies GUI/u);
  assert.match(contract.historySurface.stdoutRule, /schema-bound JSON/u);
});

test('composition authority never absorbs member domain semantics', () => {
  assert.match(contract.authority.members, /sole authority/u);
  assert.match(
    contract.authority.compositionRule,
    /delegates member verification/u,
  );
  for (const forbidden of [
    'episode_id',
    'fact_id',
    'profile_id',
    'journal_path',
    'sqlite_path',
  ])
    assert.equal(
      Object.hasOwn(contract.manifestSchema.properties, forbidden),
      false,
      forbidden,
    );
});
