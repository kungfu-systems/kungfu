// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, parseRootJson, semanticRoot } from './project-cut.mjs';
import { verifySettlementPublication } from './publication.mjs';

export const NATIVE_LOOP_QUALIFICATION_SCHEMA =
  'kungfu.native-loop-qualification.manifest/v1';
export const NATIVE_LOOP_VERIFICATION_SCHEMA =
  'kungfu.native-loop-qualification.verification/v1';

const ROOT = /^sha256:[0-9a-f]{64}$/u;
const OID = /^[0-9a-f]{40}$/u;
const EXECUTION_CLAIM = /^execution-[0-9a-f]{24}$/u;
const DECIMAL_ID = /^[1-9][0-9]*$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MINIMUM_DEFAULT_PROMOTION_SAMPLES = 30;
const REQUIRED_FAULTS = Object.freeze([
  'duplicate-delivery',
  'generated-ledger-recursion-suppression',
  'local-cache-loss-recovery',
  'mismatched-head',
  'mismatched-merge',
  'missing-evidence',
  'publication-failure',
  'publication-retry',
]);
const AUTHORITIES = Object.freeze({
  workControl: 'kungfu-native-runtime',
  buildchain: 'evidence-producer',
  github: 'protected-delivery-transport',
  projectCut: 'portable-settlement-projection',
  git: 'qualified-git-shadow',
  atlas: 'client-coordinate-mirror',
});
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_CUT_ROOT = path.resolve(HERE, '..');
const CONTRACT_PATH = path.join(
  PROJECT_CUT_ROOT,
  'native-loop-qualification.contract.json',
);
const SCHEMA_PATH = path.join(
  PROJECT_CUT_ROOT,
  'schema/native-loop-qualification-v1.schema.json',
);

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function diagnostic(code, at, message) {
  return { code, path: at, message };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys, at, diagnostics) {
  if (!isObject(value)) {
    diagnostics.push(diagnostic('invalid-type', at, 'expected object'));
    return false;
  }
  const expected = [...keys].sort(compareUtf8);
  const actual = Object.keys(value).sort(compareUtf8);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    diagnostics.push(
      diagnostic('object-shape-mismatch', at, 'object keys differ'),
    );
    return false;
  }
  return true;
}

function requireText(value, at, diagnostics, pattern = null) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    (pattern !== null && !pattern.test(value))
  )
    diagnostics.push(diagnostic('invalid-value', at, 'invalid string value'));
}

function requireRoot(value, at, diagnostics) {
  requireText(value, at, diagnostics, ROOT);
}

function requireOid(value, at, diagnostics) {
  requireText(value, at, diagnostics, OID);
}

function requirePositiveInteger(value, at, diagnostics) {
  if (!Number.isSafeInteger(value) || value < 1)
    diagnostics.push(
      diagnostic('invalid-value', at, 'expected positive safe integer'),
    );
}

function requireNonNegativeInteger(value, at, diagnostics) {
  if (!Number.isSafeInteger(value) || value < 0)
    diagnostics.push(
      diagnostic('invalid-value', at, 'expected non-negative safe integer'),
    );
}

function requireRootSet(value, at, diagnostics) {
  if (!Array.isArray(value) || value.length === 0) {
    diagnostics.push(
      diagnostic('invalid-value', at, 'expected non-empty root set'),
    );
    return;
  }
  value.forEach((entry, index) =>
    requireRoot(entry, `${at}[${index}]`, diagnostics),
  );
  const sorted = [...new Set(value)].sort(compareUtf8);
  if (canonicalJson(value) !== canonicalJson(sorted))
    diagnostics.push(
      diagnostic('non-canonical-set', at, 'roots must be sorted and unique'),
    );
}

function requireTimestamp(value, at, diagnostics) {
  requireText(value, at, diagnostics);
  if (typeof value === 'string' && !Number.isFinite(Date.parse(value)))
    diagnostics.push(diagnostic('invalid-value', at, 'invalid timestamp'));
}

