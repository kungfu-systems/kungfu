#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLOSURE_ROOT = fs.realpathSync(
  process.env.KUNGFU_KFD_CLOSURE_ROOT
    ? path.resolve(process.env.KUNGFU_KFD_CLOSURE_ROOT)
    : ROOT,
);
const MANIFEST_RELATIVE = '.buildchain/kfd/adopter-manifest.json';
const GATE_RELATIVE = '.buildchain/kfd/adopter-manifest-gate.json';
const MATRIX_RELATIVE = '.buildchain/kfd/support-matrix.json';
const SDK_MANIFEST_RELATIVE = 'developer/sdk/kfd/adopter-manifest.json';
const SDK_GATE_RELATIVE = 'developer/sdk/kfd/adopter-manifest-gate.json';
const SDK_MATRIX_RELATIVE = 'developer/sdk/kfd/support-matrix.json';
const DOC_RELATIVE = 'docs/qualification/kfd-support-matrix.md';
const KFD3_REGISTRY_RELATIVE = '.buildchain/kfd/kfd-3/surfaces.json';
const KFD3_QUERY_RELATIVE = '.buildchain/kfd/kfd-3/capability-query.json';
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

function absolute(relative) {
  return path.join(CLOSURE_ROOT, relative);
}

function readJson(relative) {
  return JSON.parse(fs.readFileSync(absolute(relative), 'utf8'));
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function checkoutFile(relative, label) {
  if (!relative || path.isAbsolute(relative)) {
    fail(`${label} must use a non-empty checkout-relative path`);
  }
  const resolved = path.resolve(CLOSURE_ROOT, relative);
  if (!resolved.startsWith(`${CLOSURE_ROOT}${path.sep}`)) {
    fail(`${label} escapes the source checkout: ${relative}`);
  }
  if (!fs.existsSync(resolved)) fail(`${label} is missing: ${relative}`);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular non-symlink file: ${relative}`);
  }
  const real = fs.realpathSync(resolved);
  if (!real.startsWith(`${CLOSURE_ROOT}${path.sep}`)) {
    fail(`${label} resolves outside the source checkout: ${relative}`);
  }
  return resolved;
}

function validateLocalEvidence(manifest, sourceSha) {
  const gitPrefix = `git+https://github.com/kungfu-systems/kungfu.git@${sourceSha}#`;
  const witnessPrefix = `kungfu-systems/kungfu@${sourceSha}#`;
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
        const file = checkoutFile(relative, `${decision.id} ${group}`);
        if (sha256(fs.readFileSync(file)) !== evidence.root) {
          fail(`${decision.id} ${group} root drift: ${relative}`);
        }
      }
    }
    for (const witness of decision.witnessBindings || []) {
      if (!witness.witnessCoordinate?.startsWith(witnessPrefix)) continue;
      const relative = witness.witnessCoordinate.slice(witnessPrefix.length);
      const file = checkoutFile(relative, `${decision.id} witness`);
      if (sha256(fs.readFileSync(file)) !== witness.witnessRoot) {
        fail(`${decision.id} witness root drift: ${relative}`);
      }
    }
  }
}

function fail(message) {
  throw new Error(message);
}

function checkExact(relative, expected, label) {
  if (!fs.existsSync(absolute(relative)))
    fail(`${label} is missing: ${relative}`);
  if (fs.readFileSync(absolute(relative), 'utf8') !== expected) {
    fail(`${label} is stale: ${relative}`);
  }
}

function renderDocument(matrix) {
  const rows = matrix.rows
    .map(
      (row) =>
        `| ${row.id} | ${row.declaration.state} | ${row.declaration.usage} | ${row.implementation.status} | ${row.verification.status} | ${row.buildchain.gateStatus} | ${row.nextGate} |`,
    )
    .join('\n');
  return `# Kungfu KFD support matrix\n\nThis document is a deterministic projection of \`${MANIFEST_RELATIVE}\` and its exact passing Buildchain gate. The standard full-cut manifest is the sole Kungfu adoption declaration authority; this page, the SDK copy, CLI output, Release Passport and legacy matrix cannot widen it.\n\n| Standard | State | Usage | Implementation | Verification | Buildchain | Next gate |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows}\n\n## Claim boundary\n\n- Candidate rows retain implementation and verification evidence without claiming completed adoption or shipment.\n- KFD-6 is explicitly unsupported and unused.\n- KFD-8 through KFD-13 retain draft evidence only; draft evidence cannot activate a decision.\n- The manifest gate is non-qualifying and non-self-certifying. Runtime permission, release authority and independent certification remain separate.\n\n## Inspect this source with Shifu\n\nRun \`./shifu kfd status --json\` for the source projection and \`./shifu kfd check --json\` to verify the manifest, gate, evidence roots and every compatibility projection.\n`;
}

