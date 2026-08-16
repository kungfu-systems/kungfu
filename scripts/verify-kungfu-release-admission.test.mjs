// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BUILDCHAIN_CONTROLLER_EVIDENCE_CONTRACT,
  controllerEvidenceDigest,
} from '@kungfu-tech/buildchain/controller-evidence';
import { resolvePublishedKfdAdopterCategoryProfiles } from '@kungfu-tech/buildchain/kfd-adopter-category-driver';
import {
  createConsumerPublicationDecision,
  createPublicationAdmission,
  createPublicationArtifactManifestSet,
  createPublicationControlPlaneAudit,
  createPublicationQualificationReceipt,
  createRunnerProvenance,
  publicationAuthorityDigest,
  verifyPublicationQualificationReceipt,
} from '@kungfu-tech/buildchain/publication-authority';
import { sha256Json } from '@kungfu-tech/buildchain/release-candidate';
import { initAdopterManifest } from '@kungfu-tech/kfd/adopter-conformance/toolchain';
import { semanticRoot } from '@kungfu-tech/kfd/scripts/self-conformance-contract.mjs';
import {
  createKungfuKfdProductRuntimeCategoryRequest,
  evaluateKungfuKfdProductRuntimeCategory,
} from '../framework/release/buildchain-kfd-runtime.mjs';
import {
  KUNGFU_PUBLICATION_PREDICATE_ID,
  createKungfuConsumerPublicationDecision,
} from './kungfu-release-qualification.mjs';
import {
  buildGatePlan,
  gateActionId,
  gateDefinitionDigest,
  gateDigest,
} from './shifu-gate-runtime.mjs';
import {
  temporalAdmissionFactProjection,
  validatePrimitiveCatalogPromotion,
  verifyKungfuReleaseAdmission,
} from './verify-kungfu-release-admission.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_SHA = '1'.repeat(40);
const RELEASE_POLICY = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'docs/qualification/gates/release-admission-policy.json'),
    'utf8',
  ),
);
const RUNTIME_SHA = RELEASE_POLICY.buildchain.runtimes.alpha.runtimeSha;
const PUBLICATION_RUNTIME_SHA =
  RELEASE_POLICY.buildchain.runtimes.alpha.publicationRuntimeSha;
const RETIRED_PUBLICATION_RUNTIME_SHA =
  '21030efd277301d642fd9baaa1bd75f02dd3ddc6';
const STABLE_RUNTIME_SHA =
  RELEASE_POLICY.buildchain.runtimes.release.runtimeSha;
const SOURCE_TREE_SHA = 'a'.repeat(40);
const CONTRACT_DIGEST =
  RELEASE_POLICY.buildchain.runtimes.alpha.contractDigest.replace(
    /^sha256:/u,
    '',
  );
const RECOVERED_CONTRACT_DIGEST =
  RELEASE_POLICY.buildchain.runtimes.alpha.publicationContractDigests[1].replace(
    /^sha256:/u,
    '',
  );
const STABLE_CONTRACT_DIGEST =
  RELEASE_POLICY.buildchain.runtimes.release.contractDigest.replace(
    /^sha256:/u,
    '',
  );
const PREDICATE_COMMAND = 'node scripts/kungfu-release-qualification.mjs';
const PREDICATE_DIGEST = crypto
  .createHash('sha256')
  .update(PREDICATE_COMMAND)
  .digest('hex');

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
}

test('temporal release admission has exact legacy/proof parity and protected proof evidence', () => {
  const contract = readJson(
    'framework/release/kungfu-temporal-release-admission.contract.json',
  );
  const factProjection = temporalAdmissionFactProjection(ROOT, RELEASE_POLICY);
  for (const channel of RELEASE_POLICY.publication.channels) {
    assert.deepEqual(
      factProjection.channels[channel],
      [
        ...RELEASE_POLICY.buildchain.runtimes[channel]
          .publicationContractDigests,
      ].sort(),
    );
  }
  const projection = readJson(
    'docs/qualification/evidence/buildchain-compatibility-proof-projection.json',
  );
  assert.equal(contract.maximumPathDepth, 2);
  assert.equal(contract.rollbackMode, 'legacy-exact');
  assert.equal(
    contract.factAuthority.admittedDigests,
    'derived-from-active-proof-records',
  );
  assert.equal(contract.safety.realPublicationRequired, false);
  assert.equal(
    projection.source.sourceCommit,
    '913b5d3fc486e225cf19f6e677129434db4850a6',
  );
  assert.equal(
    projection.source.mergeCommit,
    '10745d50aa93192c06b13f76942c4c291b482518',
  );
  assert.equal(projection.proofs.length, 3);
  assert.equal(new Set(projection.registry.proofRoots).size, 5);
});