function validatePullRequest(value, at, diagnostics) {
  if (
    !exactKeys(value, ['number', 'headSha', 'mergeCommitSha'], at, diagnostics)
  )
    return;
  requirePositiveInteger(value.number, `${at}.number`, diagnostics);
  requireOid(value.headSha, `${at}.headSha`, diagnostics);
  requireOid(value.mergeCommitSha, `${at}.mergeCommitSha`, diagnostics);
}

function validateManifestShape(manifest) {
  const diagnostics = [];
  if (
    !exactKeys(
      manifest,
      [
        'schema',
        'assignment',
        'delivery',
        'native',
        'settlement',
        'ledger',
        'faults',
        'cleanClone',
        'policy',
        'authorities',
        'status',
      ],
      '$',
      diagnostics,
    )
  )
    return diagnostics;
  if (manifest.schema !== NATIVE_LOOP_QUALIFICATION_SCHEMA)
    diagnostics.push(
      diagnostic('unknown-version', '$.schema', 'unsupported manifest schema'),
    );
  if (
    exactKeys(
      manifest.assignment,
      [
        'initiativeId',
        'assignmentId',
        'requestRoot',
        'captureReceiptRoots',
        'workDefinitionRoot',
        'executionClaimId',
        'executionLeaseId',
      ],
      '$.assignment',
      diagnostics,
    )
  ) {
    requireText(
      manifest.assignment.initiativeId,
      '$.assignment.initiativeId',
      diagnostics,
    );
    requireText(
      manifest.assignment.assignmentId,
      '$.assignment.assignmentId',
      diagnostics,
    );
    requireRoot(
      manifest.assignment.requestRoot,
      '$.assignment.requestRoot',
      diagnostics,
    );
    requireRootSet(
      manifest.assignment.captureReceiptRoots,
      '$.assignment.captureReceiptRoots',
      diagnostics,
    );
    requireRoot(
      manifest.assignment.workDefinitionRoot,
      '$.assignment.workDefinitionRoot',
      diagnostics,
    );
    requireText(
      manifest.assignment.executionClaimId,
      '$.assignment.executionClaimId',
      diagnostics,
      EXECUTION_CLAIM,
    );
    requireText(
      manifest.assignment.executionLeaseId,
      '$.assignment.executionLeaseId',
      diagnostics,
    );
  }
  if (
    exactKeys(
      manifest.delivery,
      [
        'evidenceClass',
        'repository',
        'sourceCommit',
        'pullRequest',
        'workflow',
        'buildchain',
        'mergeQueue',
        'timestamps',
        'ingestionLagSeconds',
      ],
      '$.delivery',
      diagnostics,
    )
  ) {
    if (manifest.delivery.evidenceClass !== 'real-protected-run')
      diagnostics.push(
        diagnostic(
          'synthetic-success-path',
          '$.delivery.evidenceClass',
          'qualification requires one real protected run',
        ),
      );
    if (
      exactKeys(
        manifest.delivery.repository,
        ['id', 'fullName', 'targetBranch'],
        '$.delivery.repository',
        diagnostics,
      )
    ) {
      requireText(
        manifest.delivery.repository.id,
        '$.delivery.repository.id',
        diagnostics,
      );
      requireText(
        manifest.delivery.repository.fullName,
        '$.delivery.repository.fullName',
        diagnostics,
        REPOSITORY,
      );
      requireText(
        manifest.delivery.repository.targetBranch,
        '$.delivery.repository.targetBranch',
        diagnostics,
      );
    }
    requireOid(
      manifest.delivery.sourceCommit,
      '$.delivery.sourceCommit',
      diagnostics,
    );
    validatePullRequest(
      manifest.delivery.pullRequest,
      '$.delivery.pullRequest',
      diagnostics,
    );
    if (
      exactKeys(
        manifest.delivery.workflow,
        ['name', 'runId', 'attempt'],
        '$.delivery.workflow',
        diagnostics,
      )
    ) {
      requireText(
        manifest.delivery.workflow.name,
        '$.delivery.workflow.name',
        diagnostics,
      );
      requireText(
        manifest.delivery.workflow.runId,
        '$.delivery.workflow.runId',
        diagnostics,
        DECIMAL_ID,
      );
      requirePositiveInteger(
        manifest.delivery.workflow.attempt,
        '$.delivery.workflow.attempt',
        diagnostics,
      );
    }
    if (
      exactKeys(
        manifest.delivery.buildchain,
        ['receiptRoot', 'artifactRoots', 'schemaRoots'],
        '$.delivery.buildchain',
        diagnostics,
      )
    ) {
      requireRoot(
        manifest.delivery.buildchain.receiptRoot,
        '$.delivery.buildchain.receiptRoot',
        diagnostics,
      );
      requireRootSet(
        manifest.delivery.buildchain.artifactRoots,
        '$.delivery.buildchain.artifactRoots',
        diagnostics,
      );
      requireRootSet(
        manifest.delivery.buildchain.schemaRoots,
        '$.delivery.buildchain.schemaRoots',
        diagnostics,
      );
    }
    if (
      exactKeys(
        manifest.delivery.mergeQueue,
        ['attemptRoot', 'headSha', 'runId', 'attempt'],
        '$.delivery.mergeQueue',
        diagnostics,
      )
    ) {
      requireRoot(
        manifest.delivery.mergeQueue.attemptRoot,
        '$.delivery.mergeQueue.attemptRoot',
        diagnostics,
      );
      requireOid(
        manifest.delivery.mergeQueue.headSha,
        '$.delivery.mergeQueue.headSha',
        diagnostics,
      );
      requireText(
        manifest.delivery.mergeQueue.runId,
        '$.delivery.mergeQueue.runId',
        diagnostics,
        DECIMAL_ID,
      );
      requirePositiveInteger(
        manifest.delivery.mergeQueue.attempt,
        '$.delivery.mergeQueue.attempt',
        diagnostics,
      );
    }
    if (
      exactKeys(
        manifest.delivery.timestamps,
        ['mergedAt', 'runCompletedAt', 'observedAt'],
        '$.delivery.timestamps',
        diagnostics,
      )
    )
      for (const key of ['mergedAt', 'runCompletedAt', 'observedAt'])
        requireTimestamp(
          manifest.delivery.timestamps[key],
          `$.delivery.timestamps.${key}`,
          diagnostics,
        );
    requireNonNegativeInteger(
      manifest.delivery.ingestionLagSeconds,
      '$.delivery.ingestionLagSeconds',
      diagnostics,
    );
  }
  if (
    exactKeys(
      manifest.native,
      [
        'authority',
        'coordinateRoot',
        'evidenceRoot',
        'factPayloadRoot',
        'episodeId',
        'episodeRoot',
      ],
      '$.native',
      diagnostics,
    )
  ) {
    if (manifest.native.authority !== 'yijinjing-journal')
      diagnostics.push(
        diagnostic(
          'authority-mismatch',
          '$.native.authority',
          'native runtime must remain authority',
        ),
      );
    for (const key of [
      'coordinateRoot',
      'evidenceRoot',
      'factPayloadRoot',
      'episodeRoot',
    ])
      requireRoot(manifest.native[key], `$.native.${key}`, diagnostics);
    requireText(
      manifest.native.episodeId,
      '$.native.episodeId',
      diagnostics,
      DECIMAL_ID,
    );
  }
  if (
    exactKeys(
      manifest.settlement,
      ['projectCutRoot', 'receiptRoot'],
      '$.settlement',
      diagnostics,
    )
  ) {
    requireRoot(
      manifest.settlement.projectCutRoot,
      '$.settlement.projectCutRoot',
      diagnostics,
    );
    requireRoot(
      manifest.settlement.receiptRoot,
      '$.settlement.receiptRoot',
      diagnostics,
    );
  }
  if (
    exactKeys(
      manifest.ledger,
      [
        'batchRoot',
        'manifestRoot',
        'publicationLagSeconds',
        'pullRequest',
        'protectedCommit',
      ],
      '$.ledger',
      diagnostics,
    )
  ) {
    requireRoot(manifest.ledger.batchRoot, '$.ledger.batchRoot', diagnostics);
    requireRoot(
      manifest.ledger.manifestRoot,
      '$.ledger.manifestRoot',
      diagnostics,
    );
    requireNonNegativeInteger(
      manifest.ledger.publicationLagSeconds,
      '$.ledger.publicationLagSeconds',
      diagnostics,
    );
    validatePullRequest(
      manifest.ledger.pullRequest,
      '$.ledger.pullRequest',
      diagnostics,
    );
    requireOid(
      manifest.ledger.protectedCommit,
      '$.ledger.protectedCommit',
      diagnostics,
    );
  }
  if (!Array.isArray(manifest.faults)) {
    diagnostics.push(
      diagnostic('invalid-type', '$.faults', 'expected fault evidence array'),
    );
  } else {
    const ids = [];
    for (const [index, fault] of manifest.faults.entries()) {
      const at = `$.faults[${index}]`;
      if (
        !exactKeys(
          fault,
          ['id', 'mode', 'status', 'evidenceRoot'],
          at,
          diagnostics,
        )
      )
        continue;
      requireText(fault.id, `${at}.id`, diagnostics);
      ids.push(fault.id);
      if (fault.mode !== 'deterministic-fault')
        diagnostics.push(
          diagnostic('fault-mode-mismatch', `${at}.mode`, 'unexpected mode'),
        );
      if (fault.status !== 'qualified')
        diagnostics.push(
          diagnostic(
            'fault-not-qualified',
            `${at}.status`,
            'fault must be qualified',
          ),
        );
      requireRoot(fault.evidenceRoot, `${at}.evidenceRoot`, diagnostics);
    }
    if (canonicalJson(ids) !== canonicalJson(REQUIRED_FAULTS))
      diagnostics.push(
        diagnostic(
          'fault-set-mismatch',
          '$.faults',
          'required fault ids must be sorted and complete',
        ),
      );
  }
  if (
    exactKeys(
      manifest.cleanClone,
      [
        'source',
        'protectedCommit',
        'publicationVerificationRoot',
        'continuationPlanRoot',
        'verificationRoot',
        'runtimeCachePresent',
      ],
      '$.cleanClone',
      diagnostics,
    )
  ) {
    if (manifest.cleanClone.source !== 'fresh-protected-clone')
      diagnostics.push(
        diagnostic(
          'clean-clone-source-mismatch',
          '$.cleanClone.source',
          'fresh protected clone required',
        ),
      );
    requireOid(
      manifest.cleanClone.protectedCommit,
      '$.cleanClone.protectedCommit',
      diagnostics,
    );
    for (const key of [
      'publicationVerificationRoot',
      'continuationPlanRoot',
      'verificationRoot',
    ])
      requireRoot(manifest.cleanClone[key], `$.cleanClone.${key}`, diagnostics);
    if (manifest.cleanClone.runtimeCachePresent !== false)
      diagnostics.push(
        diagnostic(
          'runtime-cache-present',
          '$.cleanClone.runtimeCachePresent',
          'clean-clone proof must not use the original runtime cache',
        ),
      );
  }
  if (
    exactKeys(
      manifest.policy,
      [
        'sampleCount',
        'minimumDefaultPromotionSamples',
        'advisoryModeEligible',
        'defaultPromotionEligible',
      ],
      '$.policy',
      diagnostics,
    )
  ) {
    requireNonNegativeInteger(
      manifest.policy.sampleCount,
      '$.policy.sampleCount',
      diagnostics,
    );
    if (
      manifest.policy.minimumDefaultPromotionSamples !==
      MINIMUM_DEFAULT_PROMOTION_SAMPLES
    )
      diagnostics.push(
        diagnostic(
          'policy-threshold-mismatch',
          '$.policy.minimumDefaultPromotionSamples',
          'minimum sample threshold differs',
        ),
      );
    if (manifest.policy.advisoryModeEligible !== true)
      diagnostics.push(
        diagnostic(
          'advisory-mode-blocked',
          '$.policy.advisoryModeEligible',
          'sample count must not block advisory mode',
        ),
      );
    const expected =
      manifest.policy.sampleCount >= MINIMUM_DEFAULT_PROMOTION_SAMPLES;
    if (manifest.policy.defaultPromotionEligible !== expected)
      diagnostics.push(
        diagnostic(
          'default-promotion-policy-mismatch',
          '$.policy.defaultPromotionEligible',
          'default promotion eligibility disagrees with sample count',
        ),
      );
  }
  if (
    exactKeys(
      manifest.authorities,
      Object.keys(AUTHORITIES),
      '$.authorities',
      diagnostics,
    ) &&
    canonicalJson(manifest.authorities) !== canonicalJson(AUTHORITIES)
  )
    diagnostics.push(
      diagnostic(
        'authority-boundary-mismatch',
        '$.authorities',
        'authority boundaries differ from the contract',
      ),
    );
  if (manifest.status !== 'qualified')
    diagnostics.push(
      diagnostic('qualification-incomplete', '$.status', 'status must qualify'),
    );
  return diagnostics;
}

