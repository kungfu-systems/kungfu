#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { qualifiedCorePlatformMatrix } from '@kungfu-tech/work/assignment-capture/qualified-assignment-core-platform-matrix';
import { publicUvLockViolations } from './shifu-uv-cache-adapter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIFU_DOCS = path.join(ROOT, 'docs', 'shifu');
const CONTRACT_PATH = path.join(SHIFU_DOCS, 'cache-contract.json');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  }
  return value;
}

export function qualifiedAssignmentCoreRoot(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(ordered(value)))
    .digest('hex')}`;
}

// ajv is a devDependency (root package.json), present in CI and after a full
// `pnpm install`, but a freshly created git worktree has no node_modules yet.
// Load it lazily so a missing setup dependency degrades to a skip of the schema
// checks instead of crashing the whole pre-commit gate — the same "a setup gap
// must not block a commit" rule the hook shim already follows. The structural and
// private-IP leak checks below do not need ajv and always run; CI (with ajv
// installed) still enforces the full schema/fixture validation.
async function loadAjv2020() {
  try {
    return (await import('ajv/dist/2020.js')).default;
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}

function ajv2020(Ajv2020) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('date-time', (value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && /(?:Z|[+-]\d\d:\d\d)$/.test(value);
  });
  ajv.addFormat('uri-reference', (value) => {
    try {
      new URL(value, 'https://libkungfu.dev/');
      return true;
    } catch {
      return false;
    }
  });
  return ajv;
}

function validateOrThrow(validate, value, label) {
  if (validate(value)) return;
  const details = (validate.errors || [])
    .map((item) => `${item.instancePath || '/'} ${item.message || 'invalid'}`)
    .join('; ');
  throw new Error(`${label} does not satisfy its schema: ${details}`);
}

function qualifiedArtifactPaths(root, cacheContract) {
  const artifactContractPath = path.join(
    root,
    cacheContract.authority.artifactContract,
  );
  const artifactContract = readJson(artifactContractPath);
  const qualified = artifactContract.qualifiedAssignmentCore;
  assert.equal(artifactContract.schema, 'shifu.local-artifact-contract/v1');
  assert.equal(qualified.status, 'development');
  assert.equal(qualified.compatibility.producerMetadataRewrite, 'forbidden');
  assert.equal(qualified.authority.transport, 'replaceable-non-authoritative');
  return {
    artifactContractPath,
    artifactContract,
    qualified,
    manifestSchemaPath: path.join(root, qualified.manifestSchema),
    qualificationSchemaPath: path.join(
      root,
      qualified.qualificationReceiptSchema,
    ),
    platformMatrixPath: path.join(root, qualified.platformMatrix),
    platformMatrixSchemaPath: path.join(root, qualified.platformMatrixSchema),
    legacyManifestSchemaPath: path.join(
      root,
      'docs/shifu/schema/qualified-assignment-core-artifact-v1.schema.json',
    ),
    legacyQualificationSchemaPath: path.join(
      root,
      'docs/shifu/schema/qualified-assignment-core-qualification-v1.schema.json',
    ),
    decisionPath: path.join(root, qualified.decision),
  };
}

function manifestRoot(manifest) {
  const {
    manifestRoot: _manifestRoot,
    qualificationReceiptRoot: _qualificationReceiptRoot,
    promotionAuthorityRoot: _promotionAuthorityRoot,
    ...body
  } = manifest;
  return qualifiedAssignmentCoreRoot(body);
}

function receiptRoot(receipt) {
  const { receiptRoot: _receiptRoot, ...body } = receipt;
  return qualifiedAssignmentCoreRoot(body);
}

function payloadBytes(value, label) {
  assert.ok(
    Buffer.isBuffer(value) || value instanceof Uint8Array,
    `${label} payload bytes are absent`,
  );
  return Buffer.from(value);
}

function exactExpected(actual, expected, field) {
  assert.equal(
    actual,
    expected,
    `${field} does not match the current consumer`,
  );
}

function exactObject(value, keys, label) {
  assert.ok(
    value && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    `${label} fields are unsupported or incomplete`,
  );
}

function validateQualifiedCoreDocumentShape(manifest, qualification) {
  const compatibilityV2 =
    manifest.schema === 'shifu.qualified-assignment-core-artifact/v2';
  exactObject(
    manifest,
    [
      'schema',
      'producer',
      'target',
      'compatibility',
      'build',
      'contracts',
      'payload',
      'consumer',
      'manifestRoot',
      'qualificationReceiptRoot',
      'promotionAuthorityRoot',
    ],
    'qualified Core manifest',
  );
  exactObject(
    manifest.producer,
    ['repository', 'commit', 'sourceTreeRoot'],
    'qualified Core manifest producer',
  );
  exactObject(
    manifest.target,
    ['repository', 'commit'],
    'qualified Core manifest target',
  );
  exactObject(
    manifest.compatibility,
    compatibilityV2
      ? ['schema', 'root', 'mode', 'equivalenceReceiptRoot']
      : ['mode', 'equivalenceReceiptRoot'],
    'qualified Core manifest compatibility',
  );
  exactObject(
    manifest.build,
    compatibilityV2
      ? [
          'nativeInputRoot',
          'operatingSystem',
          'architecture',
          'pythonAbi',
          'profile',
          'toolchainDigest',
          'dependencyLockDigest',
          'nativeClosureRoot',
          'compatibilityPolicyRoot',
        ]
      : [
          'nativeInputRoot',
          'operatingSystem',
          'architecture',
          'pythonAbi',
          'profile',
          'toolchainDigest',
          'dependencyLockDigest',
        ],
    'qualified Core manifest build',
  );
  exactObject(
    manifest.contracts,
    [
      'artifactContractVersion',
      'qualificationContractVersion',
      'shifu',
      'buildchain',
    ],
    'qualified Core manifest contracts',
  );
  for (const name of ['shifu', 'buildchain']) {
    exactObject(
      manifest.contracts[name],
      ['version', 'root'],
      `qualified Core manifest ${name} contract`,
    );
  }
  exactObject(
    manifest.payload,
    ['artifactRoot', 'entries'],
    'qualified Core manifest payload',
  );
  assert.ok(
    Array.isArray(manifest.payload.entries) &&
      manifest.payload.entries.length > 0,
    'qualified Core manifest payload entries are absent',
  );
  for (const entry of manifest.payload.entries) {
    exactObject(
      entry,
      ['path', 'type', 'sizeBytes', 'digest', 'mode', 'linkTarget'],
      'qualified Core manifest payload entry',
    );
  }
  exactObject(
    manifest.consumer,
    [
      'targetRoot',
      'staging',
      'cleanCheckoutRequired',
      'publication',
      'partialStateRunnable',
    ],
    'qualified Core manifest consumer',
  );
  exactObject(
    qualification,
    [
      'schema',
      'manifestRoot',
      'artifactRoot',
      'identity',
      'targetCheckout',
      'checks',
      'promotionAuthority',
      'promotionAuthorityRoot',
      'receiptRoot',
    ],
    'qualified Core qualification',
  );
  exactObject(
    qualification.identity,
    compatibilityV2
      ? [
          'producerRepository',
          'producerCommit',
          'targetRepository',
          'targetCommit',
          'compatibilityRoot',
          'compatibilityMode',
          'equivalenceReceiptRoot',
        ]
      : [
          'producerRepository',
          'producerCommit',
          'targetRepository',
          'targetCommit',
          'compatibilityMode',
          'equivalenceReceiptRoot',
        ],
    'qualified Core qualification identity',
  );
  exactObject(
    qualification.targetCheckout,
    ['commit', 'clean'],
    'qualified Core qualification target checkout',
  );
  exactObject(
    qualification.checks,
    compatibilityV2
      ? [
          'artifactDigest',
          'boundedPaths',
          'safeSymlinks',
          'platformAndAbi',
          'buildIdentity',
          'sourceIdentity',
          'compatibilityIdentity',
          'checkoutCleanliness',
        ]
      : [
          'artifactDigest',
          'boundedPaths',
          'safeSymlinks',
          'platformAndAbi',
          'buildIdentity',
          'sourceIdentity',
          'checkoutCleanliness',
        ],
    'qualified Core qualification checks',
  );
  exactObject(
    qualification.promotionAuthority,
    [
      'schema',
      'mode',
      'repository',
      'targetCommit',
      'protectedRef',
      'deliveryEvidenceRoot',
      'authorityCandidates',
      'status',
      'validFrom',
      'validThrough',
    ],
    'qualified Core promotion authority',
  );
}

export async function verifyQualifiedAssignmentCoreArtifact({
  manifest,
  qualification,
  equivalence = null,
  payloads,
  expected,
  root = ROOT,
}) {
  const cacheContract = readJson(path.join(root, rel(CONTRACT_PATH)));
  const paths = qualifiedArtifactPaths(root, cacheContract);
  const legacy =
    manifest.schema === 'shifu.qualified-assignment-core-artifact/v1';
  if (
    legacy &&
    Date.parse(expected.now) >
      Date.parse(paths.qualified.migration.v1ExactCommitReadThrough)
  ) {
    throw new Error('qualified Assignment Core v1 migration window has closed');
  }
  const Ajv2020 = await loadAjv2020();
  if (Ajv2020) {
    const ajv = ajv2020(Ajv2020);
    validateOrThrow(
      ajv.compile(
        readJson(
          legacy ? paths.legacyManifestSchemaPath : paths.manifestSchemaPath,
        ),
      ),
      manifest,
      'qualified Assignment Core manifest',
    );
    validateOrThrow(
      ajv.compile(
        readJson(
          legacy
            ? paths.legacyQualificationSchemaPath
            : paths.qualificationSchemaPath,
        ),
      ),
      qualification,
      'qualified Assignment Core qualification receipt',
    );
  } else {
    validateQualifiedCoreDocumentShape(manifest, qualification);
  }

  const entries = manifest.payload.entries;
  const declaredPaths = entries.map((entry) => entry.path);
  assert.deepEqual(
    declaredPaths,
    [...declaredPaths].sort(),
    'payload entries must be sorted by path',
  );
  assert.equal(
    new Set(declaredPaths).size,
    declaredPaths.length,
    'payload entries must have unique paths',
  );
  assert.deepEqual(
    Object.keys(payloads).sort(),
    declaredPaths,
    'payload bytes must match the manifest path set exactly',
  );
  for (const entry of entries) {
    assert.equal(
      path.posix.normalize(entry.path),
      entry.path,
      `payload path is not normalized: ${entry.path}`,
    );
    assert.notEqual(entry.path, '.', 'payload path cannot name the root');
    if (entry.type === 'regular-file') {
      const bytes = payloadBytes(payloads[entry.path], entry.path);
      assert.equal(
        bytes.byteLength,
        entry.sizeBytes,
        `${entry.path} size drift`,
      );
      assert.equal(
        `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
        entry.digest,
        `${entry.path} digest drift`,
      );
      continue;
    }
    assert.equal(
      payloads[entry.path],
      entry.linkTarget,
      `${entry.path} symlink target drift`,
    );
    assert.ok(
      !path.posix.isAbsolute(entry.linkTarget) &&
        !entry.linkTarget.includes('\\') &&
        !entry.linkTarget.includes('\0'),
      `${entry.path} symlink target is unsafe`,
    );
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(entry.path), entry.linkTarget),
    );
    assert.ok(
      resolved !== '..' && !resolved.startsWith('../'),
      `${entry.path} symlink escapes the payload`,
    );
    assert.ok(
      declaredPaths.includes(resolved),
      `${entry.path} symlink target is absent from the payload`,
    );
    const linkBytes = Buffer.from(entry.linkTarget);
    assert.equal(
      linkBytes.byteLength,
      entry.sizeBytes,
      `${entry.path} symlink size drift`,
    );
    assert.equal(
      `sha256:${crypto.createHash('sha256').update(linkBytes).digest('hex')}`,
      entry.digest,
      `${entry.path} symlink digest drift`,
    );
  }

  const computedArtifactRoot = qualifiedAssignmentCoreRoot({
    schema: 'shifu.qualified-assignment-core-payload/v1',
    entries,
  });
  exactExpected(
    manifest.payload.artifactRoot,
    computedArtifactRoot,
    'artifactRoot',
  );
  exactExpected(manifest.manifestRoot, manifestRoot(manifest), 'manifestRoot');
  exactExpected(
    qualification.receiptRoot,
    receiptRoot(qualification),
    'qualification receiptRoot',
  );
  exactExpected(
    qualification.promotionAuthorityRoot,
    qualifiedAssignmentCoreRoot(qualification.promotionAuthority),
    'qualification promotionAuthorityRoot',
  );
  exactExpected(
    manifest.promotionAuthorityRoot,
    qualification.promotionAuthorityRoot,
    'manifest promotionAuthorityRoot',
  );
  exactExpected(
    manifest.qualificationReceiptRoot,
    qualification.receiptRoot,
    'manifest qualificationReceiptRoot',
  );
  exactExpected(
    qualification.manifestRoot,
    manifest.manifestRoot,
    'qualification manifestRoot',
  );
  exactExpected(
    qualification.artifactRoot,
    manifest.payload.artifactRoot,
    'qualification artifactRoot',
  );

  const identity = qualification.identity;
  exactExpected(
    identity.producerRepository,
    manifest.producer.repository,
    'qualification producerRepository',
  );
  exactExpected(
    identity.producerCommit,
    manifest.producer.commit,
    'qualification producerCommit',
  );
  exactExpected(
    identity.targetRepository,
    manifest.target.repository,
    'qualification targetRepository',
  );
  exactExpected(
    identity.targetCommit,
    manifest.target.commit,
    'qualification targetCommit',
  );
  exactExpected(
    identity.compatibilityMode,
    manifest.compatibility.mode,
    'qualification compatibilityMode',
  );
  exactExpected(
    identity.equivalenceReceiptRoot,
    manifest.compatibility.equivalenceReceiptRoot,
    'qualification equivalenceReceiptRoot',
  );
  const compatibilityV2 =
    manifest.schema === 'shifu.qualified-assignment-core-artifact/v2';
  if (compatibilityV2) {
    exactExpected(
      manifest.compatibility.schema,
      'kungfu.qualified-assignment-core-compatibility/v2',
      'compatibility schema',
    );
    exactExpected(
      identity.compatibilityRoot,
      manifest.compatibility.root,
      'qualification compatibilityRoot',
    );
    exactExpected(
      manifest.build.nativeInputRoot,
      manifest.compatibility.root,
      'v2 native input compatibility root',
    );
    exactExpected(
      manifest.compatibility.root,
      expected.compatibilityRoot,
      'current compatibility root',
    );
    exactExpected(
      manifest.build.nativeClosureRoot,
      expected.nativeClosureRoot,
      'native closure root',
    );
    exactExpected(
      manifest.build.compatibilityPolicyRoot,
      expected.compatibilityPolicyRoot,
      'compatibility policy root',
    );
  }
  if (manifest.compatibility.mode === 'exact-commit') {
    exactExpected(
      manifest.producer.repository,
      manifest.target.repository,
      'exact-commit producer repository identity',
    );
    exactExpected(
      manifest.producer.commit,
      manifest.target.commit,
      'exact-commit producer identity',
    );
    exactExpected(
      manifest.compatibility.equivalenceReceiptRoot,
      null,
      'exact-commit equivalenceReceiptRoot',
    );
    exactExpected(
      qualification.promotionAuthority.mode,
      'protected-dev-direct',
      'exact-commit promotion mode',
    );
    exactExpected(equivalence, null, 'exact-commit equivalence document');
  } else {
    assert.ok(
      manifest.producer.repository !== manifest.target.repository ||
        manifest.producer.commit !== manifest.target.commit,
      'explicit equivalence must preserve distinct producer and target identities',
    );
    assert.match(
      manifest.compatibility.equivalenceReceiptRoot,
      /^sha256:[0-9a-f]{64}$/,
      'explicit equivalence receipt is absent',
    );
    exactExpected(
      qualification.promotionAuthority.mode,
      'protected-dev-reused-proof',
      'explicit-equivalence promotion mode',
    );
    if (compatibilityV2) {
      assert.ok(equivalence, 'explicit equivalence document is absent');
      exactObject(
        equivalence,
        ['schema', 'producer', 'target', 'comparison', 'receiptRoot'],
        'qualified Core equivalence receipt',
      );
      exactObject(
        equivalence.producer,
        ['repository', 'commit', 'tree', 'sourceTreeRoot', 'compatibilityRoot'],
        'qualified Core equivalence producer',
      );
      exactObject(
        equivalence.target,
        ['repository', 'commit', 'tree', 'sourceTreeRoot', 'compatibilityRoot'],
        'qualified Core equivalence target',
      );
      exactObject(
        equivalence.comparison,
        [
          'method',
          'nativeClosureRoot',
          'dependencyLockDigest',
          'shifuContractRoot',
          'buildchainContractRoot',
          'compatibilityPolicyRoot',
        ],
        'qualified Core equivalence comparison',
      );
      const { receiptRoot: _receiptRoot, ...equivalenceBody } = equivalence;
      exactExpected(
        equivalence.schema,
        'kungfu.qualified-assignment-core-equivalence-receipt/v1',
        'equivalence schema',
      );
      exactExpected(
        equivalence.receiptRoot,
        qualifiedAssignmentCoreRoot(equivalenceBody),
        'equivalence receipt root',
      );
      exactExpected(
        equivalence.receiptRoot,
        manifest.compatibility.equivalenceReceiptRoot,
        'manifest equivalence receipt root',
      );
      exactExpected(
        equivalence.producer.repository,
        manifest.producer.repository,
        'equivalence producer repository',
      );
      exactExpected(
        equivalence.producer.commit,
        manifest.producer.commit,
        'equivalence producer commit',
      );
      exactExpected(
        equivalence.producer.sourceTreeRoot,
        manifest.producer.sourceTreeRoot,
        'equivalence producer source tree',
      );
      exactExpected(
        equivalence.producer.sourceTreeRoot,
        qualifiedAssignmentCoreRoot({
          schema: 'kungfu.git-source-tree/v1',
          tree: equivalence.producer.tree,
        }),
        'equivalence producer tree preimage',
      );
      exactExpected(
        equivalence.producer.compatibilityRoot,
        manifest.compatibility.root,
        'equivalence producer compatibility',
      );
      exactExpected(
        equivalence.target.repository,
        manifest.target.repository,
        'equivalence target repository',
      );
      exactExpected(
        equivalence.target.commit,
        manifest.target.commit,
        'equivalence target commit',
      );
      exactExpected(
        equivalence.target.compatibilityRoot,
        manifest.compatibility.root,
        'equivalence target compatibility',
      );
      exactExpected(
        equivalence.target.sourceTreeRoot,
        qualifiedAssignmentCoreRoot({
          schema: 'kungfu.git-source-tree/v1',
          tree: equivalence.target.tree,
        }),
        'equivalence target tree preimage',
      );
      exactExpected(
        equivalence.target.sourceTreeRoot,
        expected.targetSourceTreeRoot,
        'current equivalence target source tree',
      );
      exactExpected(
        equivalence.target.commit,
        expected.targetCommit,
        'current equivalence target commit',
      );
      exactExpected(
        equivalence.comparison.method,
        'independent-native-closure-recomputation',
        'equivalence comparison method',
      );
      for (const [actual, wanted, field] of [
        [
          equivalence.comparison.nativeClosureRoot,
          expected.nativeClosureRoot,
          'equivalence native closure',
        ],
        [
          equivalence.comparison.dependencyLockDigest,
          expected.dependencyLockDigest,
          'equivalence dependency locks',
        ],
        [
          equivalence.comparison.shifuContractRoot,
          expected.shifuContractRoot,
          'equivalence Shifu contract',
        ],
        [
          equivalence.comparison.buildchainContractRoot,
          expected.buildchainContractRoot,
          'equivalence Buildchain contract',
        ],
        [
          equivalence.comparison.compatibilityPolicyRoot,
          expected.compatibilityPolicyRoot,
          'equivalence compatibility policy',
        ],
      ]) {
        exactExpected(actual, wanted, field);
      }
    }
  }

  exactExpected(
    qualification.targetCheckout.commit,
    manifest.target.commit,
    'qualification target checkout commit',
  );
  exactExpected(
    qualification.targetCheckout.clean,
    true,
    'qualification target checkout cleanliness',
  );
  exactExpected(
    expected.checkoutClean,
    true,
    'current target checkout cleanliness',
  );

  for (const [actual, wanted, field] of [
    [
      manifest.producer.repository,
      expected.producerRepository,
      'producer repository',
    ],
    [
      manifest.target.repository,
      expected.targetRepository,
      'target repository',
    ],
    [manifest.producer.commit, expected.producerCommit, 'producer commit'],
    [manifest.target.commit, expected.targetCommit, 'target commit'],
    [
      manifest.producer.sourceTreeRoot,
      expected.sourceTreeRoot,
      'source tree root',
    ],
    [
      manifest.build.nativeInputRoot,
      expected.nativeInputRoot,
      'native input root',
    ],
    [
      manifest.build.operatingSystem,
      expected.operatingSystem,
      'operating system',
    ],
    [manifest.build.architecture, expected.architecture, 'architecture'],
    [manifest.build.pythonAbi, expected.pythonAbi, 'Python ABI'],
    [manifest.build.profile, expected.profile, 'build profile'],
    [
      manifest.build.toolchainDigest,
      expected.toolchainDigest,
      'toolchain digest',
    ],
    [
      manifest.build.dependencyLockDigest,
      expected.dependencyLockDigest,
      'dependency lock digest',
    ],
    [
      manifest.contracts.shifu.version,
      expected.shifuContractVersion,
      'Shifu contract version',
    ],
    [
      manifest.contracts.shifu.root,
      expected.shifuContractRoot,
      'Shifu contract root',
    ],
    [
      manifest.contracts.buildchain.version,
      expected.buildchainContractVersion,
      'Buildchain contract version',
    ],
    [
      manifest.contracts.buildchain.root,
      expected.buildchainContractRoot,
      'Buildchain contract root',
    ],
    [manifest.consumer.targetRoot, expected.targetRoot, 'consumer target root'],
  ]) {
    exactExpected(actual, wanted, field);
  }

  const promotion = qualification.promotionAuthority;
  exactExpected(
    promotion.repository,
    manifest.target.repository,
    'promotion repository',
  );
  exactExpected(
    promotion.targetCommit,
    manifest.target.commit,
    'promotion target commit',
  );
  exactExpected(
    promotion.protectedRef,
    expected.protectedRef,
    'promotion protected ref',
  );
  assert.deepEqual(
    expected.promotionAuthorityCandidates,
    [promotion.authorityCandidates[0]],
    'promotion authority must resolve to one current candidate',
  );
  const now = Date.parse(expected.now);
  const validFrom = Date.parse(promotion.validFrom);
  const validThrough = Date.parse(promotion.validThrough);
  assert.ok(Number.isFinite(now), 'expected.now must be an ISO-8601 timestamp');
  assert.ok(
    validFrom <= now && now <= validThrough,
    'promotion authority is stale or not yet active',
  );

  return {
    schema: 'shifu.qualified-assignment-core-verification/v1',
    ok: true,
    manifestRoot: manifest.manifestRoot,
    artifactRoot: manifest.payload.artifactRoot,
    qualificationReceiptRoot: qualification.receiptRoot,
    promotionAuthorityRoot: qualification.promotionAuthorityRoot,
    compatibilityMode: manifest.compatibility.mode,
    compatibilityIdentity: compatibilityV2 ? manifest.compatibility.root : null,
    transportAuthority: false,
    currentSourceFallbackRequired: false,
  };
}