test('release admission denies promoted primitive without complete receipts', () => {
  const languageStates = Object.fromEntries(
    ['cpp', 'python', 'node', 'rust'].map((language) => [
      language,
      { state: language === 'cpp' ? 'proved' : 'missing' },
    ]),
  );
  const promotionEvidence = Object.fromEntries(
    ['contract', 'vectors', 'invariants', 'dogfoodReceipts'].map((kind) => [
      kind,
      { state: kind === 'contract' ? 'present' : 'missing' },
    ]),
  );
  assert.throws(
    () =>
      validatePrimitiveCatalogPromotion({
        primitives: [
          {
            id: 'incomplete-release-primitive',
            admission: {
              summary: { state: 'admitted' },
              languageStates,
              evidence: promotionEvidence,
            },
          },
        ],
      }),
    /missing-language-proof:rust.*missing-promotion-evidence:dogfoodReceipts/,
  );
});

const PRODUCT_RUNTIME_OBSERVED_AT = '2026-08-13T12:00:00Z';
const PRODUCT_RUNTIME_PACKAGE_ROOT = `sha256:${'c'.repeat(64)}`;

function productRuntimeRooted(label) {
  return semanticRoot({ label });
}

function productRuntimeFixture({ adopterId = 'kungfu-systems/kungfu' } = {}) {
  const artifact = {
    kind: 'git-commit',
    coordinate: `${adopterId}@${SOURCE_SHA}`,
    root: productRuntimeRooted(`${adopterId}:source-tree`),
  };
  const release = {
    kind: 'release',
    coordinate: `https://example.invalid/${adopterId}/releases/alpha`,
    root: productRuntimeRooted(`${adopterId}:release-passport`),
  };
  const adopterManifest = initAdopterManifest({
    manifestId: `${adopterId}:full-cut`,
    adopterId,
    artifactKind: artifact.kind,
    artifactCoordinate: artifact.coordinate,
    artifactRoot: artifact.root,
    scope: 'Product runtime, KFX, release, and recovery evidence',
    packageArtifactRoot: PRODUCT_RUNTIME_PACKAGE_ROOT,
    verifiedAt: PRODUCT_RUNTIME_OBSERVED_AT,
    maxAgeSeconds: 3600,
  });
  adopterManifest.releaseBindings.push({
    id: `${adopterId}:alpha`,
    artifact: structuredClone(artifact),
    releasePassport: structuredClone(release),
    kfdPackageRoot: PRODUCT_RUNTIME_PACKAGE_ROOT,
  });

  const selection = {
    schemaVersion: 1,
    contract: 'kfd.adopter-category-profile-selection/v1',
    profiles: [
      {
        id: 'kfd.adopter-category/product-runtime',
        version: '1.0.0',
      },
    ],
  };
  const resolution = resolvePublishedKfdAdopterCategoryProfiles(selection);
  assert.equal(resolution.valid, true);
  const project = {
    adopterId,
    source: structuredClone(artifact),
    artifact: structuredClone(artifact),
    release: structuredClone(release),
  };
  const projectRoot = semanticRoot(project);
  const adopterManifestRoot = semanticRoot(adopterManifest);
  const evidenceBinding = {
    observedAt: PRODUCT_RUNTIME_OBSERVED_AT,
    projectInstanceId: `${adopterId}@${SOURCE_SHA}`,
    projectRoot,
    adopterManifestRoot,
    kfdPackageRoot: PRODUCT_RUNTIME_PACKAGE_ROOT,
    categorySelectionRoot: resolution.selectionRoot,
  };
  const instanceManifest = {
    $schema:
      'https://kfd.libkungfu.dev/schemas/kfd-adopter-conformance/category-instance-manifest.schema.json',
    schemaVersion: 1,
    contract: 'kfd.adopter-category-instance-manifest/v1',
    instanceId: evidenceBinding.projectInstanceId,
    rootAlgorithm: 'sha256-kfd-canonical-json-v1',
    project,
    adopterManifest: {
      contract: 'kfd.adopter-conformance-manifest/v1',
      manifestId: adopterManifest.manifestId,
      root: adopterManifestRoot,
    },
    kfdCut: {
      packageVersion: adopterManifest.kfdCut.package.version,
      packageRoot: PRODUCT_RUNTIME_PACKAGE_ROOT,
      categoryCatalogRoot: resolution.catalogRoot,
    },
    selection,
    selectionRoot: resolution.selectionRoot,
    requirements: resolution.requirements.map((requirement) => ({
      id: requirement.id,
      evidence: requirement.evidenceKinds.map((kind) => ({
        kind,
        coordinate: `${artifact.coordinate}#${requirement.id}/${kind}`,
        root: productRuntimeRooted(`${adopterId}:${requirement.id}:${kind}`),
        ...evidenceBinding,
      })),
    })),
    claimBoundary: {
      categoryConformanceIsDeclarationOnly: true,
      evidenceTransfer: false,
      runtimePermission: false,
      releaseAuthorization: false,
      independentCertification: false,
      semanticAuthorityTransfer: false,
    },
  };
  return { adopterManifest, instanceManifest };
}

