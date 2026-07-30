// SPDX-License-Identifier: Apache-2.0

import { semanticRoot } from './lib.mjs';

function check(checks, id, passed, detail) {
  checks.push({ id, passed, detail: passed ? 'ok' : detail });
}

export function evaluateReleaseGate({
  qualification,
  report,
  lock,
  observed,
  currentProduct,
  currentAdapterDigest,
  offlineVerifierStatus,
  offline,
}) {
  const checks = [];
  check(
    checks,
    'qualification-contract',
    qualification.schema === 'kungfu.kfd-agent-hub-20-qualification/v1' &&
      qualification.claim === 'installed-kungfu-local-peer-kfd-agent-hub-20',
    'qualification contract or narrow claim drifted',
  );
  check(
    checks,
    'kfd-lock',
    semanticRoot(qualification.kfd.lock) === semanticRoot(lock) &&
      semanticRoot(qualification.kfd.observed) === semanticRoot(observed),
    'KFD package/profile/protocol/vector/inventory/verifier roots are stale',
  );
  check(
    checks,
    'adapter-artifact',
    qualification.adapter.artifactDigest === currentAdapterDigest &&
      report.adapter.artifactDigest === qualification.adapter.artifactDigest,
    'adapter digest is stale',
  );
  check(
    checks,
    'adapter-provenance',
    qualification.adapter.sourceClassification ===
      'product-command-forwarder' &&
      qualification.adapter.semanticAuthority ===
        'installed Kungfu agent hub handle command',
    'adapter widened into a semantic or source-Shifu implementation',
  );
  check(
    checks,
    'installed-product',
    semanticRoot(qualification.product) === semanticRoot(currentProduct) &&
      currentProduct.provenance === 'installed-product' &&
      currentProduct.sourcePristine === true &&
      currentProduct.sourceCommit ===
        currentProduct.releaseManifestSourceCommit,
    'installed product artifact or source provenance is stale',
  );
  check(
    checks,
    'dual-hub-isolation',
    qualification.isolation.homesDistinct === true &&
      qualification.isolation.sourceStorePresent === true &&
      qualification.isolation.targetStorePresent === true &&
      qualification.isolation.realHomeUnchanged === true &&
      semanticRoot(qualification.isolation.realHomeBefore) ===
        semanticRoot(qualification.isolation.realHomeAfter),
    'dual-Hub isolation or real-home non-mutation proof failed',
  );
  check(
    checks,
    'report-closure',
    qualification.report.digest === semanticRoot(report) &&
      qualification.report.transcriptRoot === report.execution.transcriptRoot &&
      qualification.report.resultRoot === report.execution.resultRoot &&
      report.coverage.total === 20 &&
      report.coverage.passed === 20 &&
      report.coverage.failed === 0 &&
      report.valid === true,
    'report is stale, incomplete, or not 20/20',
  );
  check(
    checks,
    'offline-verifier',
    offlineVerifierStatus === 0 && offline?.valid === true,
    'KFD offline verifier failed',
  );
  check(
    checks,
    'claim-boundary',
    qualification.qualifyingBoundary.excludes.includes('KFD certification') &&
      qualification.qualifyingBoundary.excludes.includes(
        'stable or public release',
      ) &&
      qualification.releaseGateInput === true &&
      qualification.valid === true,
    'qualification widened its claim or is not a release-gate input',
  );
  return { valid: checks.every(({ passed }) => passed), checks };
}