export async function checkShifuCacheContract(root = ROOT) {
  const contractPath = path.join(root, rel(CONTRACT_PATH));
  const contract = readJson(contractPath);
  assert.equal(contract.schema, 'shifu.cache-contract/v1');
  assert.equal(contract.owner, 'shifu');
  assert.equal(
    contract.qualifiedAssignmentCoreTransport.availability,
    'optimization-only',
  );
  assert.equal(
    contract.qualifiedAssignmentCoreTransport.mergeCorrectness,
    'must-not-depend-on-transport-availability',
  );

  const profilePath = path.join(root, contract.authority.profileSchema);
  const resolutionPath = path.join(root, contract.authority.resolutionSchema);
  const diagnosticPath = path.join(root, contract.authority.diagnosticSchema);
  const configPlanPath = path.join(root, contract.authority.configPlanSchema);
  const decisionPath = path.join(root, contract.authority.decision);
  const qualified = qualifiedArtifactPaths(root, contract);
  for (const source of [
    profilePath,
    resolutionPath,
    diagnosticPath,
    configPlanPath,
    decisionPath,
    qualified.artifactContractPath,
    qualified.manifestSchemaPath,
    qualified.qualificationSchemaPath,
    qualified.platformMatrixPath,
    qualified.platformMatrixSchemaPath,
    qualified.decisionPath,
  ]) {
    assert.ok(
      fs.existsSync(source),
      `contract source is missing: ${rel(source)}`,
    );
  }

  const profileSchema = readJson(profilePath);
  const resolutionSchema = readJson(resolutionPath);
  const diagnosticSchema = readJson(diagnosticPath);
  const configPlanSchema = readJson(configPlanPath);
  const qualifiedManifestSchema = readJson(qualified.manifestSchemaPath);
  const qualifiedQualificationSchema = readJson(
    qualified.qualificationSchemaPath,
  );
  const qualifiedPlatformMatrixSchema = readJson(
    qualified.platformMatrixSchemaPath,
  );
  const qualifiedPlatformMatrix = qualifiedCorePlatformMatrix(root);
  assert.equal(profileSchema.$id, contract.schemaIds.profile);
  assert.equal(resolutionSchema.$id, contract.schemaIds.resolution);
  assert.equal(diagnosticSchema.$id, contract.schemaIds.diagnostic);
  assert.equal(configPlanSchema.$id, contract.schemaIds.configPlan);
  assert.equal(
    qualifiedManifestSchema.$id,
    qualified.qualified.schemaIds.manifest,
  );
  assert.equal(
    qualifiedQualificationSchema.$id,
    qualified.qualified.schemaIds.qualificationReceipt,
  );
  assert.equal(
    qualifiedPlatformMatrixSchema.$id,
    qualified.qualified.schemaIds.platformMatrix,
  );

  const dispatchMarkers = [
    ['shifu', 'if [ "${1:-}" = "cache" ]; then'],
    ['shifu.cmd', 'if /i "%~1"=="cache" goto delegate'],
  ];
  for (const [source, marker] of dispatchMarkers) {
    assert.match(
      fs.readFileSync(path.join(root, source), 'utf8'),
      new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${source} does not route the cache command`,
    );
  }
  const nativeLauncher = fs.readFileSync(
    path.join(root, 'crates/shifu/src/main.rs'),
    'utf8',
  );
  const nativeSubcommands = nativeLauncher.match(
    /const L2_SUBCOMMANDS:[^=]+=\s*&\[(?<commands>[\s\S]*?)\];/,
  );
  assert.ok(
    nativeSubcommands?.groups?.commands.includes('"cache"'),
    'crates/shifu/src/main.rs does not route the cache command',
  );

  const exampleDir = path.join(root, 'docs', 'shifu', 'examples');
  const Ajv2020 = await loadAjv2020();
  let validFixtures = 0;
  let rejectedFixtures = 0;
  if (Ajv2020) {
    const ajv = ajv2020(Ajv2020);
    const validateProfile = ajv.compile(profileSchema);
    const validateResolution = ajv.compile(resolutionSchema);
    ajv.compile(qualifiedManifestSchema);
    ajv.compile(qualifiedQualificationSchema);
    validateOrThrow(
      ajv.compile(qualifiedPlatformMatrixSchema),
      qualifiedPlatformMatrix,
      'qualified Assignment Core platform matrix',
    );
    for (const name of [
      'development.cache-profile.json',
      'self-hosted-runner.cache-profile.json',
    ]) {
      validateOrThrow(
        validateProfile,
        readJson(path.join(exampleDir, name)),
        name,
      );
    }
    validateOrThrow(
      validateResolution,
      readJson(path.join(exampleDir, 'cache-resolution.json')),
      'cache-resolution.json',
    );
    validFixtures = 3;

    for (const name of [
      'embedded-credential.cache-profile.json',
      'required-with-fallback.cache-profile.json',
    ]) {
      const fixture = readJson(path.join(exampleDir, 'invalid', name));
      assert.equal(
        validateProfile(fixture),
        false,
        `negative fixture unexpectedly passed: ${name}`,
      );
    }
    rejectedFixtures = 2;
  } else {
    console.warn(
      '[shifu-cache] ajv not installed; skipped schema/fixture validation ' +
        '(structural + private-IP leak checks still ran). Run `pnpm install` to ' +
        'enable it locally; CI enforces the full schema/fixture validation.',
    );
  }

  const publicJson = fs
    .readdirSync(exampleDir, { recursive: true })
    .filter((name) => String(name).endsWith('.json'))
    .map((name) => fs.readFileSync(path.join(exampleDir, String(name)), 'utf8'))
    .join('\n');
  assert.doesNotMatch(publicJson, /\b(?:10|127)\.\d+\.\d+\.\d+\b/);
  assert.doesNotMatch(publicJson, /\b192\.168\.\d+\.\d+\b/);
  assert.doesNotMatch(publicJson, /\b172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+\b/);

  const trackedLocks = [];
  const gitIndex = spawnSync('git', ['ls-files', '-z', '*uv.lock'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(
    gitIndex.status,
    0,
    gitIndex.stderr || 'cannot list tracked uv.lock files',
  );
  for (const relative of gitIndex.stdout.split('\0').filter(Boolean)) {
    const violations = publicUvLockViolations(
      fs.readFileSync(path.join(root, relative), 'utf8'),
    );
    assert.deepEqual(
      violations,
      [],
      `${relative} must contain only official PyPI registry and artifact URLs`,
    );
    trackedLocks.push(relative);
  }
  assert.ok(
    trackedLocks.length > 0,
    'repository must track at least one uv.lock',
  );

  return {
    contract: rel(contractPath),
    profileSchema: rel(profilePath),
    resolutionSchema: rel(resolutionPath),
    diagnosticSchema: rel(diagnosticPath),
    configPlanSchema: rel(configPlanPath),
    artifactContract: rel(qualified.artifactContractPath),
    qualifiedArtifactSchema: rel(qualified.manifestSchemaPath),
    qualifiedQualificationSchema: rel(qualified.qualificationSchemaPath),
    qualifiedPlatformMatrix: rel(qualified.platformMatrixPath),
    qualifiedPlatformMatrixSchema: rel(qualified.platformMatrixSchemaPath),
    validFixtures,
    rejectedFixtures,
  };
}

async function main() {
  const result = await checkShifuCacheContract();
  console.log(
    `[shifu-cache] contract=${result.contract} valid=${result.validFixtures} rejected=${result.rejectedFixtures}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