test('common gate accepts Kungfu as an ordinary product-runtime instance', () => {
  const value = productRuntimeFixture();
  const result = evaluateKungfuKfdProductRuntimeCategory({
    ...value,
    verifiedAt: PRODUCT_RUNTIME_OBSERVED_AT,
    maxAgeSeconds: 3600,
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.issues));
  assert.equal(result.qualifying, false);
  assert.equal(result.selfCertified, false);
  assert.equal(result.semanticReport.valid, true);
  assert.deepEqual(result.issues, []);
});

test('the same category evaluator accepts another project identity', () => {
  const value = productRuntimeFixture({
    adopterId: 'example.org/other-product',
  });
  const request = createKungfuKfdProductRuntimeCategoryRequest(
    value.instanceManifest,
  );
  assert.equal(request.project.adopterId, 'example.org/other-product');
  const result = evaluateKungfuKfdProductRuntimeCategory({
    ...value,
    verifiedAt: PRODUCT_RUNTIME_OBSERVED_AT,
    maxAgeSeconds: 3600,
  });
  assert.equal(result.status, 'passed', JSON.stringify(result.issues));
});

test('product-runtime substitution and stale evidence fail closed', () => {
  const substituted = productRuntimeFixture();
  substituted.instanceManifest.project.artifact.root =
    productRuntimeRooted('substitution');
  const substitutionResult = evaluateKungfuKfdProductRuntimeCategory({
    ...substituted,
    verifiedAt: PRODUCT_RUNTIME_OBSERVED_AT,
    maxAgeSeconds: 3600,
  });
  assert.equal(substitutionResult.status, 'failed');
  assert.equal(
    substitutionResult.issues.some(
      ({ code }) => code === 'acp-instance-binding-mismatch',
    ),
    true,
  );

  const stale = productRuntimeFixture();
  const staleResult = evaluateKungfuKfdProductRuntimeCategory({
    ...stale,
    verifiedAt: '2026-08-13T14:00:00Z',
    maxAgeSeconds: 60,
  });
  assert.equal(staleResult.status, 'failed');
  assert.equal(
    staleResult.issues.some(({ code }) => code === 'acp-evidence-stale'),
    true,
  );
});

function manifestSummaryDigest(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files)
    hash.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
  return hash.digest('hex');
}