function git(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function repositoryRoot(rootInput) {
  return git(path.resolve(rootInput), ['rev-parse', '--show-toplevel']);
}

function publicationPath(batchRoot) {
  const hex = batchRoot.slice(7);
  return `.kungfu/ledger-publications/sha256/${hex.slice(0, 2)}/${hex}/manifest.json`;
}

function trackedJson(root, commit, file) {
  return parseRootJson(
    execFileSync('git', ['show', `${commit}:${file}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
}

function derivedEvidence(root, manifest) {
  const protectedCommit = git(root, [
    'rev-parse',
    '--verify',
    `${manifest.ledger.protectedCommit}^{commit}`,
  ]);
  const publication = verifySettlementPublication(
    root,
    manifest.ledger.batchRoot,
    { commit: protectedCommit },
  );
  const trackedManifest = trackedJson(
    root,
    protectedCommit,
    publicationPath(manifest.ledger.batchRoot),
  );
  const publicationVerificationRoot = semanticRoot(publication);
  const continuationPlan = {
    schema: 'kungfu.native-loop-qualification.continuation-plan/v1',
    action: 'continue-from-protected-settlement',
    assignmentId: manifest.assignment.assignmentId,
    protectedCommit,
    ledgerBatchRoot: manifest.ledger.batchRoot,
    priorProjectCutRoots: [manifest.settlement.projectCutRoot],
    settledHistoryAuthority: 'qualified-git-shadow',
    runtimeAuthorityRequiredForWrites: true,
  };
  const continuationPlanRoot = semanticRoot(continuationPlan);
  const cleanCloneReceipt = {
    schema: 'kungfu.native-loop-qualification.clean-clone-receipt/v1',
    source: 'fresh-protected-clone',
    protectedCommit,
    ledgerBatchRoot: manifest.ledger.batchRoot,
    ledgerManifestRoot: manifest.ledger.manifestRoot,
    projectCutRoot: manifest.settlement.projectCutRoot,
    publicationVerificationRoot,
    continuationPlanRoot,
    runtimeCachePresent: false,
  };
  return {
    protectedCommit,
    publication,
    trackedManifest,
    publicationVerificationRoot,
    continuationPlan,
    continuationPlanRoot,
    cleanCloneReceipt,
    verificationRoot: semanticRoot(cleanCloneReceipt),
  };
}

export function sealNativeLoopQualification(rootInput, input) {
  const root = repositoryRoot(rootInput);
  const manifest = structuredClone(input);
  const provisional = {
    ...manifest,
    cleanClone: {
      source: 'fresh-protected-clone',
      protectedCommit: manifest.ledger.protectedCommit,
      publicationVerificationRoot: 'sha256:'.padEnd(71, '0'),
      continuationPlanRoot: 'sha256:'.padEnd(71, '0'),
      verificationRoot: 'sha256:'.padEnd(71, '0'),
      runtimeCachePresent: false,
    },
  };
  const evidence = derivedEvidence(root, provisional);
  manifest.cleanClone = {
    source: 'fresh-protected-clone',
    protectedCommit: evidence.protectedCommit,
    publicationVerificationRoot: evidence.publicationVerificationRoot,
    continuationPlanRoot: evidence.continuationPlanRoot,
    verificationRoot: evidence.verificationRoot,
    runtimeCachePresent: false,
  };
  manifest.policy = {
    ...manifest.policy,
    minimumDefaultPromotionSamples: MINIMUM_DEFAULT_PROMOTION_SAMPLES,
    advisoryModeEligible: true,
    defaultPromotionEligible:
      manifest.policy.sampleCount >= MINIMUM_DEFAULT_PROMOTION_SAMPLES,
  };
  manifest.authorities = { ...AUTHORITIES };
  manifest.schema = NATIVE_LOOP_QUALIFICATION_SCHEMA;
  manifest.status = 'qualified';
  return {
    manifest,
    verification: verifyNativeLoopQualification(root, manifest),
  };
}

export function verifyNativeLoopQualification(rootInput, manifest) {
  const diagnostics = validateManifestShape(manifest);
  let evidence = null;
  if (diagnostics.length === 0) {
    const root = repositoryRoot(rootInput);
    try {
      evidence = derivedEvidence(root, manifest);
      if (
        manifest.delivery.sourceCommit !== manifest.delivery.pullRequest.headSha
      )
        diagnostics.push(
          diagnostic(
            'source-head-mismatch',
            '$.delivery.sourceCommit',
            'source commit must equal protected pull-request head',
          ),
        );
      if (
        manifest.delivery.mergeQueue.headSha !==
        manifest.delivery.pullRequest.mergeCommitSha
      )
        diagnostics.push(
          diagnostic(
            'merge-queue-head-mismatch',
            '$.delivery.mergeQueue.headSha',
            'merge-group head must equal the observed merge commit',
          ),
        );
      if (
        manifest.ledger.protectedCommit !==
          manifest.ledger.pullRequest.mergeCommitSha ||
        manifest.cleanClone.protectedCommit !== manifest.ledger.protectedCommit
      )
        diagnostics.push(
          diagnostic(
            'protected-commit-mismatch',
            '$.ledger.protectedCommit',
            'ledger merge and clean-clone commits must be exact',
          ),
        );
      try {
        git(root, [
          'merge-base',
          '--is-ancestor',
          manifest.delivery.pullRequest.mergeCommitSha,
          manifest.ledger.protectedCommit,
        ]);
      } catch {
        diagnostics.push(
          diagnostic(
            'source-not-in-ledger-history',
            '$.ledger.protectedCommit',
            'ledger commit does not contain the source delivery merge',
          ),
        );
      }
      if (evidence.publication.ok !== true)
        diagnostics.push(
          diagnostic(
            'ledger-publication-invalid',
            '$.ledger.batchRoot',
            'protected ledger publication did not verify',
          ),
        );
      if (evidence.publication.manifestRoot !== manifest.ledger.manifestRoot)
        diagnostics.push(
          diagnostic(
            'ledger-manifest-root-mismatch',
            '$.ledger.manifestRoot',
            'declared ledger manifest root differs',
          ),
        );
      const selectedCuts =
        evidence.trackedManifest?.selection?.projectCuts?.map(
          (entry) => entry.cutRoot,
        ) ?? [];
      if (!selectedCuts.includes(manifest.settlement.projectCutRoot))
        diagnostics.push(
          diagnostic(
            'project-cut-not-published',
            '$.settlement.projectCutRoot',
            'ledger batch does not contain the declared Project Cut',
          ),
        );
      if (
        manifest.cleanClone.publicationVerificationRoot !==
        evidence.publicationVerificationRoot
      )
        diagnostics.push(
          diagnostic(
            'clean-clone-publication-root-mismatch',
            '$.cleanClone.publicationVerificationRoot',
            'publication verification root differs',
          ),
        );
      if (
        manifest.cleanClone.continuationPlanRoot !==
        evidence.continuationPlanRoot
      )
        diagnostics.push(
          diagnostic(
            'continuation-plan-root-mismatch',
            '$.cleanClone.continuationPlanRoot',
            'continuation plan root differs',
          ),
        );
      if (manifest.cleanClone.verificationRoot !== evidence.verificationRoot)
        diagnostics.push(
          diagnostic(
            'clean-clone-root-mismatch',
            '$.cleanClone.verificationRoot',
            'clean-clone receipt root differs',
          ),
        );
      const completed = Date.parse(manifest.delivery.timestamps.runCompletedAt);
      const merged = Date.parse(manifest.delivery.timestamps.mergedAt);
      const observed = Date.parse(manifest.delivery.timestamps.observedAt);
      if (completed > merged || merged > observed)
        diagnostics.push(
          diagnostic(
            'delivery-timestamp-order-mismatch',
            '$.delivery.timestamps',
            'merge-queue validation, protected merge, and observation timestamps are out of order',
          ),
        );
      if (
        manifest.delivery.ingestionLagSeconds !==
        Math.max(0, Math.floor((observed - merged) / 1000))
      )
        diagnostics.push(
          diagnostic(
            'ingestion-lag-mismatch',
            '$.delivery.ingestionLagSeconds',
            'ingestion lag does not match exact timestamps',
          ),
        );
    } catch (error) {
      diagnostics.push(
        diagnostic(
          error.code ?? 'qualification-readback-failed',
          '$',
          String(error.message),
        ),
      );
    }
  }
  diagnostics.sort((left, right) =>
    compareUtf8(
      `${left.path}\0${left.code}\0${left.message}`,
      `${right.path}\0${right.code}\0${right.message}`,
    ),
  );
  const report = {
    schema: NATIVE_LOOP_VERIFICATION_SCHEMA,
    ok: diagnostics.length === 0,
    qualificationRoot: semanticRoot(manifest),
    diagnostics,
    evidence: evidence
      ? {
          protectedCommit: evidence.protectedCommit,
          publicationVerificationRoot: evidence.publicationVerificationRoot,
          continuationPlanRoot: evidence.continuationPlanRoot,
          cleanCloneVerificationRoot: evidence.verificationRoot,
          runtimeRequired: false,
          authority: 'qualified-git-shadow',
        }
      : null,
  };
  return { ...report, verificationRoot: semanticRoot(report) };
}

export function checkNativeLoopQualificationContract() {
  const contract = parseRootJson(readFileSync(CONTRACT_PATH, 'utf8'));
  const schema = parseRootJson(readFileSync(SCHEMA_PATH, 'utf8'));
  if (
    contract.schema !== 'kungfu.native-loop-qualification.contract/v1' ||
    contract.manifestSchema !== NATIVE_LOOP_QUALIFICATION_SCHEMA ||
    contract.verificationSchema !== NATIVE_LOOP_VERIFICATION_SCHEMA ||
    canonicalJson(contract.authority) !== canonicalJson(AUTHORITIES) ||
    canonicalJson(contract.successPredicate.faultEvidenceRequired) !==
      canonicalJson(REQUIRED_FAULTS) ||
    contract.historyPolicy.minimumDefaultPromotionSamples !==
      MINIMUM_DEFAULT_PROMOTION_SAMPLES ||
    contract.historyPolicy.advisoryModeRemainsEligible !== true ||
    schema.$id !==
      'https://kungfu.tech/schema/native-loop-qualification-v1.schema.json'
  )
    throw Object.assign(
      new Error('native-loop qualification contract drifted'),
      { code: 'native-loop-contract-drift' },
    );
  return {
    ok: true,
    schema: 'kungfu.native-loop-qualification.contract-check/v1',
    contractRoot: semanticRoot(contract),
    schemaRoot: semanticRoot(schema),
    faultCount: REQUIRED_FAULTS.length,
    minimumDefaultPromotionSamples: MINIMUM_DEFAULT_PROMOTION_SAMPLES,
    advisoryModeEligible: true,
  };
}
