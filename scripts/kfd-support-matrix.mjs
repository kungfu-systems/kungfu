#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTHORITY_MATRIX_PATH = path.join(
  ROOT,
  '.buildchain',
  'kfd',
  'support-matrix.json',
);
const MATRIX_PATH = path.resolve(
  process.env.KUNGFU_KFD_SUPPORT_MATRIX_AUTHORITY || AUTHORITY_MATRIX_PATH,
);
const SDK_PROJECTION_PATH = path.join(
  ROOT,
  'developer',
  'sdk',
  'kfd',
  'support-matrix.json',
);
const DOC_PROJECTION_PATH = path.join(
  ROOT,
  'docs',
  'qualification',
  'kfd-support-matrix.md',
);
const KFD3_SURFACE_PATH = path.resolve(
  process.env.KUNGFU_KFD3_SURFACE_AUTHORITY ||
    path.join(ROOT, '.buildchain', 'kfd', 'kfd-3', 'surfaces.json'),
);
const KFD3_QUERY_PATH = path.resolve(
  process.env.KUNGFU_KFD3_QUERY_AUTHORITY ||
    path.join(ROOT, '.buildchain', 'kfd', 'kfd-3', 'capability-query.json'),
);
const PRODUCT_PACKAGE_PATH = path.join(ROOT, 'product', 'package.json');
const require = createRequire(import.meta.url);
let KFD_ROOT = '';
try {
  KFD_ROOT = path.dirname(require.resolve('@kungfu-tech/kfd/package.json'));
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND') throw error;
}
const STANDARDS_PATH = KFD_ROOT && path.join(KFD_ROOT, 'standards.json');
const RELEASE_ANCHOR_PATH = KFD_ROOT && path.join(KFD_ROOT, 'kfd.release.json');
const KFD_PACKAGE_PATH = KFD_ROOT && path.join(KFD_ROOT, 'package.json');