function fixture(options = {}) {
  const channel = options.channel || 'alpha';
  const runtimeSha =
    options.runtimeSha ||
    (channel === 'alpha' ? RUNTIME_SHA : STABLE_RUNTIME_SHA);
  const publicationRuntimeSha =
    options.publicationRuntimeSha ||
    (channel === 'alpha' ? PUBLICATION_RUNTIME_SHA : STABLE_RUNTIME_SHA);
  const contractDigest =
    options.contractDigest ||
    (channel === 'alpha' ? CONTRACT_DIGEST : STABLE_CONTRACT_DIGEST);
  const registry = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'shifu.gates.json'), 'utf8'),
  );
  const registryDigest = gateDigest(registry);
  const plan = buildGatePlan(registry, 'release-promotion', {
    digest: registryDigest,
  });
  const matrixDigest = publicationAuthorityDigest({
    profile: 'release-promotion',
    registryDigest,
    requiredPlatforms: [
      'linux-x64',
      'linux-arm64',
      'macos-arm64',
      'windows-x64',
    ],
  });
  const gates = plan.groups.flatMap((group) =>
    group.gates.map((gate) => {
      const definition = registry.gates.find((item) => item.id === gate.id);
      return {
        platformId: 'fixture',
        gateId: gate.id,
        mode: gate.mode,
        status: 'passed',
        attempted: true,
        definitionDigest: gateDefinitionDigest(definition),
        actionId: gateActionId(definition),
        issues: [],
      };
    }),
  );
  const aggregatePayload = {
    contract: 'buildchain.shifu-gate-aggregate/v1',
    profile: 'release-promotion',
    sourceSha: SOURCE_SHA,
    registry: {
      ref: 'shifu.gates.json',
      digest: registryDigest,
      projectId: 'kungfu',
    },
    matrixDigest,
    status: 'pass',
    ok: true,
    qualifying: true,
    receipts: ['linux-x64', 'linux-arm64', 'macos-arm64', 'windows-x64'].map(
      (platform) => ({
        platformId: platform,
        platform: { id: platform, os: platform.split('-')[0] },
        status: 'passed',
        qualifying: true,
        issues: [],
      }),
    ),
    gates,
    omitted: [],
    issues: [],
  };
  const gateAggregate = {
    ...aggregatePayload,
    digest: `sha256:${publicationAuthorityDigest(aggregatePayload)}`,
  };
  const runnerProvenance = createRunnerProvenance({
    runnerClass: 'ephemeral',
    os: 'linux',
    architecture: 'x64',
    imageDigest: '7'.repeat(64),
    measurementDigest: '8'.repeat(64),
    isolation: 'fresh-vm-per-job',
  });
  const controlPlaneAudit = createPublicationControlPlaneAudit({
    repository: 'kungfu-systems/kungfu',
    workflowPath: '.github/workflows/.release-candidate-promote.yml',
    publisherWorkflowPath: '.github/workflows/release-new-version.yml',
    environment: 'none',
    facts: [
      'actions-policy',
      'branch-policy',
      'environment-policy',
      'oidc-policy',
      'publisher-policy',
      'runner-policy',
    ].map((id, index) => ({
      id,
      status: 'pass',
      digest: String(index + 1).repeat(64),
    })),
    observedAt: '2026-07-15T00:00:00.000Z',
    expiresAt: '2026-07-15T00:12:00.000Z',
  });
  const controllerPayload = {
    schemaVersion: 1,
    contract: BUILDCHAIN_CONTROLLER_EVIDENCE_CONTRACT,
    kind: 'receipt',
    controller: { id: 'build-lifecycle' },
    source: { repository: 'kungfu-systems/kungfu', sha: SOURCE_SHA },
    runtime: {
      ref: runtimeSha,
      sha: runtimeSha,
      contractDigest: `sha256:${contractDigest}`,
    },
    planDigest: `sha256:${'b'.repeat(64)}`,
    status: 'passed',
    qualifying: true,
    stages: [],
    evidence: [],
    issues: [],
  };
  const controllerReceipt = {
    ...controllerPayload,
    digest: controllerEvidenceDigest(controllerPayload),
  };
  const buildSummary = {};
  const files = [
    {
      path: '.buildchain/artifacts/linux-x64/diagnostics.json',
      size: 4,
      sha256: 'b'.repeat(64),
    },
    { path: 'product/release/kungfu.tgz', size: 3, sha256: '6'.repeat(64) },
  ];
  const artifactManifests = [
    {
      schemaVersion: 1,
      contract: 'kungfu-buildchain-artifact',
      artifactName: 'kungfu-linux-x64',
      platform: { id: 'linux-x64' },
      git: { repository: 'kungfu-systems/kungfu', sha: SOURCE_SHA },
      summary: {
        contract: 'kungfu-buildchain-artifact-summary',
        artifactName: 'kungfu-linux-x64',
        platform: { id: 'linux-x64' },
        fileCount: files.length,
        totalBytes: 7,
        digest: manifestSummaryDigest(files),
      },
      expectedArtifacts: { ok: true },
      files,
    },
  ];
  const artifactPayloads = [
    {
      artifactName: 'kungfu-linux-x64',
      files: [{ ...files[1] }],
    },
  ];
  const manifestSet = createPublicationArtifactManifestSet({
    repository: 'kungfu-systems/kungfu',
    sourceSha: SOURCE_SHA,
    sourceTreeSha: SOURCE_TREE_SHA,
    manifests: artifactManifests,
    payloads: artifactPayloads,
  });
  const releaseCandidatePassport = {
    schemaVersion: 1,
    contract: 'kungfu-buildchain-release-candidate-passport',
    repository: 'kungfu-systems/kungfu',
    target: { channel },
    source: {
      headSha: SOURCE_SHA,
      mergeRefSha: SOURCE_SHA,
      treeHash: SOURCE_TREE_SHA,
    },
    buildchain: { sha: runtimeSha },
    platformMatrix: [
      { platformId: 'linux-x64', artifactName: 'kungfu-linux-x64' },
    ],
    diagnostics: { buildSummaryHash: sha256Json(buildSummary) },
    gateProfileEvidence: {
      contract: gateAggregate.contract,
      digest: gateAggregate.digest,
      profile: gateAggregate.profile,
      sourceSha: gateAggregate.sourceSha,
      registry: {
        projectId: gateAggregate.registry.projectId,
        digest: gateAggregate.registry.digest,
      },
      matrixDigest: gateAggregate.matrixDigest,
      status: gateAggregate.status,
      qualifying: gateAggregate.qualifying,
      receiptCount: gateAggregate.receipts.length,
      gateResultCount: gateAggregate.gates.length,
    },
    controllerReceipts: [
      {
        controllerId: 'build-lifecycle',
        planDigest: controllerReceipt.planDigest,
        receiptDigest: controllerReceipt.digest,
        sourceSha: SOURCE_SHA,
        runtimeSha,
        status: 'passed',
      },
    ],
  };
  releaseCandidatePassport.candidateHash = sha256Json({
    repository: releaseCandidatePassport.repository,
    target: releaseCandidatePassport.target,
    source: releaseCandidatePassport.source,
    platformMatrix: releaseCandidatePassport.platformMatrix,
    buildchain: releaseCandidatePassport.buildchain,
    gateProfileEvidence: releaseCandidatePassport.gateProfileEvidence,
    controllerReceipts: releaseCandidatePassport.controllerReceipts,
  });
  const publicationEvidence = {
    sourceTreeSha: SOURCE_TREE_SHA,
    releaseCandidatePassport,
    buildSummary,
    controllerReceipt,
    gateAggregate,
    artifactManifests,
    artifactPayloads,
  };
  const admission = createPublicationAdmission({
    registryDigest: JSON.parse(
      fs.readFileSync(
        path.join(
          ROOT,
          channel === 'alpha'
            ? 'node_modules/@kungfu-tech/buildchain/dist/site/publication-authority-registry.json'
            : 'node_modules/@kungfu-tech/buildchain-stable/dist/site/publication-authority-registry.json',
        ),
        'utf8',
      ),
    ).registryDigest,
    workflowPath: '.github/workflows/.release-candidate-promote.yml',
    publisherWorkflowPath: '.github/workflows/release-new-version.yml',
    repository: 'kungfu-systems/kungfu',
    sourceSha: SOURCE_SHA,
    runtimeSha: publicationRuntimeSha,
    contractDigest,
    policyDigest: matrixDigest,
    gateRegistryDigest: registryDigest,
    controllerReceiptDigest: controllerReceipt.digest,
    runnerProvenanceDigest: runnerProvenance.receiptDigest,
    controlPlaneAuditDigest: controlPlaneAudit.receiptDigest,
    gateAggregateDigest: gateAggregate.digest,
    environment: 'none',
    product: 'Kungfu Episodes',
    target: 'github-release:kungfu-systems/kungfu',
    version: channel === 'alpha' ? '4.0.0-alpha.1' : '4.0.0',
    channel,
    artifactDigest: manifestSet.manifestSetDigest,
    nonce: 'kungfu-run-1:attempt-1:publish',
    issuedAt: '2026-07-15T00:01:00.000Z',
    expiresAt: '2026-07-15T00:10:00.000Z',
    qualification: {
      required: true,
      predicateId: KUNGFU_PUBLICATION_PREDICATE_ID,
      predicateDigest: PREDICATE_DIGEST,
    },
  });
  const expected = Object.fromEntries(
    [
      'repository',
      'publisherWorkflowPath',
      'sourceSha',
      'runtimeSha',
      'contractDigest',
      'policyDigest',
      'controllerReceiptDigest',
      'gateAggregateDigest',
      'environment',
      'product',
      'target',
      'version',
      'channel',
      'artifactDigest',
    ].map((key) => [key, admission[key]]),
  );
  return {
    root: ROOT,
    admission,
    runnerProvenance,
    controlPlaneAudit,
    publicationEvidence,
    expected,
    temporalAdmission: {
      releaseProvenance: { objectRoot: `sha256:${'9'.repeat(64)}` },
      promotionSha: SOURCE_SHA,
      qualificationRoot: `sha256:${'6'.repeat(64)}`,
      authorityRoot: `sha256:${'5'.repeat(64)}`,
    },
    temporalVerifier: ({ expected: observed, temporalAdmission }) => {
      assert.equal(observed.sourceSha, SOURCE_SHA);
      assert.match(temporalAdmission.releaseProvenance.objectRoot, /^sha256:/u);
      return {
        schema: 'kungfu.temporal-release-admission-receipt/v1',
        status: 'accepted',
        pathKind:
          observed.contractDigest === RECOVERED_CONTRACT_DIGEST
            ? 'composed'
            : 'direct',
        containsPrivatePayload: false,
        receiptRoot: `sha256:${'4'.repeat(64)}`,
      };
    },
    now: new Date('2026-07-15T00:05:00.000Z'),
  };
}

