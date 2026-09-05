// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';

const CONTRACT_PATH =
  'framework/work/work-loop/project-cut-product-loop.release-contract.json';
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export class ProjectCutProductLoopReleaseError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'ProjectCutProductLoopReleaseError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProjectCutProductLoopReleaseError(code, message);
}

function requireObject(value, code, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${label} must be an object`);
  }
  return value;
}

function requireString(value, code, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(code, `${label} must be a non-empty string`);
  }
  return value;
}

function requireDigest(value, code, label) {
  if (!SHA256_PATTERN.test(value)) {
    fail(code, `${label} must be a sha256 digest`);
  }
  return value;
}

function requireCommit(value, code, label) {
  if (!COMMIT_PATTERN.test(value)) {
    fail(code, `${label} must be a full lowercase Git commit`);
  }
  return value;
}

function normalizeArtifactDigest(value, code, label) {
  const digest =
    typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
      ? `sha256:${value}`
      : value;
  return requireDigest(digest, code, label);
}

function passportArtifactMatches(artifact, expectedPlatform, expectedDigest) {
  if (artifact === null || typeof artifact !== 'object') return false;
  const platform = String(artifact.platform || '');
  const prefixes =
    expectedPlatform === 'win32' ? ['win32', 'windows'] : [expectedPlatform];
  if (
    !prefixes.some(
      (prefix) => platform === prefix || platform.startsWith(`${prefix}-`),
    )
  ) {
    return false;
  }
  const digest = artifact.digest || artifact.sha256;
  try {
    return (
      normalizeArtifactDigest(
        digest,
        'PASSPORT_ARTIFACT_INVALID',
        'release passport artifact digest',
      ) === expectedDigest
    );
  } catch {
    return false;
  }
}

function exactIds(items, requiredIds, code, label) {
  if (!Array.isArray(items)) fail(code, `${label} must be an array`);
  const ids = items.map((item, index) => {
    requireObject(item, code, `${label}[${index}]`);
    return requireString(item.id, code, `${label}[${index}].id`);
  });
  if (new Set(ids).size !== ids.length)
    fail(code, `${label} ids must be unique`);
  if (
    ids.length !== requiredIds.length ||
    requiredIds.some((id) => !ids.includes(id))
  ) {
    fail(code, `${label} must contain the exact required ids`);
  }
}

function exactStrings(values, required, code, label) {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== 'string')
  ) {
    fail(code, `${label} must be a string array`);
  }
  if (
    new Set(values).size !== values.length ||
    values.length !== required.length ||
    required.some((value) => !values.includes(value))
  ) {
    fail(code, `${label} must contain the exact required values`);
  }
}

export function loadProjectCutProductLoopReleaseContract(
  contractPath = CONTRACT_PATH,
) {
  return JSON.parse(fs.readFileSync(contractPath, 'utf8'));
}

export function verifyProjectCutProductLoopReleaseEvidence(
  evidence,
  contract = loadProjectCutProductLoopReleaseContract(),
  expectations = {},
) {
  requireObject(evidence, 'EVIDENCE_INVALID', 'evidence');
  if (evidence.schema !== contract.evidenceSchema) {
    fail('SCHEMA_MISMATCH', `expected ${contract.evidenceSchema}`);
  }
  requireString(evidence.reportId, 'REPORT_ID_INVALID', 'reportId');
  const sourceCommit = requireCommit(
    evidence.sourceCommit,
    'SOURCE_INVALID',
    'sourceCommit',
  );
  const expectedSourceCommit = requireCommit(
    expectations.sourceCommit,
    'EXPECTED_SOURCE_REQUIRED',
    'expectations.sourceCommit',
  );
  if (sourceCommit !== expectedSourceCommit) {
    fail(
      'SOURCE_NOT_CURRENT',
      'evidence does not bind the expected source commit',
    );
  }

  const passport = requireObject(
    evidence.releasePassport,
    'PASSPORT_INVALID',
    'releasePassport',
  );
  requireString(passport.ref, 'PASSPORT_INVALID', 'releasePassport.ref');
  requireDigest(passport.digest, 'PASSPORT_INVALID', 'releasePassport.digest');
  const expectedPassportDigest = requireDigest(
    expectations.releasePassportDigest,
    'EXPECTED_PASSPORT_REQUIRED',
    'expectations.releasePassportDigest',
  );
  if (passport.digest !== expectedPassportDigest) {
    fail(
      'PASSPORT_NOT_CURRENT',
      'evidence does not bind the expected release passport',
    );
  }
  if (passport.sourceCommit !== sourceCommit) {
    fail('PASSPORT_SOURCE_MISMATCH', 'release passport source commit differs');
  }

  exactIds(
    evidence.scenarios,
    contract.requiredScenarios,
    'SCENARIOS_INCOMPLETE',
    'scenarios',
  );
  for (const scenario of evidence.scenarios) {
    if (scenario.status !== contract.admission.scenarioStatus) {
      fail('SCENARIO_NOT_PASSING', `${scenario.id} is not passing`);
    }
    if (scenario.sourceCommit !== sourceCommit) {
      fail('SCENARIO_SOURCE_MISMATCH', `${scenario.id} source commit differs`);
    }
    const roots = requireObject(
      scenario.roots,
      'ROOT_BINDING_INVALID',
      `${scenario.id}.roots`,
    );
    for (const root of contract.requiredRootBindings) {
      requireDigest(
        roots[root],
        'ROOT_BINDING_INVALID',
        `${scenario.id}.roots.${root}`,
      );
    }
    if (
      !Array.isArray(roots.operationReceiptRoots) ||
      roots.operationReceiptRoots.length === 0
    ) {
      fail(
        'ROOT_BINDING_INVALID',
        `${scenario.id} needs operation receipt roots`,
      );
    }
    for (const [index, root] of roots.operationReceiptRoots.entries()) {
      requireDigest(
        root,
        'ROOT_BINDING_INVALID',
        `${scenario.id}.roots.operationReceiptRoots[${index}]`,
      );
    }
    const bindings = requireObject(
      scenario.evidence,
      'EVIDENCE_BINDING_INVALID',
      `${scenario.id}.evidence`,
    );
    for (const binding of contract.requiredEvidenceBindings) {
      requireDigest(
        bindings[binding],
        'EVIDENCE_BINDING_INVALID',
        `${scenario.id}.evidence.${binding}`,
      );
    }
  }

  exactIds(
    evidence.negativeCases,
    contract.requiredNegativeCases,
    'NEGATIVE_CASES_INCOMPLETE',
    'negativeCases',
  );
  for (const negativeCase of evidence.negativeCases) {
    if (negativeCase.status !== contract.admission.negativeCaseStatus) {
      fail(
        'NEGATIVE_CASE_NOT_REJECTED',
        `${negativeCase.id} did not fail closed`,
      );
    }
    for (const field of [
      'observedRootsRef',
      'unmetContract',
      'resolvingAuthority',
      'safeNextAction',
      'evidenceRef',
    ]) {
      requireString(
        negativeCase[field],
        'NEGATIVE_CASE_INVALID',
        `${negativeCase.id}.${field}`,
      );
    }
  }

  const parity = requireObject(
    evidence.surfaceParity,
    'SURFACE_PARITY_INVALID',
    'surfaceParity',
  );
  if (parity.status !== 'pass') {
    fail('SURFACE_PARITY_INVALID', 'surface parity is not passing');
  }
  exactStrings(
    parity.surfaces,
    contract.requiredSurfaces,
    'SURFACE_PARITY_INVALID',
    'surfaceParity.surfaces',
  );
  requireDigest(
    parity.semanticRoot,
    'SURFACE_PARITY_INVALID',
    'surfaceParity.semanticRoot',
  );
  requireString(
    parity.evidenceRef,
    'SURFACE_PARITY_INVALID',
    'surfaceParity.evidenceRef',
  );
  for (const scenario of evidence.scenarios) {
    if (scenario.evidence.surfaceParityRoot !== parity.semanticRoot) {
      fail(
        'SURFACE_PARITY_MISMATCH',
        `${scenario.id} does not bind the admitted surface parity root`,
      );
    }
  }

  exactIds(
    evidence.domainProfiles,
    contract.requiredDomainProfileKinds,
    'DOMAIN_PROFILES_INCOMPLETE',
    'domainProfiles',
  );
  for (const profile of evidence.domainProfiles) {
    if (profile.status !== 'pass') {
      fail('DOMAIN_PROFILE_NOT_PASSING', `${profile.id} is not passing`);
    }
    requireString(
      profile.profileId,
      'DOMAIN_PROFILE_INVALID',
      `${profile.id}.profileId`,
    );
    requireString(
      profile.evidenceRef,
      'DOMAIN_PROFILE_INVALID',
      `${profile.id}.evidenceRef`,
    );
    if (!Array.isArray(profile.coreProductChanges)) {
      fail(
        'DOMAIN_PROFILE_INVALID',
        `${profile.id}.coreProductChanges must be an array`,
      );
    }
    if (profile.id === 'third-party' && profile.coreProductChanges.length > 0) {
      fail(
        'THIRD_PARTY_CORE_CHANGE',
        'third-party profile qualification changed core product code',
      );
    }
  }

  if (!Array.isArray(evidence.artifacts)) {
    fail('ARTIFACTS_INCOMPLETE', 'artifacts must be an array');
  }
  exactIds(
    evidence.artifacts,
    contract.requiredPlatforms,
    'ARTIFACTS_INCOMPLETE',
    'artifacts',
  );
  for (const artifact of evidence.artifacts) {
    requireDigest(artifact.digest, 'ARTIFACT_INVALID', `${artifact.id}.digest`);
    requireString(
      artifact.installCoordinate,
      'ARTIFACT_INVALID',
      `${artifact.id}.installCoordinate`,
    );
  }
  const passportArtifacts = requireObject(
    passport.artifactDigests,
    'PASSPORT_ARTIFACTS_INVALID',
    'releasePassport.artifactDigests',
  );
  exactStrings(
    Object.keys(passportArtifacts),
    contract.requiredPlatforms,
    'PASSPORT_ARTIFACTS_INVALID',
    'releasePassport.artifactDigests keys',
  );
  for (const artifact of evidence.artifacts) {
    if (passportArtifacts[artifact.id] !== artifact.digest) {
      fail(
        'PASSPORT_ARTIFACT_MISMATCH',
        `${artifact.id} digest differs from the release passport`,
      );
    }
  }

  const review = requireObject(
    evidence.independentReview,
    'REVIEW_INVALID',
    'independentReview',
  );
  if (review.status !== contract.admission.independentReviewStatus) {
    fail('REVIEW_INVALID', 'independent review is not approved');
  }
  requireString(review.author, 'REVIEW_INVALID', 'independentReview.author');
  requireString(
    review.reviewer,
    'REVIEW_INVALID',
    'independentReview.reviewer',
  );
  requireString(
    review.evidenceRef,
    'REVIEW_INVALID',
    'independentReview.evidenceRef',
  );
  if (review.author === review.reviewer) {
    fail('SELF_REVIEW', 'author and reviewer must differ');
  }

  if (!Array.isArray(evidence.unknowns) || evidence.unknowns.length > 0) {
    fail('UNRESOLVED_UNKNOWNS', 'qualification evidence contains unknowns');
  }
  if (
    !Array.isArray(evidence.residualRisks) ||
    evidence.residualRisks.length > 0
  ) {
    fail('RESIDUAL_RISKS', 'qualification evidence contains residual risks');
  }
  return evidence;
}

export function verifyRetainedProjectCutProductLoopRelease(
  { evidence, passport, passportDigest, passportRef, sourceCommit },
  contract = loadProjectCutProductLoopReleaseContract(),
) {
  requireObject(passport, 'PASSPORT_DOCUMENT_INVALID', 'release passport');
  const expectedSourceCommit = requireCommit(
    sourceCommit,
    'EXPECTED_SOURCE_REQUIRED',
    'sourceCommit',
  );
  const expectedPassportDigest = requireDigest(
    passportDigest,
    'EXPECTED_PASSPORT_REQUIRED',
    'passportDigest',
  );
  const expectedPassportRef = requireString(
    passportRef,
    'EXPECTED_PASSPORT_REQUIRED',
    'passportRef',
  );
  const release = requireObject(
    passport.release,
    'PASSPORT_DOCUMENT_INVALID',
    'release passport release',
  );
  if (release.sourceSha !== expectedSourceCommit) {
    fail(
      'PASSPORT_SOURCE_NOT_CURRENT',
      'release passport source SHA does not match the current source commit',
    );
  }

  const verified = verifyProjectCutProductLoopReleaseEvidence(
    evidence,
    contract,
    {
      sourceCommit: expectedSourceCommit,
      releasePassportDigest: expectedPassportDigest,
    },
  );
  if (verified.releasePassport.ref !== expectedPassportRef) {
    fail(
      'PASSPORT_REF_MISMATCH',
      'evidence does not reference the supplied release passport',
    );
  }
  if (!Array.isArray(passport.artifacts)) {
    fail(
      'PASSPORT_ARTIFACTS_INVALID',
      'release passport artifacts must be an array',
    );
  }
  for (const artifact of verified.artifacts) {
    if (
      !passport.artifacts.some((candidate) =>
        passportArtifactMatches(candidate, artifact.id, artifact.digest),
      )
    ) {
      fail(
        'PASSPORT_ARTIFACT_NOT_BOUND',
        `${artifact.id} artifact digest is not present in the release passport`,
      );
    }
  }
  return verified;
}
