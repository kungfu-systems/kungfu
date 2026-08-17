// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'node:module';
import {
  adopterDeliveryGateDigest,
  createAdopterDeliveryGate,
  createPackageArtifactProfile,
} from '@kungfu-tech/buildchain/adopter-delivery-gate';
import {
  KFD_ADOPTER_CATEGORY_PROTOCOL_ID,
  KFD_ADOPTER_CATEGORY_PROTOCOL_VERSION,
  createKfdAdopterCategoryProtocolDriver,
  resolvePublishedKfdAdopterCategoryProfiles,
} from '@kungfu-tech/buildchain/kfd-adopter-category-driver';
import { initAdopterManifest } from '@kungfu-tech/kfd/adopter-conformance/toolchain';
import { semanticRoot } from '@kungfu-tech/kfd/scripts/self-conformance-contract.mjs';

const require = createRequire(import.meta.url);
const corePackage = require('@kungfu-tech/core/package.json');
const coreAuthority = require('@kungfu-tech/core/node-api-authority.json');
const corePlatformContract = require('@kungfu-tech/core/core-platform-package.contract.json');
const kfdPackage = require('@kungfu-tech/kfd/package.json');
const buildchainPackage = require('@kungfu-tech/buildchain/package.json');

export const OBSERVED_AT = '2026-08-17T12:00:00.000Z';
export const ADOPTER_ID = 'example.org/field-notes';
export const INSTANCE_ID = `${ADOPTER_ID}@${'2'.repeat(40)}`;
export const KFD_PACKAGE_ROOT = semanticRoot({
  package: `${kfdPackage.name}@${kfdPackage.version}`,
  categoryCatalog: 'published-package-bytes',
});

const CLAIM_BOUNDARY = Object.freeze({
  categoryConformanceIsDeclarationOnly: true,
  evidenceTransfer: false,
  runtimePermission: false,
  releaseAuthorization: false,
  independentCertification: false,
  semanticAuthorityTransfer: false,
});

const PRIMITIVE_SELECTION = Object.freeze([
  'decodeActionEnvelope',
  'encodeActionEnvelope',
  'storageEpisodeRecoverTyped',
]);

const DOMAIN_MAPPING = Object.freeze([
  {
    domainOperation: 'note.append',
    primitive: 'encodeActionEnvelope',
  },
  {
    domainOperation: 'note.read',
    primitive: 'decodeActionEnvelope',
  },
  {
    domainOperation: 'workspace.recover',
    primitive: 'storageEpisodeRecoverTyped',
  },
]);

function rooted(kind, value) {
  return semanticRoot({ adopterId: ADOPTER_ID, kind, value });
}