test('Kungfu independently accepts only a durable sealed qualifying capability', async () => {
  const result = await verifyKungfuReleaseAdmission(fixture());
  assert.equal(result.qualifying, true);
  assert.equal(result.capability.decision, 'allow');
  assert.equal(result.capability.runtimeSha, PUBLICATION_RUNTIME_SHA);
  assert.match(result.consumerPolicyDigest, /^[0-9a-f]{64}$/);
  assert.equal(result.temporalAdmissionReceipt.status, 'accepted');

  const recovered = await verifyKungfuReleaseAdmission(
    fixture({ contractDigest: RECOVERED_CONTRACT_DIGEST }),
  );
  assert.equal(recovered.capability.contractDigest, RECOVERED_CONTRACT_DIGEST);

  const stable = await verifyKungfuReleaseAdmission(
    fixture({
      channel: 'release',
      publicationRuntimeSha: STABLE_RUNTIME_SHA,
    }),
  );
  assert.equal(stable.capability.runtimeSha, STABLE_RUNTIME_SHA);

  await assert.rejects(
    async () =>
      verifyKungfuReleaseAdmission(
        fixture({
          channel: 'alpha',
          publicationRuntimeSha: RETIRED_PUBLICATION_RUNTIME_SHA,
        }),
      ),
    /runtimeSha policy mismatch/,
  );
  await assert.rejects(
    async () =>
      verifyKungfuReleaseAdmission(fixture({ contractDigest: 'f'.repeat(64) })),
    /contractDigest policy mismatch/,
  );
});

