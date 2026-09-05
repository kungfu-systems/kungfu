// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createEvidenceEnvelope,
  verifyEvidenceEnvelope,
} from '@kungfu-tech/work/evidence';
import { semanticRoot } from '@kungfu-tech/work/project-cut';
import {
  compositionReceiptEvidence,
  projectCutReceiptEvidence,
  settlementReceiptEvidence,
} from '@kungfu-tech/work/project-cut/receipt-evidence';
import { optionalAjv2020 } from './readonly-source-toolchain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HASH = `sha256:${'a'.repeat(64)}`;
const OID = 'b'.repeat(40);
const readJson = (relative) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
const Ajv2020 = optionalAjv2020();

const projectCutReceipt = {
  schema: 'project.cut.receipt/v1',
  cutRoot: HASH,
  rootAlgorithm: 'sha256-project-cut-canonical-json-v1',
  serializationRoot: HASH,
  artifactDigest: HASH,
  schemaRoot: null,
  verdict: 'valid',
  diagnostics: [],
  publication: null,
  receiptRoot: HASH,
};

const compositionReceipt = {
  schema: 'project.cut.composition/v1',
  operation: 'scoped-compose',
  scope: {
    base: { commitOid: OID },
    target: { commitOid: OID },
  },
  inputs: [{ cutRoot: HASH }],
  mappings: [],
  output: {},
  omissions: [],
  conflicts: [],
  diagnostics: [],
  status: 'qualified',
  compositionRoot: HASH,
};

const settlementReceipt = {
  schema: 'project.cut.settlement-action-receipt/v1',
  action: 'verify',
  outcome: 'verified',
  planRoot: HASH,
  cutRoot: HASH,
  sourceProjectionRoot: HASH,
  atlasRoot: HASH,
  indexTreeOid: OID,
  observedCommitOid: null,
  effects: [],
  diagnostics: [],
  receiptRoot: HASH,
};

test('Project Cut receipt families share one typed evidence envelope', () => {
  const envelopes = [
    projectCutReceiptEvidence(projectCutReceipt),
    compositionReceiptEvidence(compositionReceipt),
    settlementReceiptEvidence(settlementReceipt),
  ];
  const envelopeSchema = readJson(
    'framework/work/evidence/schema/evidence-envelope-v1.schema.json',
  );
  const validateEnvelope = Ajv2020
    ? new Ajv2020({
        allErrors: true,
        strict: false,
        validateFormats: false,
      }).compile(envelopeSchema)
    : null;
  for (const envelope of envelopes) {
    if (validateEnvelope)
      assert.equal(
        validateEnvelope(envelope),
        true,
        JSON.stringify(validateEnvelope.errors),
      );
    assert.equal(verifyEvidenceEnvelope(envelope).valid, true);
    assert.equal(envelope.kind, 'receipt');
    assert.equal(envelope.type, envelope.evidence.schema);
    assert.equal(envelope.observedAt, null);
  }
  assert.deepEqual(
    new Set(envelopes.map((envelope) => envelope.type)),
    new Set([
      'project.cut.receipt/v1',
      'project.cut.composition/v1',
      'project.cut.settlement-action-receipt/v1',
    ]),
  );
});

test('typed payload schemas stay independently valid', (t) => {
  if (!Ajv2020) {
    t.skip('ajv is not installed; CI enforces JSON Schema conformance');
    return;
  }
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
  });
  for (const [relative, payload] of [
    [
      'framework/work/project-cut/schema/project-cut-receipt-v1.schema.json',
      projectCutReceipt,
    ],
    [
      'framework/work/project-cut/schema/composition-v1.schema.json',
      compositionReceipt,
    ],
    [
      'framework/work/project-cut/schema/settlement-action-receipt-v1.schema.json',
      settlementReceipt,
    ],
  ]) {
    const validate = ajv.compile(readJson(relative));
    assert.equal(validate(payload), true, JSON.stringify(validate.errors));
  }
});

test('receipt, witness, claim, and manifest remain non-substitutable kinds', () => {
  const envelope = projectCutReceiptEvidence(projectCutReceipt);
  const mislabeled = { ...envelope, kind: 'claim' };
  const { envelopeRoot: _root, ...preimage } = mislabeled;
  mislabeled.envelopeRoot = semanticRoot(preimage);
  const result = verifyEvidenceEnvelope(mislabeled);
  assert.equal(result.valid, false);
  assert.ok(
    result.diagnostics.some((entry) => entry.code === 'kind-type-mismatch'),
  );
  assert.throws(
    () =>
      createEvidenceEnvelope({
        ...preimage,
        kind: 'manifest',
      }),
    { code: 'evidence-envelope-invalid' },
  );
});

test('observation time requires an explicit RFC 3339 timestamp', () => {
  assert.throws(
    () =>
      projectCutReceiptEvidence(projectCutReceipt, {
        observedAt: '2026-07-24',
      }),
    { code: 'evidence-envelope-invalid' },
  );
  assert.equal(
    projectCutReceiptEvidence(projectCutReceipt, {
      observedAt: '2026-07-24T12:34:56+08:00',
    }).observedAt,
    '2026-07-24T12:34:56+08:00',
  );
});
