// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const COMPACT_SURFACE_IDS = ['kungfu.agent.', 'shifu.agent.', 'xinfa.agent.'];
let adopterManifestRuntime;
let adopterConformanceRuntime;

function isCompactSurface(value) {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    (COMPACT_SURFACE_IDS.some((prefix) => value.id.startsWith(prefix)) ||
      ['xinfa.context', 'xinfa.expand'].includes(value.id))
  );
}

export function renderKfdJson(value) {
  const compact = [];
  const rendered = JSON.stringify(
    value,
    (_key, item) => {
      if (!isCompactSurface(item)) return item;
      const token = `__KUNGFU_COMPACT_SURFACE_${compact.length}__`;
      compact.push(JSON.stringify(item));
      return token;
    },
    2,
  );
  return `${compact.reduce(
    (text, item, index) =>
      text.replace(`"__KUNGFU_COMPACT_SURFACE_${index}__"`, item),
    rendered,
  )}\n`;
}

export const BUILDCHAIN_KFD1_CONTRACT_WORLD_WITNESS_PATH =
  '.buildchain/kfd/kfd-1/contract-world.witness.json';
export const BUILDCHAIN_KFD1_RELEASE_GATE_PATH =
  '.buildchain/kfd/kfd-1/release-gate.json';
export const BUILDCHAIN_KFD1_VERIFY_RESULT_PATH =
  '.buildchain/kfd/kfd-1/verify-result.json';
export const BUILDCHAIN_KFD2_DIR = '.buildchain/kfd/kfd-2';
export const BUILDCHAIN_KFD2_REGISTRY_PATH =
  '.buildchain/kfd/kfd-2/registry.json';
export const BUILDCHAIN_KFD3_DIR = '.buildchain/kfd/kfd-3';
export const KFD3_DEFAULT_REGISTRY_PATH = '.buildchain/kfd/kfd-3/surfaces.json';

export async function loadBuildchainKfdRuntime() {
  try {
    const [
      { kfd1, kfd2, kfd3 },
      productGates,
      adopterManifest,
      adopterConformance,
    ] = await Promise.all([
      import('@kungfu-tech/buildchain-alpha/kfd'),
      import('@kungfu-tech/buildchain-alpha/kfd-product-gates'),
      import('@kungfu-tech/buildchain-alpha/kfd-adopter-manifest'),
      import('@kungfu-tech/kfd/adopter-conformance/toolchain'),
    ]);
    adopterManifestRuntime = adopterManifest;
    adopterConformanceRuntime = adopterConformance;
    return { kfd1, kfd2, kfd3, productGates };
  } catch (error) {
    if (
      error &&
      error.code === 'ERR_MODULE_NOT_FOUND' &&
      (String(error.message).includes('@kungfu-tech/buildchain-alpha') ||
        String(error.message).includes('@kungfu-tech/kfd'))
    )
      return null;
    throw error;
  }
}