test('Kungfu rejects missing platform evidence and replayed or stale admission', async () => {
  const missingPlatform = fixture();
  missingPlatform.publicationEvidence.gateAggregate.receipts.pop();
  await assert.rejects(
    async () => verifyKungfuReleaseAdmission(missingPlatform),
    /missing windows-x64 qualification/,
  );

  const replayed = fixture();
  replayed.usedNonces = [replayed.admission.nonce];
  await assert.rejects(
    async () => verifyKungfuReleaseAdmission(replayed),
    /nonce was replayed/,
  );

  const stale = fixture();
  stale.now = new Date('2026-07-15T00:11:00.000Z');
  await assert.rejects(
    async () => verifyKungfuReleaseAdmission(stale),
    /stale/,
  );
});

test('Kungfu rejects policy, runner, control-plane, and artifact substitution', async () => {
  const policy = fixture();
  policy.expected.channel = 'latest';
  await assert.rejects(
    async () => verifyKungfuReleaseAdmission(policy),
    /channel is not allowed/,
  );

  const runner = fixture();
  runner.runnerProvenance.qualificationStatus = 'unqualified';
  await assert.rejects(
    async () => verifyKungfuReleaseAdmission(runner),
    /runner provenance qualification floor was not met|digest mismatch/,
  );

  const controlPlane = fixture();
  controlPlane.controlPlaneAudit.facts[0].status = 'fail';
  await assert.rejects(
    async () => verifyKungfuReleaseAdmission(controlPlane),
    /control-plane audit fact did not pass|digest mismatch/,
  );

  const artifact = fixture();
  artifact.publicationEvidence.artifactPayloads[0].files[0].sha256 = 'e'.repeat(
    64,
  );
  await assert.rejects(
    async () => verifyKungfuReleaseAdmission(artifact),
    /payload bytes do not match/,
  );
});