function packageReadback() {
  return {
    schema: 'example.domain-product.package-readback/v1',
    packages: [corePackage, kfdPackage, buildchainPackage]
      .map(({ name, version }) => ({ name, version }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    coreSurface: {
      authorityContract: coreAuthority.schema,
      platformContract: corePlatformContract.schema,
      platformNeutralMainPackage:
        corePlatformContract.mainPackage.platformNeutralOnly,
      selectedPrimitives: [...PRIMITIVE_SELECTION],
    },
  };
}

function replay(events) {
  return events.reduce(
    (state, event) => ({
      nextSequence: event.sequence + 1,
      notes: [...state.notes, { id: event.id, text: event.text }],
    }),
    { nextSequence: 1, notes: [] },
  );
}

function productScenario({ undeclaredPrimitive = false } = {}) {
  const events = [
    { sequence: 1, id: 'note-1', text: 'alpha' },
    { sequence: 2, id: 'note-2', text: 'beta' },
  ];
  const liveState = replay(events);
  const faultAttempt = { sequence: 4, id: 'note-gap', text: 'rejected' };
  const fault = {
    code: 'domain-sequence-gap',
    expectedSequence: liveState.nextSequence,
    observedSequence: faultAttempt.sequence,
    rejected: faultAttempt.sequence !== liveState.nextSequence,
  };
  const recoveredState = replay(events);
  const usedPrimitives = [...PRIMITIVE_SELECTION];
  if (undeclaredPrimitive) usedPrimitives.push('ConfigStore');
  return {
    runtime: {
      schema: 'example.domain-product.runtime-receipt/v1',
      executionMode: 'package-surface-mapped-fixture',
      primitiveSelection: [...PRIMITIVE_SELECTION],
      domainMapping: structuredClone(DOMAIN_MAPPING),
      usedPrimitives,
      eventCount: events.length,
      liveStateRoot: rooted('live-state', liveState),
    },
    fault: {
      schema: 'example.domain-product.fault-receipt/v1',
      ...fault,
      faultRoot: rooted('fault', fault),
    },
    recovery: {
      schema: 'example.domain-product.recovery-receipt/v1',
      replayedEventCount: events.length,
      recoveredStateRoot: rooted('live-state', recoveredState),
      matchesLiveState:
        rooted('live-state', recoveredState) === rooted('live-state', liveState),
    },
  };
}

function createEvidenceReceipts(options = {}) {
  const readback = packageReadback();
  const scenario = productScenario(options);
  const source = {
    kind: 'git-commit',
    coordinate: `${ADOPTER_ID}@${'2'.repeat(40)}`,
    root: rooted('source', { commit: '2'.repeat(40) }),
  };
  const artifact = {
    kind: 'package',
    coordinate: '@example/field-notes@1.0.0',
    root: rooted('artifact', { package: '@example/field-notes@1.0.0' }),
  };
  const release = {
    kind: 'release',
    coordinate: 'https://example.invalid/field-notes/releases/1.0.0',
    root: rooted('release', { artifactRoot: artifact.root }),
  };
  const releaseReadback = {
    schema: 'example.domain-product.release-readback/v1',
    artifact,
    release,
    packageReadbackRoot: rooted('package-readback', readback),
  };
  return { readback, scenario, source, artifact, release, releaseReadback };
}

function expectedEvidenceRoots(receipts) {
  return new Map([
    ['adopter-identity/declaration', rooted('adopter-identity', ADOPTER_ID)],
    ['claim-boundary/declaration', rooted('claim-boundary', CLAIM_BOUNDARY)],
    ['kfd-cut/verification', rooted('package-readback', receipts.readback)],
    ['source-artifact/implementation', rooted('source-artifact', {
      source: receipts.source,
      artifact: receipts.artifact,
    })],
    ['runtime-implementation/implementation', rooted('runtime', receipts.scenario.runtime)],
    ['runtime-implementation/verification', rooted('runtime-verification', {
      eventCount: receipts.scenario.runtime.eventCount,
      liveStateRoot: receipts.scenario.runtime.liveStateRoot,
    })],
    ['runtime-permission-boundary/declaration', rooted('runtime-boundary', CLAIM_BOUNDARY)],
    ['runtime-permission-boundary/verification', rooted('runtime-boundary-verification', {
      runtimePermission: false,
      selectedPrimitives: receipts.scenario.runtime.primitiveSelection,
    })],
    ['runtime-qualification/negative', rooted('fault', receipts.scenario.fault)],
    ['runtime-qualification/verification', rooted('qualification', {
      recovery: receipts.scenario.recovery,
      releaseReadback: receipts.releaseReadback,
    })],
  ]);
}

function createInstance(receipts) {
  const adopterManifest = initAdopterManifest({
    manifestId: `${ADOPTER_ID}:full-cut`,
    adopterId: ADOPTER_ID,
    artifactKind: receipts.artifact.kind,
    artifactCoordinate: receipts.artifact.coordinate,
    artifactRoot: receipts.artifact.root,
    scope: 'Field-notes domain runtime and recovery proof',
    packageArtifactRoot: KFD_PACKAGE_ROOT,
    verifiedAt: OBSERVED_AT,
    maxAgeSeconds: 3600,
  });
  adopterManifest.releaseBindings.push({
    id: `${ADOPTER_ID}:1.0.0`,
    artifact: structuredClone(receipts.artifact),
    releasePassport: structuredClone(receipts.release),
    kfdPackageRoot: KFD_PACKAGE_ROOT,
  });
  const selection = {
    schemaVersion: 1,
    contract: 'kfd.adopter-category-profile-selection/v1',
    profiles: [
      { id: 'kfd.adopter-category/product-runtime', version: '1.0.0' },
    ],
  };
  const resolution = resolvePublishedKfdAdopterCategoryProfiles(selection);
  if (!resolution.valid) {
    throw new Error(`published category selection failed: ${JSON.stringify(resolution.issues)}`);
  }
  const project = {
    adopterId: ADOPTER_ID,
    source: structuredClone(receipts.source),
    artifact: structuredClone(receipts.artifact),
    release: structuredClone(receipts.release),
  };
  const adopterManifestRoot = semanticRoot(adopterManifest);
  const binding = {
    observedAt: OBSERVED_AT,
    projectInstanceId: INSTANCE_ID,
    projectRoot: semanticRoot(project),
    adopterManifestRoot,
    kfdPackageRoot: KFD_PACKAGE_ROOT,
    categorySelectionRoot: resolution.selectionRoot,
  };
  const roots = expectedEvidenceRoots(receipts);
  const instanceManifest = {
    $schema:
      'https://kfd.libkungfu.dev/schemas/kfd-adopter-conformance/category-instance-manifest.schema.json',
    schemaVersion: 1,
    contract: 'kfd.adopter-category-instance-manifest/v1',
    instanceId: INSTANCE_ID,
    rootAlgorithm: 'sha256-kfd-canonical-json-v1',
    project,
    adopterManifest: {
      contract: 'kfd.adopter-conformance-manifest/v1',
      manifestId: adopterManifest.manifestId,
      root: adopterManifestRoot,
    },
    kfdCut: {
      packageVersion: adopterManifest.kfdCut.package.version,
      packageRoot: KFD_PACKAGE_ROOT,
      categoryCatalogRoot: resolution.catalogRoot,
    },
    selection,
    selectionRoot: resolution.selectionRoot,
    requirements: resolution.requirements.map((requirement) => ({
      id: requirement.id,
      evidence: requirement.evidenceKinds.map((kind) => ({
        kind,
        coordinate: `urn:example:field-notes:${requirement.id}:${kind}`,
        root: roots.get(`${requirement.id}/${kind}`),
        ...binding,
      })),
    })),
    claimBoundary: structuredClone(CLAIM_BOUNDARY),
  };
  return { adopterManifest, instanceManifest };
}

function localIssues(receipts, instanceManifest) {
  const issues = [];
  const declared = new Set(receipts.scenario.runtime.primitiveSelection);
  const publicCore = new Set(coreAuthority.categories.nativeDirect);
  for (const primitive of receipts.scenario.runtime.usedPrimitives) {
    if (!declared.has(primitive)) {
      issues.push({ code: 'domain-primitive-undeclared', path: '/runtime/usedPrimitives' });
    }
    if (!publicCore.has(primitive)) {
      issues.push({ code: 'core-primitive-unknown', path: '/runtime/usedPrimitives' });
    }
  }
  if (!receipts.scenario.fault.rejected) {
    issues.push({ code: 'runtime-fault-not-rejected', path: '/fault/rejected' });
  }
  if (!receipts.scenario.recovery.matchesLiveState) {
    issues.push({ code: 'runtime-recovery-mismatch', path: '/recovery' });
  }
  const expected = expectedEvidenceRoots(receipts);
  for (const requirement of instanceManifest.requirements) {
    for (const evidence of requirement.evidence) {
      if (expected.get(`${requirement.id}/${evidence.kind}`) !== evidence.root) {
        issues.push({
          code: 'domain-evidence-root-mismatch',
          path: `/requirements/${requirement.id}/${evidence.kind}`,
        });
      }
    }
  }
  return issues;
}

function mutateFixture(fixture, vector) {
  if (vector === 'copied-kungfu-roots') {
    const copied = semanticRoot({ adopterId: 'kungfu-systems/kungfu', evidence: 'copied' });
    for (const requirement of fixture.instanceManifest.requirements) {
      for (const evidence of requirement.evidence) evidence.root = copied;
    }
  } else if (vector === 'runtime-fault-omission') {
    const requirement = fixture.instanceManifest.requirements.find(
      ({ id }) => id === 'runtime-qualification',
    );
    requirement.evidence = requirement.evidence.filter(({ kind }) => kind !== 'negative');
  } else if (vector === 'recovery-substitution') {
    const requirement = fixture.instanceManifest.requirements.find(
      ({ id }) => id === 'runtime-qualification',
    );
    requirement.evidence.find(({ kind }) => kind === 'verification').root =
      semanticRoot({ adopterId: 'example.org/other-product', evidence: 'recovery' });
  }
}

export function qualifyDomainProduct({ vector = 'golden' } = {}) {
  const receipts = createEvidenceReceipts({
    undeclaredPrimitive: vector === 'undeclared-primitive',
  });
  const fixture = createInstance(receipts);
  mutateFixture(fixture, vector);
  const request = {
    schemaVersion: 1,
    contract: 'kungfu-buildchain-adopter-delivery-request',
    protocol: {
      id: KFD_ADOPTER_CATEGORY_PROTOCOL_ID,
      version: KFD_ADOPTER_CATEGORY_PROTOCOL_VERSION,
    },
    artifactProfile: {
      id: 'buildchain.artifact/package',
      version: '1.0.0',
    },
    project: {
      instanceId: fixture.instanceManifest.instanceId,
      adopterId: fixture.instanceManifest.project.adopterId,
    },
    artifact: structuredClone(fixture.instanceManifest.project.artifact),
    declaration: fixture.instanceManifest,
  };
  const gate = createAdopterDeliveryGate({
    drivers: [createKfdAdopterCategoryProtocolDriver()],
    artifactProfiles: [createPackageArtifactProfile()],
  });
  const gateResult = gate.evaluate(request, {
    adopterManifest: fixture.adopterManifest,
    verifiedAt: OBSERVED_AT,
    maxAgeSeconds: 3600,
  });
  const issues = [...localIssues(receipts, fixture.instanceManifest)];
  if (gateResult.status !== 'passed') issues.push(...gateResult.issues);
  const result = {
    schema: 'example.domain-product.qualification/v1',
    vector,
    status: issues.length === 0 ? 'passed' : 'failed',
    adopterId: ADOPTER_ID,
    instanceId: INSTANCE_ID,
    packageReadback: receipts.readback,
    runtime: receipts.scenario.runtime,
    fault: receipts.scenario.fault,
    recovery: receipts.scenario.recovery,
    releaseReadback: receipts.releaseReadback,
    gate: {
      status: gateResult.status,
      qualifying: gateResult.qualifying,
      selfCertified: gateResult.selfCertified,
      gateRoot: gateResult.gateRoot,
    },
    issues,
  };
  return { ...result, qualificationRoot: adopterDeliveryGateDigest(result) };
}
