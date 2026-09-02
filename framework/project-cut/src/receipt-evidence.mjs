// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { createEvidenceEnvelope } from '../../evidence/index.mjs';
import { COMPOSITION_SCHEMA } from './composition.mjs';
import { PROJECT_CUT_RECEIPT_SCHEMA } from './project-cut.mjs';
import { SETTLEMENT_RECEIPT_SCHEMA } from './settlement.mjs';

function requireReceipt(receipt, schema) {
  if (
    receipt === null ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    receipt.schema !== schema
  )
    throw Object.assign(new Error(`expected typed receipt ${schema}`), {
      code: 'receipt-type-mismatch',
    });
  return receipt;
}

export function projectCutReceiptEvidence(receipt, options = {}) {
  const payload = requireReceipt(receipt, PROJECT_CUT_RECEIPT_SCHEMA);
  return createEvidenceEnvelope({
    kind: 'receipt',
    type: payload.schema,
    subject: { kind: 'project-cut', root: payload.cutRoot },
    basis: {
      artifactDigest: payload.artifactDigest,
      rootAlgorithm: payload.rootAlgorithm,
      schemaRoot: payload.schemaRoot,
      serializationRoot: payload.serializationRoot,
    },
    disposition: {
      publication: payload.publication,
      status: payload.verdict,
    },
    evidence: payload,
    diagnostics: payload.diagnostics,
    limitations: options.limitations ?? [],
    observedAt: options.observedAt ?? null,
  });
}

export function compositionReceiptEvidence(receipt, options = {}) {
  const payload = requireReceipt(receipt, COMPOSITION_SCHEMA);
  return createEvidenceEnvelope({
    kind: 'receipt',
    type: payload.schema,
    subject: {
      kind: 'project-cut-composition',
      root: payload.compositionRoot,
    },
    basis: {
      baseCommitOid: payload.scope.base.commitOid,
      inputCutRoots: payload.inputs.map((entry) => entry.cutRoot),
      operation: payload.operation,
      targetCommitOid: payload.scope.target.commitOid,
    },
    disposition: {
      conflictCount: payload.conflicts.length,
      omissionCount: payload.omissions.length,
      status: payload.status,
    },
    evidence: payload,
    diagnostics: payload.diagnostics,
    limitations: options.limitations ?? [],
    observedAt: options.observedAt ?? null,
  });
}

export function settlementReceiptEvidence(receipt, options = {}) {
  const payload = requireReceipt(receipt, SETTLEMENT_RECEIPT_SCHEMA);
  return createEvidenceEnvelope({
    kind: 'receipt',
    type: payload.schema,
    subject: { kind: 'project-cut-settlement', root: payload.cutRoot },
    basis: {
      atlasRoot: payload.atlasRoot,
      indexTreeOid: payload.indexTreeOid,
      observedCommitOid: payload.observedCommitOid,
      planRoot: payload.planRoot,
      sourceProjectionRoot: payload.sourceProjectionRoot,
    },
    disposition: {
      action: payload.action,
      effectCount: payload.effects.length,
      status: payload.outcome,
    },
    evidence: payload,
    diagnostics: payload.diagnostics,
    limitations: options.limitations ?? [],
    observedAt: options.observedAt ?? null,
  });
}