test('Kungfu consumer qualification seals only an exact current handoff', async () => {
  const input = fixture({ contractDigest: RECOVERED_CONTRACT_DIGEST });
  const capability = (await verifyKungfuReleaseAdmission(input)).capability;
  const gateAggregate = input.publicationEvidence.gateAggregate;
  const decision = await createKungfuConsumerPublicationDecision({
    root: ROOT,
    capability,
    gateAggregate,
    predicateId: KUNGFU_PUBLICATION_PREDICATE_ID,
    predicateDigest: PREDICATE_DIGEST,
    createDecision: createConsumerPublicationDecision,
    now: input.now,
  });
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.sourceSha, SOURCE_SHA);
  assert.equal(decision.artifactDigest, capability.artifactDigest);

  const unlistedContract = structuredClone(capability);
  unlistedContract.contractDigest = 'f'.repeat(64);
  await assert.rejects(
    async () =>
      createKungfuConsumerPublicationDecision({
        root: ROOT,
        capability: unlistedContract,
        gateAggregate,
        predicateId: KUNGFU_PUBLICATION_PREDICATE_ID,
        predicateDigest: PREDICATE_DIGEST,
        createDecision: createConsumerPublicationDecision,
        now: input.now,
      }),
    /Buildchain contract digest policy mismatch/,
  );

  const receipt = createPublicationQualificationReceipt({
    capability,
    gateAggregate,
    consumerDecision: decision,
    now: input.now,
  });
  const verified = verifyPublicationQualificationReceipt({
    receipt,
    capability,
    gateAggregate,
    expected: {
      sourceSha: SOURCE_SHA,
      runtimeSha: PUBLICATION_RUNTIME_SHA,
      artifactDigest: capability.artifactDigest,
      version: capability.version,
      channel: capability.channel,
      target: capability.target,
    },
    now: input.now,
  });
  assert.equal(verified.receiptDigest, receipt.receiptDigest);

  assert.throws(
    () =>
      verifyPublicationQualificationReceipt({
        capability,
        gateAggregate,
        now: input.now,
      }),
    /receipt contract mismatch/,
  );
  assert.throws(
    () =>
      verifyPublicationQualificationReceipt({
        receipt,
        capability,
        gateAggregate,
        usedNonces: [capability.nonce],
        now: input.now,
      }),
    /nonce was replayed/,
  );
  assert.throws(
    () =>
      verifyPublicationQualificationReceipt({
        receipt,
        capability,
        gateAggregate,
        now: new Date('2026-07-15T00:11:00.000Z'),
      }),
    /stale/,
  );

  const aggregateDrift = structuredClone(gateAggregate);
  aggregateDrift.gates[0].status = 'failed';
  assert.throws(
    () =>
      createPublicationQualificationReceipt({
        capability,
        gateAggregate: aggregateDrift,
        consumerDecision: decision,
        now: input.now,
      }),
    /aggregate digest mismatch/,
  );

  const capabilityDrift = structuredClone(capability);
  capabilityDrift.artifactDigest = 'e'.repeat(64);
  assert.throws(
    () =>
      verifyPublicationQualificationReceipt({
        receipt,
        capability: capabilityDrift,
        gateAggregate,
        now: input.now,
      }),
    /capability digest mismatch/,
  );
});