export function gitValue(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function isGitAncestor(root, sourceSha, headSha) {
  return (
    spawnSync('git', ['merge-base', '--is-ancestor', sourceSha, headSha], {
      cwd: root,
      stdio: 'ignore',
    }).status === 0
  );
}

export function resolveGitBoundKfdEvidenceSourceSha({
  root,
  write,
  committed,
  configured,
  prepareHistory,
  assertBinding,
  selectSourceSha,
  findTreeEquivalentAncestor,
}) {
  if (!write) prepareHistory(root, { requiredCommit: committed });
  const headSha = gitValue(root, ['rev-parse', 'HEAD']);
  return assertBinding({
    sourceSha: selectSourceSha({ write, configured, committed, headSha }),
    headSha,
    isAncestor: (sourceSha, candidateHeadSha) =>
      isGitAncestor(root, sourceSha, candidateHeadSha),
    findTreeEquivalentAncestor: (sourceSha, candidateHeadSha) =>
      findTreeEquivalentAncestor(sourceSha, candidateHeadSha, (args) =>
        gitValue(root, args),
      ),
  });
}

export function releaseCandidateKfdRoot({ defaultRoot, receiptPath }) {
  return receiptPath?.trim() ? process.cwd() : defaultRoot;
}

export function loadSealedKfdUpstreamAggregate({
  receiptPath,
  aggregatePath,
  displayPath,
  quiet,
  readAggregate,
}) {
  const receipt = receiptPath?.trim();
  if (!receipt) return null;
  if (!fs.existsSync(receipt))
    throw new Error(
      `release-candidate recovery receipt is missing: ${receipt}`,
    );
  const aggregate = readAggregate(aggregatePath);
  if (
    aggregate.contract !== 'kungfu-upstream-kfd-aggregate' ||
    aggregate.source?.generator !== 'scripts/buildchain-kfd-evidence.mjs' ||
    !Array.isArray(aggregate.upstreams) ||
    aggregate.upstreams.length === 0
  )
    throw new Error(
      'sealed release-candidate KFD upstream aggregate is invalid',
    );
  if (!quiet)
    console.log(
      `reused sealed release-candidate KFD upstream aggregate from ${displayPath}`,
    );
  return aggregate;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function assertPair(root, source, projection, canonicalProjection = false) {
  const sourceFile = path.join(root, source);
  const projectionFile = path.join(root, projection);
  if (!fs.existsSync(sourceFile) || !fs.existsSync(projectionFile))
    throw new Error(
      `cold KFD projection is missing: ${source} -> ${projection}`,
    );
  const sourceBytes = fs.readFileSync(sourceFile);
  const expected = canonicalProjection
    ? Buffer.from(`${JSON.stringify(JSON.parse(sourceBytes), null, 2)}\n`)
    : sourceBytes;
  if (!expected.equals(fs.readFileSync(projectionFile)))
    throw new Error(`cold KFD projection differs: ${source} -> ${projection}`);
}

export function checkColdBuildchainKfd(root) {
  const pairs = [
    [
      BUILDCHAIN_KFD1_CONTRACT_WORLD_WITNESS_PATH,
      'developer/sdk/kfd/kfd-1/contract-world.witness.json',
    ],
    [
      BUILDCHAIN_KFD1_RELEASE_GATE_PATH,
      'developer/sdk/kfd/kfd-1/release-gate.json',
    ],
    [
      BUILDCHAIN_KFD1_VERIFY_RESULT_PATH,
      'developer/sdk/kfd/kfd-1/verify-result.json',
    ],
    [KFD3_DEFAULT_REGISTRY_PATH, 'developer/sdk/kfd/kfd-3-surfaces.json'],
    [
      '.buildchain/kfd/kfd-2/release-claims.json',
      'developer/sdk/kfd/kfd-2/release-claims.json',
    ],
    [
      '.buildchain/kfd/support-matrix.json',
      'developer/sdk/kfd/support-matrix.json',
      true,
    ],
  ];
  const claimsDir = path.join(root, BUILDCHAIN_KFD2_DIR, 'claims');
  for (const name of fs
    .readdirSync(claimsDir)
    .filter((value) => value.endsWith('.json'))
    .sort())
    pairs.push([
      `${BUILDCHAIN_KFD2_DIR}/claims/${name}`,
      `developer/sdk/kfd/kfd-2/claims/${name}`,
    ]);
  for (const pair of pairs) assertPair(root, ...pair);
  for (const base of [BUILDCHAIN_KFD2_DIR, 'developer/sdk/kfd/kfd-2']) {
    const args = fs
      .readFileSync(path.join(root, base, 'buildchain-claim-args.txt'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.replace(`--kfd-2-claim-json ${base}/claims/`, ''))
      .sort();
    const claims = fs
      .readdirSync(path.join(root, base, 'claims'))
      .filter((name) => name.endsWith('.json'))
      .sort();
    if (JSON.stringify(args) !== JSON.stringify(claims))
      throw new Error(`cold KFD-2 claim arguments differ from ${base}/claims`);
  }

  const verify = readJson(path.join(root, BUILDCHAIN_KFD1_VERIFY_RESULT_PATH));
  if (
    verify.contract !== 'kungfu-buildchain-kfd-1-verify-result' ||
    verify.ok !== true ||
    !Array.isArray(verify.issues) ||
    verify.issues.length !== 0
  )
    throw new Error('cold KFD-1 verify result is not qualifying');
  const registry = readJson(path.join(root, KFD3_DEFAULT_REGISTRY_PATH));
  if (
    registry.contract !== 'kungfu-buildchain-kfd-3-surface-registry' ||
    !Array.isArray(registry.surfaces) ||
    registry.surfaces.length === 0
  )
    throw new Error('cold KFD-3 registry is not a closed non-empty projection');
  const aggregate = readJson(
    path.join(root, 'developer/sdk/kfd/upstream-aggregate.json'),
  );
  if (
    aggregate.contract !== 'kungfu-upstream-kfd-aggregate' ||
    !Array.isArray(aggregate.upstreams)
  )
    throw new Error('cold KFD upstream aggregate is invalid');
  const lockPath = path.join(root, '.buildchain/alpha-contract-lock.json');
  const lock = readJson(lockPath);
  if (
    lock?.buildchain?.ref !== 'v3-alpha' ||
    !/^[0-9a-f]{40}$/.test(lock?.buildchain?.resolvedSha || '') ||
    !/^sha256:[0-9a-f]{64}$/.test(lock?.buildchain?.contractDigest || '')
  )
    throw new Error('cold KFD check is not bound to the Buildchain alpha lock');
  return {
    ok: true,
    mode: 'cold-source-check',
    buildchainRuntime: 'not-installed',
    contractLock: relative(root, lockPath),
    projectionPairs: pairs.length,
    kfd3Surfaces: registry.surfaces.length,
  };
}
export const KFD_ADOPTER_MANIFEST_PATH =
  '.buildchain/kfd/adopter-manifest.json';
export const KFD_ADOPTER_MANIFEST_GATE_PATH =
  '.buildchain/kfd/adopter-manifest-gate.json';
export const KFD_SUPPORT_MATRIX_PATH = '.buildchain/kfd/support-matrix.json';
export const SDK_KFD_ADOPTER_MANIFEST_PATH =
  'developer/sdk/kfd/adopter-manifest.json';
export const SDK_KFD_ADOPTER_MANIFEST_GATE_PATH =
  'developer/sdk/kfd/adopter-manifest-gate.json';
export const SDK_KFD_SUPPORT_MATRIX_PATH =
  'developer/sdk/kfd/support-matrix.json';
export const DOC_KFD_SUPPORT_MATRIX_PATH =
  'docs/qualification/kfd-support-matrix.md';

const KFD_ADOPTER_ID = 'kungfu-systems/kungfu';
const MAX_AGE_SECONDS = 31_536_000;
const require = createRequire(import.meta.url);

const DECLARATIONS = Object.freeze({
  'KFD-1': {
    state: 'candidate',
    usage: 'used',
    implementation: ['framework/contract/kungfu-contracts.registry.json'],
    verification: [
      '.buildchain/kfd/kfd-1/verify-result.json',
      'framework/contract/kungfu-contracts.registry.json',
    ],
    negative: ['scripts/kfd-support-matrix.test.mjs'],
    review: ['docs/qualification/alpha-ruleset.contract.json'],
    claim:
      'Kungfu keeps declared facts and generated artifacts in one rooted contract world.',
  },
  'KFD-2': {
    state: 'candidate',
    usage: 'used',
    implementation: [
      '.buildchain/kfd/kfd-2/release-claims.json',
      'docs/qualification/kfd2-trust-assessment.md',
    ],
    verification: [
      '.buildchain/kfd/kfd-2/release-claims.json',
      'docs/qualification/kfd2-trust-assessment.md',
    ],
    negative: ['scripts/verify-kfd2-source-binding.test.mjs'],
    review: ['docs/qualification/alpha-ruleset.contract.json'],
    claim:
      'Kungfu release trust begins from explicit package, source, review, and publication facts.',
  },
  'KFD-3': {
    state: 'candidate',
    usage: 'used',
    implementation: ['.buildchain/kfd/kfd-3/surfaces.json'],
    verification: [
      '.buildchain/kfd/kfd-3/capability-query.json',
      '.buildchain/kfd/kfd-3/surfaces.json',
    ],
    negative: [
      'framework/core/tests/fixtures/cli-surface-contract/dangling-kfd3.json',
    ],
    review: ['docs/qualification/alpha-ruleset.contract.json'],
    claim:
      'Kungfu publishes a machine-readable collaboration interface with explicit participant boundaries.',
  },
  'KFD-4': {
    state: 'candidate',
    usage: 'used',
    implementation: [
      'framework/core/src/python/kungfu/rewind/perspective.py',
      'framework/core/tests/qualification/kfd4-perspective.mjs',
    ],
    verification: [
      'docs/qualification/evidence/kfd-4-perspective/d73cab0d69/report.json',
      'framework/core/tests/python/test_kfd4_perspective.py',
    ],
    review: ['docs/qualification/alpha-ruleset.contract.json'],
    claim:
      'Kungfu retains one bounded observer-perspective and contrastive-replay candidate profile.',
  },
  'KFD-5': {
    state: 'candidate',
    usage: 'evaluating',
    implementation: [
      'docs/architecture/primitive-management-plane.md',
      'framework/core/src/python/kungfu/assignment_orchestration.py',
      'framework/primitive/kungfu-primitive-catalog.contract.json',
    ],
    verification: [
      'docs/qualification/evidence/assignment-organization-rollout/7aae2c562a/report.json',
      'framework/core/tests/python/test_assignment_orchestration.py',
    ],
    review: [
      'docs/qualification/evidence/assignment-organization-rollout/7aae2c562a/report.json',
    ],
    claim:
      'Kungfu retains bounded Assignment and Primitive Management adopter evidence without claiming universal primitive need.',
  },
  'KFD-6': {
    state: 'unsupported',
    usage: 'unused',
    gap: 'Kungfu has no conforming causal-experience autonomous discovery implementation or verification for this cut.',
  },
  'KFD-7': {
    state: 'candidate',
    usage: 'used',
    implementation: [
      'framework/agent-work/kungfu-kfd-7-action-contract.json',
      'framework/core/architecture/kfd7-release-passport.json',
    ],
    verification: [
      'framework/agent-work/evidence/kfd-7/kfd-verifier.json',
      'framework/agent-work/kungfu-kfd-7-release-gate.json',
      'framework/core/architecture/kfd7-release-passport.json',
    ],
    review: ['framework/agent-work/kungfu-kfd-7-action-contract.json'],
    claim:
      'Kungfu retains the reviewed activation record and separate product-profile evidence for KFD-7.',
  },
  'KFD-8': {
    state: 'draft-evidence',
    usage: 'evaluating',
    implementation: [
      'framework/agent-work/evidence/kfd-7/atlas-staleness-loss.json',
    ],
    verification: [
      'framework/agent-work/evidence/kfd-7/atlas-staleness-loss.json',
    ],
    gap: 'This is design feedback evidence only; it does not activate draft KFD-8 or establish shipped support.',
  },
  'KFD-9': {
    state: 'draft-evidence',
    usage: 'evaluating',
    implementation: [
      'framework/agent-work/evidence/kfd-7/pursuit-continuity-settlement.json',
    ],
    verification: [
      'framework/agent-work/evidence/kfd-7/pursuit-continuity-settlement.json',
    ],
    gap: 'This is design feedback evidence only; it does not activate draft KFD-9 or establish shipped support.',
  },
  'KFD-10': {
    state: 'draft-evidence',
    usage: 'evaluating',
    implementation: [
      'framework/agent-work/evidence/kfd-7/warrant-decay-revocation.json',
    ],
    verification: [
      'framework/agent-work/evidence/kfd-7/warrant-decay-revocation.json',
    ],
    gap: 'The retained Warrant evidence is partial and non-qualifying; the specialized KFX runtime witness remains a separate successor Assignment.',
  },
  'KFD-11': {
    state: 'draft-evidence',
    usage: 'evaluating',
    implementation: [
      'framework/core/src/python/kungfu/agent/profile-sdk.contract.json',
    ],
    verification: [
      'framework/core/src/python/kungfu/agent/profile-sdk.contract.json',
    ],
    gap: 'The upstream activation contract forbids treating this partial interface evidence as activated KFD-11.',
  },
  'KFD-12': {
    state: 'draft-evidence',
    usage: 'evaluating',
    implementation: [
      'framework/core/src/python/kungfu/assignment_orchestration.py',
    ],
    verification: [
      'framework/core/src/python/kungfu/assignment_orchestration.py',
    ],
    gap: 'The upstream activation contract forbids treating this partial lifecycle evidence as activated KFD-12.',
  },
  'KFD-13': {
    state: 'draft-evidence',
    usage: 'evaluating',
    implementation: ['framework/project-cut/project-cut.contract.json'],
    verification: ['framework/project-cut/project-cut.contract.json'],
    gap: 'The upstream activation contract forbids treating this partial Project Cut evidence as activated KFD-13.',
  },
});

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function installedKfdPackageRoot() {
  const selfManifest = readJson(
    require.resolve(
      '@kungfu-tech/kfd/adopter-conformance/adopters/kfd/manifest.json',
    ),
  );
  const root = selfManifest?.kfdCut?.package?.artifactRoot;
  if (!/^sha256:[0-9a-f]{64}$/u.test(root || '')) {
    throw new Error(
      'installed KFD self-manifest lacks an exact package artifact root',
    );
  }
  return root;
}

function sourceArtifactRoot(sourceSha) {
  return sha256(`git-commit:kungfu-systems/kungfu@${sourceSha}`);
}

function evidenceFile(root, relative) {
  if (!relative || path.isAbsolute(relative)) {
    throw new Error('KFD adopter evidence must use a checkout-relative path');
  }
  const checkout = path.resolve(root);
  const absolute = path.resolve(checkout, relative);
  if (!absolute.startsWith(`${checkout}${path.sep}`)) {
    throw new Error(`KFD adopter evidence escapes the checkout: ${relative}`);
  }
  if (!fs.existsSync(absolute)) {
    throw new Error(`KFD adopter evidence is missing: ${relative}`);
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `KFD adopter evidence must be a regular non-symlink file: ${relative}`,
    );
  }
  if (!fs.realpathSync(absolute).startsWith(`${checkout}${path.sep}`)) {
    throw new Error(
      `KFD adopter evidence resolves outside the checkout: ${relative}`,
    );
  }
  return absolute;
}

function localEvidence(
  root,
  sourceSha,
  packageRoot,
  observedAt,
  kind,
  relative,
) {
  const absolute = evidenceFile(root, relative);
  return {
    kind,
    coordinate: `git+https://github.com/kungfu-systems/kungfu.git@${sourceSha}#${relative}`,
    root: sha256(fs.readFileSync(absolute)),
    observedAt,
    kfdPackageRoot: packageRoot,
  };
}

function validateManifestLocalEvidence(root, sourceSha, manifest) {
  const gitPrefix = `git+https://github.com/kungfu-systems/kungfu.git@${sourceSha}#`;
  const witnessPrefix = `${KFD_ADOPTER_ID}@${sourceSha}#`;
  for (const decision of manifest.decisions) {
    for (const group of [
      'implementationEvidence',
      'verificationEvidence',
      'negativeEvidence',
      'reviews',
    ]) {
      for (const evidence of decision[group] || []) {
        if (!evidence.coordinate?.startsWith(gitPrefix)) continue;
        const relative = evidence.coordinate.slice(gitPrefix.length);
        if (
          sha256(fs.readFileSync(evidenceFile(root, relative))) !==
          evidence.root
        ) {
          throw new Error(
            `${decision.id} ${group} evidence root drift: ${relative}`,
          );
        }
      }
    }
    for (const witness of decision.witnessBindings || []) {
      if (!witness.witnessCoordinate?.startsWith(witnessPrefix)) continue;
      const relative = witness.witnessCoordinate.slice(witnessPrefix.length);
      if (
        sha256(fs.readFileSync(evidenceFile(root, relative))) !==
        witness.witnessRoot
      ) {
        throw new Error(`${decision.id} witness root drift: ${relative}`);
      }
    }
  }
}

function gateEvidence(gate, packageRoot, observedAt, kind, evidenceKind) {
  const entry = gate.evidence.find(
    (candidate) => candidate.kind === evidenceKind,
  );
  if (!entry) {
    throw new Error(`${gate.standard} gate lacks ${evidenceKind} evidence`);
  }
  return {
    kind,
    coordinate: `buildchain-product-gate:${gate.standard}@${gate.gateRoot}#${entry.id}`,
    root: entry.sha256,
    observedAt,
    kfdPackageRoot: packageRoot,
  };
}

function sortedEvidence(entries) {
  return entries.sort((left, right) =>
    compareUtf8(left.coordinate, right.coordinate),
  );
}

export function createKungfuKfdAdopterManifest({
  root,
  sourceSha,
  checkedAt,
  gates,
}) {
  if (!adopterConformanceRuntime)
    throw new Error('KFD adopter conformance runtime is unavailable');
  const packageArtifactRoot = installedKfdPackageRoot();
  let manifest = adopterConformanceRuntime.initAdopterManifest({
    packageArtifactRoot,
    verifiedAt: checkedAt,
    maxAgeSeconds: MAX_AGE_SECONDS,
    manifestId: `kungfu-full-cut-${sourceSha.slice(0, 12)}`,
    adopterId: KFD_ADOPTER_ID,
    artifactKind: 'git-commit',
    artifactCoordinate: `${KFD_ADOPTER_ID}@${sourceSha}`,
    artifactRoot: sourceArtifactRoot(sourceSha),
    scope:
      'Kungfu KFD implementation, product gates, SDK and CLI projections, and release evidence',
  });
  const gatesByDecision = new Map(
    gates.map((gate) => [gate.standard.toUpperCase(), gate]),
  );
  for (const row of manifest.decisions) {
    const declaration = DECLARATIONS[row.id];
    if (!declaration)
      throw new Error(`missing Kungfu KFD declaration for ${row.id}`);
    row.state = declaration.state;
    row.usage = declaration.usage;
    row.implementationEvidence = sortedEvidence(
      (declaration.implementation || []).map((relative) =>
        localEvidence(
          root,
          sourceSha,
          packageArtifactRoot,
          checkedAt,
          'implementation',
          relative,
        ),
      ),
    );
    row.verificationEvidence = sortedEvidence(
      (declaration.verification || []).map((relative) =>
        localEvidence(
          root,
          sourceSha,
          packageArtifactRoot,
          checkedAt,
          'verification',
          relative,
        ),
      ),
    );
    row.negativeEvidence = sortedEvidence(
      (declaration.negative || []).map((relative) =>
        localEvidence(
          root,
          sourceSha,
          packageArtifactRoot,
          checkedAt,
          'negative',
          relative,
        ),
      ),
    );
    row.reviews = sortedEvidence(
      (declaration.review || []).map((relative) =>
        localEvidence(
          root,
          sourceSha,
          packageArtifactRoot,
          checkedAt,
          'review',
          relative,
        ),
      ),
    );
    const gate = gatesByDecision.get(row.id);
    if (gate) {
      row.verificationEvidence.push({
        kind: 'verification',
        coordinate: `buildchain-product-gate:${gate.standard}@${gate.gateRoot}`,
        root: gate.gateRoot,
        observedAt: checkedAt,
        kfdPackageRoot: packageArtifactRoot,
      });
      row.verificationEvidence = sortedEvidence(row.verificationEvidence);
      row.negativeEvidence.push(
        gateEvidence(
          gate,
          packageArtifactRoot,
          checkedAt,
          'negative',
          'negative-fixture',
        ),
      );
      row.negativeEvidence = sortedEvidence(row.negativeEvidence);
      if (row.id === 'KFD-7') {
        row.reviews.push(
          gateEvidence(
            gate,
            packageArtifactRoot,
            checkedAt,
            'review',
            'independent-review',
          ),
        );
        row.reviews = sortedEvidence(row.reviews);
      }
    }
    row.claims = declaration.claim ? [declaration.claim] : [];
    row.gaps = [
      declaration.gap ||
        'This used declaration remains a candidate until decision-specific independent assessment and an exact release binding exist.',
    ].sort(compareUtf8);
  }
  const warrantPath =
    'framework/agent-work/evidence/kfd-7/warrant-decay-revocation.json';
  manifest = adopterConformanceRuntime.addAdopterWitness(manifest, {
    packageArtifactRoot,
    verifiedAt: checkedAt,
    maxAgeSeconds: MAX_AGE_SECONDS,
    decisionId: 'KFD-10',
    profileId: 'kfd-warrant-evidence',
    witnessCoordinate: `${KFD_ADOPTER_ID}@${sourceSha}#${warrantPath}`,
    witnessRoot: sha256(fs.readFileSync(evidenceFile(root, warrantPath))),
  });
  manifest.decisions.find(({ id }) => id === 'KFD-10').gaps = [
    DECLARATIONS['KFD-10'].gap,
  ];
  manifest.gaps = [
    'Candidate rows do not claim completed adoption without decision-specific witness and release bindings.',
    'Draft evidence cannot activate a draft, widen authority, or certify Kungfu.',
    'KFD-6 remains explicitly unsupported; no support is inferred from precursor work.',
  ].sort(compareUtf8);
  const report = adopterConformanceRuntime.verifyAdopterManifestFromPackage(
    manifest,
    {
      packageArtifactRoot,
      verifiedAt: checkedAt,
      maxAgeSeconds: MAX_AGE_SECONDS,
    },
  );
  if (!report.valid) {
    throw new Error(
      `generated Kungfu KFD adopter manifest failed: ${JSON.stringify(report.issues)}`,
    );
  }
  return manifest;
}

export function createKungfuKfdAdopterClosure({
  root,
  sourceSha,
  checkedAt,
  gates,
  manifest,
}) {
  if (!adopterManifestRuntime)
    throw new Error('Buildchain KFD adopter manifest runtime is unavailable');
  const selectedManifest =
    manifest ||
    createKungfuKfdAdopterManifest({ root, sourceSha, checkedAt, gates });
  validateManifestLocalEvidence(root, sourceSha, selectedManifest);
  const packageArtifactRoot = selectedManifest.kfdCut.package.artifactRoot;
  const gate = adopterManifestRuntime.createKfdAdopterManifestGate({
    manifest: selectedManifest,
    packageArtifactRoot,
    gateResults: gates,
    authorityPath: KFD_ADOPTER_MANIFEST_PATH,
    expectedAdopterId: KFD_ADOPTER_ID,
    expectedSourceRepository: KFD_ADOPTER_ID,
    expectedSourceSha: sourceSha,
    checkedAt,
    maxAgeSeconds: MAX_AGE_SECONDS,
  });
  const gateValidation = adopterManifestRuntime.validateKfdAdopterManifestGate(
    gate,
    {
      expectedAdopterId: KFD_ADOPTER_ID,
      expectedSourceRepository: KFD_ADOPTER_ID,
      expectedSourceSha: sourceSha,
      checkedAt,
    },
  );
  if (!gateValidation.valid || gate.status !== 'passed') {
    throw new Error(
      `Kungfu KFD adopter gate failed: ${JSON.stringify(gate.issues || gateValidation.issues)}`,
    );
  }
  const projection =
    adopterManifestRuntime.createKfdLegacySupportMatrixProjection({
      manifest: selectedManifest,
      manifestGate: gate,
    });
  const projectionValidation =
    adopterManifestRuntime.validateKfdLegacySupportMatrixProjection(
      projection,
      { manifest: selectedManifest, manifestGate: gate },
    );
  if (!projectionValidation.valid) {
    throw new Error(
      `Kungfu KFD support projection failed: ${JSON.stringify(projectionValidation.issues)}`,
    );
  }
  return { manifest: selectedManifest, gate, projection };
}

export function resolveKungfuKfdAdopterClosure({
  root,
  sourceSha,
  checkedAt,
  gates,
  write,
}) {
  const closure = createKungfuKfdAdopterClosure({
    root,
    sourceSha,
    checkedAt,
    gates,
    manifest: write ? undefined : readKungfuKfdAdopterManifest(root),
  });
  if (write) writeKungfuKfdAdopterClosure(root, closure);
  return closure;
}

export function renderKfdSupportDocument(matrix) {
  const rows = matrix.rows
    .map(
      (row) =>
        `| ${row.id} | ${row.declaration.state} | ${row.declaration.usage} | ${row.implementation.status} | ${row.verification.status} | ${row.buildchain.gateStatus} | ${row.nextGate} |`,
    )
    .join('\n');
  return `# Kungfu KFD support matrix\n\nThis document is a deterministic projection of \`${KFD_ADOPTER_MANIFEST_PATH}\` and its exact passing Buildchain gate. The standard full-cut manifest is the sole Kungfu adoption declaration authority; this page, the SDK copy, CLI output, Release Passport and legacy matrix cannot widen it.\n\n| Standard | State | Usage | Implementation | Verification | Buildchain | Next gate |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows}\n\n## Claim boundary\n\n- Candidate rows retain implementation and verification evidence without claiming completed adoption or shipment.\n- KFD-6 is explicitly unsupported and unused.\n- KFD-8 through KFD-13 retain draft evidence only; draft evidence cannot activate a decision.\n- The manifest gate is non-qualifying and non-self-certifying. Runtime permission, release authority and independent certification remain separate.\n\n## Inspect this source with Shifu\n\nRun \`./shifu kfd status --json\` for the source projection and \`./shifu kfd check --json\` to verify the manifest, gate, evidence roots and every compatibility projection.\n`;
}

export function kungfuKfdAdopterClosureOutputs(closure) {
  const gate = closure.gate || closure.manifestGate;
  return [
    [KFD_ADOPTER_MANIFEST_PATH, closure.manifest],
    [KFD_ADOPTER_MANIFEST_GATE_PATH, gate],
    [KFD_SUPPORT_MATRIX_PATH, closure.projection],
    [SDK_KFD_ADOPTER_MANIFEST_PATH, closure.manifest],
    [SDK_KFD_ADOPTER_MANIFEST_GATE_PATH, gate],
    [SDK_KFD_SUPPORT_MATRIX_PATH, closure.projection],
  ];
}

export function assertKungfuKfdAdopterClosureCurrent(
  root,
  closure,
  assertCurrent,
) {
  for (const [relative, value] of kungfuKfdAdopterClosureOutputs(closure)) {
    assertCurrent(
      path.join(root, relative),
      value,
      `KFD adopter closure ${relative}`,
    );
  }
}

export function writeKungfuKfdAdopterClosure(root, closure) {
  for (const [relative, value] of kungfuKfdAdopterClosureOutputs(closure)) {
    writeJson(path.join(root, relative), value);
  }
  const docPath = path.join(root, DOC_KFD_SUPPORT_MATRIX_PATH);
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  fs.writeFileSync(docPath, renderKfdSupportDocument(closure.projection));
}

export function readKungfuKfdAdopterManifest(root) {
  return readJson(path.join(root, KFD_ADOPTER_MANIFEST_PATH));
}