function validateColdClosure() {
  const manifest = readJson(MANIFEST_RELATIVE);
  const gate = readJson(GATE_RELATIVE);
  const matrix = readJson(MATRIX_RELATIVE);
  if (
    manifest.contract !== 'kfd.adopter-conformance-manifest/v1' ||
    manifest.schemaVersion !== 1 ||
    manifest.adopter?.id !== 'kungfu-systems/kungfu' ||
    manifest.claimBoundary?.declarationOnly !== true ||
    manifest.claimBoundary?.runtimePermission !== false ||
    manifest.claimBoundary?.releaseAuthorization !== false ||
    manifest.claimBoundary?.independentlyCertified !== false ||
    manifest.claimBoundary?.semanticTruth !== false
  ) {
    fail(
      'standard KFD adopter manifest identity or authority boundary is invalid',
    );
  }
  if (!Array.isArray(manifest.decisions) || manifest.decisions.length !== 13) {
    fail(
      'standard KFD adopter manifest must contain the complete KFD-1..13 cut',
    );
  }
  const expectedIds = Array.from(
    { length: 13 },
    (_, index) => `KFD-${index + 1}`,
  );
  if (
    manifest.decisions.map(({ id }) => id).join(',') !== expectedIds.join(',')
  ) {
    fail('standard KFD adopter manifest decision order or closure drifted');
  }
  const sourceSha = gate.source?.sha;
  if (
    gate.contract !== 'kungfu-buildchain-kfd-adopter-manifest-gate' ||
    gate.status !== 'passed' ||
    gate.qualifying !== false ||
    gate.selfCertified !== false ||
    gate.adopter?.id !== manifest.adopter.id ||
    gate.source?.repository !== manifest.adopter.id ||
    !SHA_PATTERN.test(sourceSha || '') ||
    gate.source?.coordinate !== `${manifest.adopter.id}@${sourceSha}` ||
    gate.standardPackage?.name !== manifest.kfdCut?.package?.name ||
    gate.standardPackage?.version !== manifest.kfdCut?.package?.version ||
    gate.standardPackage?.artifactRoot !==
      manifest.kfdCut?.package?.artifactRoot ||
    gate.standardPackage?.registryRoot !== manifest.kfdCut?.registry?.root ||
    gate.standardPackage?.verifierSetRoot !==
      manifest.kfdCut?.verifierSetRoot ||
    gate.authority?.path !== MANIFEST_RELATIVE ||
    gate.authority?.contract !== manifest.contract ||
    !ROOT_PATTERN.test(gate.authority?.manifestRoot || '') ||
    !ROOT_PATTERN.test(gate.gateRoot || '') ||
    (gate.issues || []).length !== 0
  ) {
    fail('standard KFD adopter manifest gate identity or exact cut drifted');
  }
  const gateStandards = (gate.gateResults || []).map(
    ({ standard }) => standard,
  );
  if (gateStandards.join(',') !== 'kfd-4,kfd-5,kfd-7') {
    fail('standard KFD adopter gate must bind exactly KFD-4, KFD-5, and KFD-7');
  }
  for (const entry of gate.gateResults) {
    if (
      entry.status !== 'passed' ||
      entry.sourceRepository !== manifest.adopter.id ||
      entry.sourceSha !== sourceSha ||
      !ROOT_PATTERN.test(entry.gateRoot || '')
    ) {
      fail(
        `${entry.standard || 'unknown'} adopter product gate projection drifted`,
      );
    }
  }
  validateLocalEvidence(manifest, sourceSha);
  if (
    matrix.contract !== 'kungfu-kfd-support-matrix' ||
    matrix.schemaVersion !== 1 ||
    matrix.authority?.path !== MANIFEST_RELATIVE ||
    matrix.authority?.contract !== manifest.contract ||
    matrix.authority?.root !== gate.authority.manifestRoot ||
    matrix.authority?.gateRoot !== gate.gateRoot ||
    matrix.authority?.adopterId !== manifest.adopter.id ||
    matrix.authority?.sourceSha !== sourceSha ||
    matrix.rows?.length !== 13
  ) {
    fail(
      'legacy KFD support projection does not bind the standard manifest authority',
    );
  }
  const manifestText = canonicalJson(manifest);
  const gateText = canonicalJson(gate);
  const matrixText = canonicalJson(matrix);
  checkExact(
    SDK_MANIFEST_RELATIVE,
    manifestText,
    'SDK adopter manifest projection',
  );
  checkExact(
    SDK_GATE_RELATIVE,
    gateText,
    'SDK adopter manifest gate projection',
  );
  checkExact(SDK_MATRIX_RELATIVE, matrixText, 'SDK support matrix projection');
  checkExact(
    DOC_RELATIVE,
    renderDocument(matrix),
    'documentation support projection',
  );
  return {
    manifest,
    gate,
    matrix,
    sourceSha,
    manifestText,
    gateText,
    matrixText,
  };
}