function sha256Buffer(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function checkoutFile(relativePath, label) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath)
  ) {
    fail(`${label} must be a non-empty checkout-relative path`);
  }
  const resolved = path.resolve(ROOT, relativePath);
  if (!resolved.startsWith(`${ROOT}${path.sep}`)) {
    fail(`${label} escapes the source checkout: ${relativePath}`);
  }
  if (fs.existsSync(resolved)) {
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(`${ROOT}${path.sep}`)) {
      fail(`${label} resolves outside the source checkout: ${relativePath}`);
    }
  }
  return resolved;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fail(message) {
  throw new Error(message);
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validateMatrix(matrix, { verifyInstalledKfd = true } = {}) {
  if (matrix.contract !== 'kungfu-kfd-support-matrix') {
    fail(
      `unexpected support matrix contract: ${matrix.contract || '<missing>'}`,
    );
  }
  if (!Array.isArray(matrix.rows) || matrix.rows.length !== 13) {
    fail(
      `support matrix must contain exactly 13 rows, found ${matrix.rows?.length || 0}`,
    );
  }

  const useInstalledKfd = verifyInstalledKfd && Boolean(KFD_ROOT);
  const coldAuthority = useInstalledKfd
    ? null
    : readJson(AUTHORITY_MATRIX_PATH);
  const standards = useInstalledKfd ? readJson(STANDARDS_PATH) : null;
  const kfdPackage = useInstalledKfd ? readJson(KFD_PACKAGE_PATH) : null;
  const releaseAnchor = useInstalledKfd ? readJson(RELEASE_ANCHOR_PATH) : null;
  const expectedUpstream = useInstalledKfd
    ? {
        version: kfdPackage.version,
        line: releaseAnchor.line,
        channel: releaseAnchor.channel,
        standardsSha256: sha256File(STANDARDS_PATH),
        releaseAnchorSha256: sha256File(RELEASE_ANCHOR_PATH),
      }
    : coldAuthority.upstream;
  const expectedKeys = Array.from(
    { length: 13 },
    (_, index) => `kfd-${index + 1}`,
  );
  const actualKeys = matrix.rows.map((row) => row.key);
  if (new Set(actualKeys).size !== actualKeys.length) {
    fail('support matrix contains duplicate KFD keys');
  }
  if (actualKeys.join(',') !== expectedKeys.join(',')) {
    fail(
      `support matrix rows must be ordered kfd-1 through kfd-13, found ${actualKeys.join(',')}`,
    );
  }
  if (matrix.upstream.version !== expectedUpstream.version) {
    fail(
      `KFD package version drift: matrix=${matrix.upstream.version} expected=${expectedUpstream.version}`,
    );
  }
  if (matrix.upstream.line !== expectedUpstream.line) {
    fail(
      `KFD release line drift: matrix=${matrix.upstream.line} expected=${expectedUpstream.line}`,
    );
  }
  if (matrix.upstream.channel !== expectedUpstream.channel) {
    fail(
      `KFD release channel drift: matrix=${matrix.upstream.channel} expected=${expectedUpstream.channel}`,
    );
  }
  if (matrix.upstream.standardsSha256 !== expectedUpstream.standardsSha256) {
    fail('installed KFD standards.json root does not match the support matrix');
  }
  if (
    matrix.upstream.releaseAnchorSha256 !== expectedUpstream.releaseAnchorSha256
  ) {
    fail('installed KFD release anchor root does not match the support matrix');
  }

  for (const row of matrix.rows) {
    const standard = useInstalledKfd
      ? standards.standards?.[row.key]
      : coldAuthority.rows.find((entry) => entry.key === row.key)?.normative;
    if (!standard) fail(`${row.key} is absent from KFD normative metadata`);
    const expectedId = row.key.toUpperCase();
    if (row.id !== expectedId) fail(`${row.key} id must be ${expectedId}`);
    if (
      row.normative.status !== standard.status ||
      row.normative.revision !== standard.revision ||
      row.normative.documentSha256 !==
        (useInstalledKfd
          ? `sha256:${standard.document.sha256}`
          : standard.documentSha256)
    ) {
      fail(`${row.key} normative projection drifts from KFD metadata`);
    }
    const missingDimension = [
      typeof row.implementation?.status !== 'string',
      !Array.isArray(row.implementation?.surfaces),
      typeof row.verification?.status !== 'string',
      !Array.isArray(row.verification?.evidenceRoots),
      typeof row.buildchain?.gateStatus !== 'string',
      typeof row.buildchain?.protocol !== 'string',
      typeof row.exposure?.sdk !== 'string',
      typeof row.exposure?.cli !== 'string',
      typeof row.exposure?.docs !== 'string',
      typeof row.releaseQualification?.status !== 'string',
      typeof row.releaseQualification?.shippedSupport !== 'boolean',
      !Array.isArray(row.releaseQualification?.evidenceRoots),
      typeof row.claimClass !== 'string',
      !Array.isArray(row.knownLimitations),
      typeof row.owner !== 'string',
      typeof row.nextGate !== 'string',
    ].some(Boolean);
    if (missingDimension) {
      fail(`${row.key} is missing one or more required support dimensions`);
    }
    for (const evidence of [
      ...row.verification.evidenceRoots,
      ...row.releaseQualification.evidenceRoots,
    ]) {
      const evidencePath = checkoutFile(evidence.path, `${row.key} evidence`);
      if (!fs.existsSync(evidencePath)) {
        fail(`${row.key} evidence is missing: ${evidence.path}`);
      }
      if (sha256File(evidencePath) !== evidence.sha256) {
        fail(`${row.key} evidence root drift: ${evidence.path}`);
      }
    }
    if (
      row.normative.status === 'draft' &&
      row.releaseQualification.shippedSupport
    ) {
      fail(`${row.key} is draft and cannot claim shipped support`);
    }
  }

  const byKey = Object.fromEntries(matrix.rows.map((row) => [row.key, row]));
  const shippedKeys = matrix.rows
    .filter((row) => row.releaseQualification.shippedSupport)
    .map((row) => row.key);
  const expectedShippedKeys = ['kfd-1', 'kfd-2', 'kfd-3', 'kfd-7'];
  if (shippedKeys.join(',') !== expectedShippedKeys.join(',')) {
    fail(
      `shipped support must remain exactly ${expectedShippedKeys.join(',')}, found ${shippedKeys.join(',') || '<none>'}`,
    );
  }
  const kfd6 = byKey['kfd-6'];
  const kfd6BoundaryDrift = [
    kfd6.supportStatus !== 'unsupported',
    kfd6.implementation.status !== 'not-implemented',
    kfd6.implementation.surfaces.length !== 0,
    kfd6.verification.status !== 'none',
    kfd6.verification.evidenceRoots.length !== 0,
    kfd6.buildchain.gateStatus !== 'not-applicable',
    kfd6.releaseQualification.status !== 'not-qualified',
    kfd6.releaseQualification.shippedSupport,
    kfd6.releaseQualification.evidenceRoots.length !== 0,
    kfd6.claimClass !== 'explicit-non-adoption',
  ].some(Boolean);
  if (kfd6BoundaryDrift) {
    fail('KFD-6 must remain an explicit unsupported non-adoption');
  }
  const kfd6Precursor = kfd6.precursorEvidence;
  const expectedKfd6PrecursorSurfaces = [
    'framework/work-design-advisor/work-design-advisor.contract.json',
    'framework/work-design-policy-replay/work-design-policy-replay.contract.json',
    'framework/project-cut/README.md',
  ];
  const expectedKfd6MissingGates = [
    'plural genesis methods and declared budgets',
    'fixed-ontology and no-new-primitive baselines',
    'systematic false-candidate rejection',
    'held-out promotion separation',
    'cross-domain transfer',
  ];
  const expectedKfd6ClaimBoundary =
    'Work Design history selection, outcome estimation, and offline policy replay are bounded advisory precursors only. They do not implement, verify, activate, or ship KFD-6 autonomous discovery.';
  const kfd6PrecursorDrift = [
    kfd6Precursor?.status !== 'non-conforming-evidence',
    kfd6Precursor.surfaces?.join(',') !==
      expectedKfd6PrecursorSurfaces.join(','),
    kfd6Precursor.evidenceRoots?.map((entry) => entry.path).join(',') !==
      expectedKfd6PrecursorSurfaces.join(','),
    kfd6Precursor.missingGates?.join(',') !==
      expectedKfd6MissingGates.join(','),
    kfd6Precursor.claimBoundary !== expectedKfd6ClaimBoundary,
  ].some(Boolean);
  if (kfd6PrecursorDrift) {
    fail('KFD-6 precursor evidence must remain bounded and non-conforming');
  }
  for (const evidence of kfd6Precursor.evidenceRoots) {
    const evidencePath = checkoutFile(
      evidence.path,
      'KFD-6 precursor evidence',
    );
    if (!fs.existsSync(evidencePath)) {
      fail(`KFD-6 precursor evidence is missing: ${evidence.path}`);
    }
    if (sha256File(evidencePath) !== evidence.sha256) {
      fail(`KFD-6 precursor evidence root drift: ${evidence.path}`);
    }
  }
  for (const key of ['kfd-4', 'kfd-5']) {
    if (
      byKey[key].supportStatus !== 'candidate' ||
      byKey[key].verification.status !== 'passed' ||
      byKey[key].buildchain.gateStatus !== 'passed' ||
      byKey[key].releaseQualification.shippedSupport
    ) {
      fail(
        `${key} must remain a verified, Buildchain-gated, non-shipped candidate until an explicit release decision`,
      );
    }
  }
  const kfd4 = byKey['kfd-4'];
  const expectedKfd4Surfaces = [
    'framework/core/src/python/kungfu/rewind/perspective.py',
    'framework/core/tests/qualification/kfd4-perspective.mjs',
  ];
  const expectedKfd4Evidence = [
    'docs/qualification/evidence/kfd-4-perspective/d73cab0d69/report.json',
    'framework/core/tests/python/test_kfd4_perspective.py',
  ];
  if (
    kfd4.implementation.surfaces.join(',') !== expectedKfd4Surfaces.join(',') ||
    kfd4.verification.evidenceRoots.map((entry) => entry.path).join(',') !==
      expectedKfd4Evidence.join(',')
  ) {
    fail('KFD-4 perspective qualification evidence drifted');
  }
  const kfd5 = byKey['kfd-5'];
  const kfd5SurfaceListRoot = sha256Buffer(
    kfd5.implementation.surfaces.join('\0'),
  );
  const kfd5EvidenceListRoot = sha256Buffer(
    kfd5.verification.evidenceRoots.map((entry) => entry.path).join('\0'),
  );
  if (
    kfd5SurfaceListRoot !==
      'sha256:997e161669402b0e6944397a8f017337b3834dd12bc06e214275cc8ebbaab7a8' ||
    kfd5EvidenceListRoot !==
      'sha256:b6ea1bdc1dd7af92a25c5bc9004e85eab6386f4225becb196159f8af6509bcf5'
  ) {
    fail('KFD-5 Primitive Management evidence drifted');
  }
  for (const key of [
    'kfd-8',
    'kfd-9',
    'kfd-10',
    'kfd-11',
    'kfd-12',
    'kfd-13',
  ]) {
    if (
      byKey[key].supportStatus !== 'draft-adopter-evidence' ||
      byKey[key].claimClass !== 'draft-adopter-evidence'
    ) {
      fail(`${key} may expose only non-conforming draft adopter evidence`);
    }
  }
  const kfd10 = byKey['kfd-10'];
  const expectedKfd10Surfaces = [
    'framework/core/src/libkungfu/src/runtime/kfx/native_authority.cpp',
    'framework/kfx/kungfu-kfx-domain-profile.contract.json',
    'framework/core/src/python/kungfu/storage/kfx_service.py',
  ];
  const expectedKfd10Evidence =
    'framework/kfx/evidence/kfd-10/runtime-warrant-adopter.json';
  const kfd10BoundaryDrift = [
    kfd10.implementation.status !== 'implemented-specialized-witness',
    kfd10.implementation.surfaces.join(',') !== expectedKfd10Surfaces.join(','),
    kfd10.verification.status !== 'non-conforming-evidence',
    kfd10.verification.evidenceRoots.length !== 1,
    kfd10.verification.evidenceRoots[0]?.path !== expectedKfd10Evidence,
    kfd10.buildchain.gateStatus !== 'not-applicable-draft',
    kfd10.releaseQualification.status !== 'forbidden-while-draft',
    kfd10.releaseQualification.shippedSupport,
    kfd10.exposure.cli !== 'not-product-exposed',
  ].some(Boolean);
  if (kfd10BoundaryDrift) {
    fail('KFD-10 specialized witness boundary drifted');
  }
  const kfd10Witness = readJson(
    checkoutFile(expectedKfd10Evidence, 'KFD-10 witness'),
  );
  const malformedKfd10Witness = [
    kfd10Witness.schema !== 'kungfu.kfx.kfd-10-adopter-evidence/v1',
    kfd10Witness.standard !== 'KFD-10',
    kfd10Witness.claimClass !== 'draft-adopter-evidence',
    kfd10Witness.normative?.status !== 'draft',
    kfd10Witness.normative?.revision !== 2,
    kfd10Witness.normative?.documentRoot !== kfd10.normative.documentSha256,
    kfd10Witness.boundary?.verificationStatus !== 'non-conforming-evidence',
    kfd10Witness.boundary?.buildchainGate !== 'not-applicable-draft',
    kfd10Witness.boundary?.releaseQualification !== 'forbidden-while-draft',
    kfd10Witness.boundary?.shippedSupport !== false,
    kfd10Witness.authoritySeparation?.capabilityGrantIsNotWarrant !== true,
    kfd10Witness.authoritySeparation?.kfdEvidenceIsNotRuntimePrivilege !== true,
    kfd10Witness.authoritySeparation?.episodeIsNotRetroactiveAuthority !== true,
    kfd10Witness.authoritySeparation?.settlementIsNotWarrant !== true,
    kfd10Witness.authoritySeparation?.recoveryOwnedByCore !== true,
    !Array.isArray(kfd10Witness.sourceRoots),
    kfd10Witness.sourceRoots?.length !== 7,
  ].some(Boolean);
  if (malformedKfd10Witness) {
    fail('KFD-10 specialized witness is malformed or claim-widened');
  }
  for (const source of kfd10Witness.sourceRoots) {
    const sourcePath = checkoutFile(source.path, 'KFD-10 witness source');
    if (
      !fs.existsSync(sourcePath) ||
      sha256File(sourcePath) !== source.sha256
    ) {
      fail(`KFD-10 witness source root drift: ${source.path}`);
    }
  }
  return matrix;
}

function validateKfd3Enforcement(matrix, query, registry) {
  const policy = matrix.kfd3Enforcement;
  if (
    policy?.schema !== 'kungfu-kfd-3-release-gate-enforcement/v1' ||
    !Array.isArray(policy?.gateBindings)
  ) {
    fail('KFD-3 enforcement policy is missing or unsupported');
  }
  if (
    query?.contract !== 'kungfu-buildchain-kfd-3-capability-query' ||
    query.status !== 'passed' ||
    query.verificationMode !== 'product-declared-registry' ||
    !Array.isArray(query.capabilities)
  ) {
    fail('KFD-3 checked-in capability query is malformed or not passed');
  }
  if (
    registry?.contract !== 'kungfu-buildchain-kfd-3-surface-registry' ||
    !Array.isArray(registry.surfaces)
  ) {
    fail('KFD-3 checked-in surface registry is malformed');
  }

  const registryIds = registry.surfaces.map((surface) => surface.id);
  const capabilityIds = query.capabilities.map((capability) => capability.id);
  if (
    new Set(registryIds).size !== registryIds.length ||
    new Set(capabilityIds).size !== capabilityIds.length
  ) {
    fail('KFD-3 surface registry or capability query contains duplicate ids');
  }
  if (
    registryIds.length !== query.summary?.declared ||
    registryIds.length !== policy.declaredSurfaceCount
  ) {
    fail(
      `KFD-3 declared count drift: registry=${registryIds.length} query=${query.summary?.declared} policy=${policy.declaredSurfaceCount}`,
    );
  }
  if (
    registryIds.some((id) => !capabilityIds.includes(id)) ||
    capabilityIds.some((id) => !registryIds.includes(id))
  ) {
    fail('KFD-3 declared surface set drifts from the capability query');
  }

  const enforcedCapabilities = query.capabilities.filter(
    (capability) => capability.enforced === true,
  );
  if (
    enforcedCapabilities.length !== query.summary?.enforced ||
    enforcedCapabilities.length !== policy.enforcedSurfaceCount ||
    enforcedCapabilities.length !== policy.gateBindings.length
  ) {
    fail(
      `KFD-3 enforced count drift: query=${query.summary?.enforced} capabilities=${enforcedCapabilities.length} policy=${policy.enforcedSurfaceCount} bindings=${policy.gateBindings.length}`,
    );
  }
  const bindings = new Map();
  for (const binding of policy.gateBindings) {
    const surfaceId = String(binding?.surfaceId || '');
    if (!surfaceId || bindings.has(surfaceId)) {
      fail('KFD-3 enforcement gate bindings require unique surface ids');
    }
    const capability = query.capabilities.find(
      (candidate) => candidate.id === surfaceId,
    );
    if (!capability) {
      fail(`KFD-3 enforced surface disappeared: ${surfaceId}`);
    }
    if (capability.enforced !== true) {
      fail(
        `KFD-3 gate binding cannot promote a merely declared surface: ${surfaceId}`,
      );
    }
    const gate = binding.gate;
    if (
      gate?.requiredStatus !== 'passed' ||
      typeof gate.path !== 'string' ||
      typeof gate.sha256 !== 'string'
    ) {
      fail(`KFD-3 enforced surface lacks a hard release Gate: ${surfaceId}`);
    }
    const gatePath = checkoutFile(gate.path, 'KFD-3 enforced Gate');
    if (!fs.existsSync(gatePath)) {
      fail(`KFD-3 enforced Gate is missing: ${gate.path}`);
    }
    if (sha256File(gatePath) !== gate.sha256) {
      fail(`KFD-3 enforced Gate root drift: ${gate.path}`);
    }
    const gateValue = readJson(gatePath);
    if (!(gateValue.status === 'passed' || gateValue.ok === true)) {
      fail(`KFD-3 enforced Gate is not passed: ${gate.path}`);
    }
    bindings.set(surfaceId, binding);
  }
  for (const capability of enforcedCapabilities) {
    if (!bindings.has(capability.id)) {
      fail(`KFD-3 enforced surface has no hard release Gate: ${capability.id}`);
    }
  }
  return {
    schema: policy.schema,
    declaredSurfaceCount: registryIds.length,
    detectedSurfaceCount: query.summary.detected,
    enforcedSurfaceCount: enforcedCapabilities.length,
    gateBoundSurfaceCount: bindings.size,
    detectedButUnregistered: query.summary.detectedButUnregistered,
    declaredButMissing: query.summary.declaredButMissing,
    claimBoundary: policy.claimBoundary,
  };
}

function renderDocument(matrix) {
  const rows = matrix.rows
    .map(
      (row) =>
        `| ${row.id} | ${row.normative.status} r${row.normative.revision} | ${row.supportStatus} | ${row.implementation.status} | ${row.verification.status} | ${row.buildchain.gateStatus} | ${row.releaseQualification.status} | ${row.releaseQualification.shippedSupport ? 'yes' : 'no'} | ${row.nextGate} |`,
    )
    .join('\n');
  return `# Kungfu KFD support matrix

This document is generated from \`.buildchain/kfd/support-matrix.json\`. The KFD package remains the normative authority; this matrix is Kungfu's authority for adoption and support claims.

Source implementation is not the same as released support. Verification, Buildchain gating, and shipped release qualification are independent dimensions. The current Alpha release declaration ships ${matrix.rows
    .filter((row) => row.releaseQualification.shippedSupport)
    .map((row) => row.id)
    .join(
      ', ',
    )} only. The published \`v4.0.0-alpha.1\` Release Passport qualifies that exact bounded claim; every later release must carry its own passport.

| Standard | Normative | Product status | Implementation | Verification | Buildchain | Release qualification | Shipped | Next gate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

## Claim boundary

- KFD-1, KFD-2, KFD-3, and KFD-7 are the bounded shipped-support set for the current Alpha release declaration.
- KFD-3 uses Buildchain's product-declared registry audit directly. It currently has ${matrix.kfd3Enforcement.declaredSurfaceCount} declared surfaces and ${matrix.kfd3Enforcement.enforcedSurfaceCount} release-Gate-enforced surfaces. Declaration is discoverability; it is not enforcement.
- KFD-4 passes one bounded observer/contrastive-replay product gate but remains a non-shipped adoption candidate.
- KFD-5 passes the bounded Assignment adopter gate and now binds the Primitive Management Plane, sole-intake incubation passports, and derived nine-entry catalog. It remains a non-shipped candidate; Buildchain does not self-qualify or activate it.
- KFD-6 remains explicitly unsupported. The matrix retains bounded, non-conforming Work Design precursor evidence while keeping implementation, verification, activation, and shipment claims false.
- KFD-8 through KFD-13 expose only non-conforming draft adopter evidence. They are not shipped support.

## Inspect this source with Shifu

\`./shifu kfd status\` gives a human-readable support verdict. \`./shifu kfd status --json\` exposes the same facts to an Agent. \`./shifu kfd check --json\` validates the checked-in matrix, evidence roots, projections, KFD-3 declared set, and every hard-Gate binding without installing dependencies or initializing a Kungfu runtime.

These Shifu commands qualify the exact source checkout. Prepared source maintainers can run the deeper \`./shifu kfd:agent-runtime:qualify\`, \`./shifu kfd:agent-hub:qualify\`, and \`./shifu kfd:agent-hub:verify\` gates. Installed-product users should use \`kungfu agent hub qualify --output-dir <new-directory>\` and then \`kungfu agent hub verify --qualification-dir <directory>\`; source evidence does not substitute for an installed artifact result.
`;
}

function checkProjection(filePath, expected, label) {
  if (!fs.existsSync(filePath))
    fail(`${label} is missing: ${path.relative(ROOT, filePath)}`);
  const actual = fs.readFileSync(filePath, 'utf8');
  if (actual !== expected)
    fail(`${label} is stale: ${path.relative(ROOT, filePath)}`);
}

function readGitRevision() {
  const dotGit = path.join(ROOT, '.git');
  if (!fs.existsSync(dotGit)) return null;
  let gitDir = dotGit;
  if (fs.statSync(dotGit).isFile()) {
    const pointer = fs.readFileSync(dotGit, 'utf8').trim();
    if (!pointer.startsWith('gitdir:')) return null;
    gitDir = path.resolve(ROOT, pointer.slice('gitdir:'.length).trim());
  }
  const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  if (/^[0-9a-f]{40}$/u.test(head)) return head;
  if (!head.startsWith('ref: ')) return null;
  const ref = head.slice('ref: '.length);
  const commonDirPath = path.join(gitDir, 'commondir');
  const commonDir = fs.existsSync(commonDirPath)
    ? path.resolve(gitDir, fs.readFileSync(commonDirPath, 'utf8').trim())
    : gitDir;
  for (const root of [gitDir, commonDir]) {
    const loose = path.join(root, ref);
    if (fs.existsSync(loose)) {
      const value = fs.readFileSync(loose, 'utf8').trim();
      if (/^[0-9a-f]{40}$/u.test(value)) return value;
    }
  }
  const packed = path.join(commonDir, 'packed-refs');
  if (fs.existsSync(packed)) {
    for (const line of fs.readFileSync(packed, 'utf8').split(/\r?\n/u)) {
      const [value, name] = line.split(' ');
      if (name === ref && /^[0-9a-f]{40}$/u.test(value)) return value;
    }
  }
  return null;
}

function supportGroups(matrix) {
  return {
    shipped: matrix.rows
      .filter((row) => row.releaseQualification.shippedSupport)
      .map((row) => row.id),
    candidates: matrix.rows
      .filter((row) => row.supportStatus === 'candidate')
      .map((row) => row.id),
    unsupported: matrix.rows
      .filter((row) => row.supportStatus === 'unsupported')
      .map((row) => row.id),
    draftAdopterEvidenceOnly: matrix.rows
      .filter((row) => row.supportStatus === 'draft-adopter-evidence')
      .map((row) => row.id),
  };
}

function sourceReport(matrix, query, enforcement, operation, selectedId = '') {
  const product = readJson(PRODUCT_PACKAGE_PATH);
  const groups = supportGroups(matrix);
  const selectedRows = selectedId
    ? matrix.rows.filter((row) => row.id === selectedId)
    : matrix.rows;
  if (selectedId && selectedRows.length === 0) {
    fail(`unknown KFD standard: ${selectedId}`);
  }
  return {
    schema: 'shifu.kfd-source-report/v1',
    ok: true,
    operation,
    verdict: 'bounded-support',
    scope: 'source-checkout',
    source: {
      repository: 'kungfu-systems/kungfu',
      revision: readGitRevision(),
      revisionMeaning:
        'Git HEAD reference only; the authority roots below identify the checked content and may include working-tree changes.',
      productVersion: product.version,
      supportMatrix: {
        path: path.relative(ROOT, MATRIX_PATH),
        sha256: sha256File(MATRIX_PATH),
      },
      kfd3Registry: {
        path: path.relative(ROOT, KFD3_SURFACE_PATH),
        sha256: sha256File(KFD3_SURFACE_PATH),
      },
      kfd3Query: {
        path: path.relative(ROOT, KFD3_QUERY_PATH),
        sha256: sha256File(KFD3_QUERY_PATH),
      },
    },
    upstream: matrix.upstream,
    support: groups,
    rows: matrix.rows,
    selection: selectedId ? { id: selectedId, rows: selectedRows } : null,
    kfd3: {
      status: query.status,
      verificationMode: query.verificationMode,
      counts: query.summary,
      enforcement,
      capabilities: operation === 'query' ? query.capabilities : undefined,
    },
    proves: [
      'The checked-in Kungfu KFD support authority, evidence roots, SDK projection, documentation projection, and KFD-3 declared set agree.',
      'The shipped-support wording remains bounded to KFD-1, KFD-2, KFD-3, and KFD-7.',
      'Every surface classified as KFD-3 enforced has a retained passed hard release Gate.',
    ],
    doesNotProve: [
      'This source result is not an installed-product qualification or release passport.',
      'A declared KFD-3 surface is discoverable but not release-Gate-enforced.',
      'Candidate, unsupported, and draft-adopter evidence are not shipped support.',
      'This result does not claim certification, production fitness, external adoption, or another platform.',
    ],
    nextActions: [
      {
        audience: 'source-maintainer',
        command: './shifu kfd check --json',
        meaning:
          'Revalidate this checkout without dependency repair or runtime initialization.',
      },
      {
        audience: 'source-maintainer',
        command: './shifu kfd:agent-runtime:qualify',
        meaning:
          'Run the deeper Agent Runtime source qualification in a prepared checkout.',
      },
      {
        audience: 'source-maintainer',
        command: './shifu kfd:agent-hub:qualify',
        meaning:
          'Run the deeper Agent Hub release-provenance source gate in a prepared checkout.',
      },
      {
        audience: 'source-maintainer',
        command: './shifu kfd:agent-hub:verify',
        meaning:
          'Verify retained Agent Hub source-gate evidence in a prepared checkout.',
      },
      {
        audience: 'installed-product-user',
        command: 'kungfu agent hub qualify --output-dir <new-directory>',
        meaning: 'Create installed-product Agent Hub qualification evidence.',
      },
      {
        audience: 'installed-product-user',
        command: 'kungfu agent hub verify --qualification-dir <directory>',
        meaning:
          'Verify retained installed-product qualification evidence offline.',
      },
    ],
  };
}

function renderHuman(report) {
  const source = report.source;
  const lines = [
    'Kungfu KFD source support — BOUNDED SUPPORT',
    '',
    `HEAD reference: ${source.repository}@${source.revision || 'revision-unavailable'} (${report.scope}, product ${source.productVersion})`,
    `Shipped in the current Alpha declaration: ${report.support.shipped.join(', ')}`,
    `Candidates, not shipped: ${report.support.candidates.join(', ')}`,
    `Unsupported: ${report.support.unsupported.join(', ')}`,
    `Draft adopter evidence only: ${report.support.draftAdopterEvidenceOnly.join(', ')}`,
    '',
    `KFD-3: ${report.kfd3.enforcement.declaredSurfaceCount} declared, ${report.kfd3.enforcement.enforcedSurfaceCount} enforced by a retained hard release Gate.`,
    'Declared means an Agent can discover the surface. It does not mean the surface is release-Gate-enforced.',
  ];
  if (report.operation === 'query') {
    lines.push('', 'Support rows:');
    for (const row of report.selection?.rows || report.rows) {
      lines.push(
        `  ${row.id}: ${row.supportStatus}; implementation=${row.implementation.status}; verification=${row.verification.status}; Buildchain=${row.buildchain.gateStatus}; shipped=${row.releaseQualification.shippedSupport ? 'yes' : 'no'}`,
      );
    }
  }
  lines.push(
    '',
    'This proves: checked-in source authorities, evidence roots, projections, and KFD-3 enforcement bindings agree.',
    'This does not prove: installed-product qualification, universal enforcement, certification, production fitness, or external adoption.',
    '',
    'Next source check: ./shifu kfd check --json',
    'Deeper source gates (prepared checkout): ./shifu kfd:agent-runtime:qualify and ./shifu kfd:agent-hub:qualify',
    'Installed product: kungfu agent hub qualify --output-dir <new-directory>',
  );
  return `${lines.join('\n')}\n`;
}

function runSourceMode(mode, args) {
  const operation = mode.slice('--source-'.length);
  const json = args.includes('--json');
  const positional = args.filter((arg) => !arg.startsWith('-'));
  if (
    !['status', 'query', 'check'].includes(operation) ||
    args.some((arg) => arg.startsWith('-') && arg !== '--json') ||
    (operation !== 'query' && positional.length > 0) ||
    positional.length > 1
  ) {
    fail(
      'usage: node scripts/kfd-support-matrix.mjs --source-<status|query|check> [KFD-N] [--json]',
    );
  }
  const selectedId = positional[0]?.toUpperCase() || '';
  const matrix = validateMatrix(readJson(MATRIX_PATH), {
    verifyInstalledKfd: false,
  });
  const query = readJson(KFD3_QUERY_PATH);
  const registry = readJson(KFD3_SURFACE_PATH);
  const enforcement = validateKfd3Enforcement(matrix, query, registry);
  checkProjection(
    SDK_PROJECTION_PATH,
    canonicalJson(matrix),
    'SDK support matrix projection',
  );
  checkProjection(
    DOC_PROJECTION_PATH,
    renderDocument(matrix),
    'documentation support matrix projection',
  );
  const report = sourceReport(
    matrix,
    query,
    enforcement,
    operation,
    selectedId,
  );
  process.stdout.write(json ? canonicalJson(report) : renderHuman(report));
}

function main() {
  const [mode = '--check', ...args] = process.argv.slice(2);
  if (mode.startsWith('--source-')) {
    runSourceMode(mode, args);
    return;
  }
  if (!['--check', '--validate', '--write'].includes(mode) || args.length > 0) {
    fail(
      'usage: node scripts/kfd-support-matrix.mjs [--check|--validate|--write]',
    );
  }
  if (mode === '--write' && !KFD_ROOT)
    fail('KFD package is required to write support-matrix projections');
  const matrix = validateMatrix(readJson(MATRIX_PATH));
  const sdkProjection = canonicalJson(matrix);
  const docProjection = renderDocument(matrix);
  if (mode === '--write') {
    fs.mkdirSync(path.dirname(SDK_PROJECTION_PATH), { recursive: true });
    fs.mkdirSync(path.dirname(DOC_PROJECTION_PATH), { recursive: true });
    fs.writeFileSync(SDK_PROJECTION_PATH, sdkProjection);
    fs.writeFileSync(DOC_PROJECTION_PATH, docProjection);
  } else if (mode === '--check') {
    checkProjection(
      SDK_PROJECTION_PATH,
      sdkProjection,
      'SDK support matrix projection',
    );
    checkProjection(
      DOC_PROJECTION_PATH,
      docProjection,
      'documentation support matrix projection',
    );
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        mode: mode.slice(2),
        rowCount: matrix.rows.length,
        matrixSha256: sha256File(MATRIX_PATH),
        shippedSupportCount: matrix.rows.filter(
          (row) => row.releaseQualification.shippedSupport,
        ).length,
      },
      null,
      2,
    )}\n`,
  );
}

try {
  main();
} catch (error) {
  if (
    process.argv.includes('--json') &&
    process.argv.some((arg) => arg.startsWith('--source-'))
  ) {
    process.stdout.write(
      canonicalJson({
        schema: 'shifu.kfd-source-diagnosis/v1',
        ok: false,
        code: 'kfd-source-check-failed',
        message: error instanceof Error ? error.message : String(error),
        nextActions: [
          {
            command: './shifu kfd check',
            meaning: 'Run the same check with human-readable diagnostics.',
          },
        ],
      }),
    );
    process.exit(1);
  }
  process.stderr.write(
    `[kfd-support-matrix] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