async function validatePublishedClosure(closure) {
  let verifier;
  let buildchain;
  try {
    verifier = await import('@kungfu-tech/kfd/adopter-conformance/toolchain');
    buildchain = await import(
      '@kungfu-tech/buildchain-alpha/kfd-adopter-manifest'
    );
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return { mode: 'cold-source' };
    throw error;
  }
  const verification = verifier.verifyAdopterManifestFromPackage(
    closure.manifest,
    {
      packageArtifactRoot: closure.manifest.kfdCut.package.artifactRoot,
      verifiedAt: closure.gate.checkedAt,
      maxAgeSeconds: closure.gate.verificationCut.maxAgeSeconds,
    },
  );
  if (!verification.valid) {
    fail(
      `published KFD verifier rejected the adopter manifest: ${JSON.stringify(verification.issues)}`,
    );
  }
  const gateValidation = buildchain.validateKfdAdopterManifestGate(
    closure.gate,
    {
      expectedAdopterId: 'kungfu-systems/kungfu',
      expectedSourceRepository: 'kungfu-systems/kungfu',
      expectedSourceSha: closure.sourceSha,
      checkedAt: closure.gate.checkedAt,
    },
  );
  if (!gateValidation.valid) {
    fail(
      `published Buildchain verifier rejected the adopter gate: ${JSON.stringify(gateValidation.issues)}`,
    );
  }
  const matrixValidation = buildchain.validateKfdLegacySupportMatrixProjection(
    closure.matrix,
    { manifest: closure.manifest, manifestGate: closure.gate },
  );
  if (!matrixValidation.valid) {
    fail(
      `published Buildchain verifier rejected the compatibility projection: ${JSON.stringify(matrixValidation.issues)}`,
    );
  }
  return {
    mode: 'published-package',
    verificationRoot: verification.reportRoot,
  };
}

function validateKfd3() {
  const registry = readJson(KFD3_REGISTRY_RELATIVE);
  const query = readJson(KFD3_QUERY_RELATIVE);
  if (
    registry.contract !== 'kungfu-buildchain-kfd-3-surface-registry' ||
    query.contract !== 'kungfu-buildchain-kfd-3-capability-query' ||
    query.status !== 'passed'
  ) {
    fail('KFD-3 registry or capability query is invalid');
  }
  const registryIds = registry.surfaces.map(({ id }) => id);
  const capabilityIds = query.capabilities.map(({ id }) => id);
  if (
    new Set(registryIds).size !== registryIds.length ||
    new Set(capabilityIds).size !== capabilityIds.length ||
    registryIds.some((id) => !capabilityIds.includes(id)) ||
    capabilityIds.some((id) => !registryIds.includes(id))
  ) {
    fail('KFD-3 declared surface set drifts from its capability query');
  }
  return { registry, query };
}

function supportGroups(matrix) {
  const rows = matrix.rows;
  return {
    adopted: rows
      .filter(({ declaration }) => declaration.state === 'adopted')
      .map(({ id }) => id),
    candidates: rows
      .filter(({ declaration }) => declaration.state === 'candidate')
      .map(({ id }) => id),
    unsupported: rows
      .filter(({ declaration }) => declaration.state === 'unsupported')
      .map(({ id }) => id),
    draftEvidenceOnly: rows
      .filter(({ declaration }) => declaration.state === 'draft-evidence')
      .map(({ id }) => id),
    notUsed: rows
      .filter(({ declaration }) => declaration.state === 'not-used')
      .map(({ id }) => id),
  };
}

function sourceReport(closure, operation, selectedId = '') {
  const { registry, query } = validateKfd3();
  const rows = selectedId
    ? closure.matrix.rows.filter(({ id }) => id === selectedId)
    : closure.matrix.rows;
  if (selectedId && rows.length === 0)
    fail(`unknown KFD standard: ${selectedId}`);
  return {
    schema: 'shifu.kfd-source-report/v1',
    ok: true,
    operation,
    verdict: 'manifest-bound-candidate-closure',
    scope: 'source-checkout',
    source: {
      repository: 'kungfu-systems/kungfu',
      revision: closure.sourceSha,
      manifest: {
        path: MANIFEST_RELATIVE,
        root: closure.gate.authority.manifestRoot,
      },
      manifestGate: { path: GATE_RELATIVE, root: closure.gate.gateRoot },
      supportMatrix: {
        path: MATRIX_RELATIVE,
        sha256: sha256(closure.matrixText),
      },
    },
    upstream: closure.matrix.upstream,
    support: supportGroups(closure.matrix),
    rows,
    selection: selectedId ? { id: selectedId, rows } : null,
    kfd3: {
      status: query.status,
      verificationMode: query.verificationMode,
      counts: query.summary,
      declaredSurfaceCount: registry.surfaces.length,
      capabilities: operation === 'query' ? query.capabilities : undefined,
    },
    proves: [
      'The standard full-cut manifest, its passing Buildchain gate, and SDK, CLI, documentation, and legacy projections agree.',
      'Every KFD-1..13 decision has exactly one explicit declaration in the pinned package cut.',
      'Candidate, unsupported, draft-evidence, and not-used states remain distinct and fail closed.',
    ],
    doesNotProve: [
      'This source result is not runtime permission, release authorization, or independent certification.',
      'Candidate and draft-evidence rows are not completed adoption or shipped support.',
    ],
    nextActions: [
      {
        audience: 'source-maintainer',
        command: './shifu kfd:buildchain:check',
        meaning:
          'Re-run the published KFD and Buildchain package verifiers over the exact closure.',
      },
    ],
  };
}

function renderHuman(report) {
  return `Kungfu KFD source — MANIFEST-BOUND CANDIDATE CLOSURE\n\nSource: ${report.source.repository}@${report.source.revision}\nManifest: ${report.source.manifest.root}\nCandidates: ${report.support.candidates.join(', ') || '<none>'}\nUnsupported: ${report.support.unsupported.join(', ') || '<none>'}\nDraft evidence only: ${report.support.draftEvidenceOnly.join(', ') || '<none>'}\n\nThis proves the exact manifest/gate/projection closure. It does not grant runtime, release, or certification authority.\n`;
}

async function run() {
  const [mode = '--check', ...args] = process.argv.slice(2);
  const closure = validateColdClosure();
  if (mode.startsWith('--source-')) {
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
    const report = sourceReport(
      closure,
      operation,
      positional[0]?.toUpperCase() || '',
    );
    process.stdout.write(json ? canonicalJson(report) : renderHuman(report));
    return;
  }
  if (!['--check', '--validate', '--write'].includes(mode) || args.length > 0) {
    fail(
      'usage: node scripts/kfd-support-matrix.mjs [--check|--validate|--write]',
    );
  }
  if (mode === '--write') {
    const result = spawnSync(
      process.execPath,
      ['scripts/buildchain-kfd-evidence.mjs', '--write'],
      { cwd: ROOT, stdio: 'inherit' },
    );
    if (result.status !== 0) process.exit(result.status || 1);
    return;
  }
  const verification = await validatePublishedClosure(closure);
  process.stdout.write(
    canonicalJson({
      ok: true,
      mode: mode.slice(2),
      verificationMode: verification.mode,
      sourceSha: closure.sourceSha,
      manifestRoot: closure.gate.authority.manifestRoot,
      manifestGateRoot: closure.gate.gateRoot,
      rowCount: closure.matrix.rows.length,
      matrixSha256: sha256(closure.matrixText),
    }),
  );
}

try {
  await run();
} catch (error) {
  const json = process.argv.includes('--json');
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    process.stdout.write(
      canonicalJson({
        schema: 'shifu.kfd-source-diagnosis/v1',
        ok: false,
        code: 'kfd-source-check-failed',
        message,
        nextActions: [
          {
            command: './shifu kfd:buildchain:check',
            meaning:
              'Verify the standard manifest and Buildchain gate closure.',
          },
        ],
      }),
    );
  } else {
    process.stderr.write(`[kfd-support-matrix] ${message}\n`);
  }
  process.exit(1);
}
