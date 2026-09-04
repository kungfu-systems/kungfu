// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { semanticRoot } from '@kungfu-tech/spec/format/project-cut-canonical-json';

export const EVIDENCE_ENVELOPE_SCHEMA = 'kungfu.evidence-envelope/v1';

const KINDS = new Set(['receipt', 'witness', 'claim', 'manifest']);
const RECEIPT_TYPES = new Set([
  'project.cut.receipt/v1',
  'project.cut.composition/v1',
  'project.cut.settlement-action-receipt/v1',
]);
const TYPE = /^[a-z0-9][a-z0-9._-]*\/v[1-9][0-9]*$/u;
const ROOT = /^sha256:[0-9a-f]{64}$/u;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const KEYS = [
  'schema',
  'kind',
  'type',
  'subject',
  'basis',
  'disposition',
  'evidence',
  'diagnostics',
  'limitations',
  'observedAt',
  'envelopeRoot',
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function diagnostic(code, path, message) {
  return { code, path, message };
}

function orderedDiagnostics(values) {
  return [...values].sort((left, right) =>
    Buffer.compare(
      Buffer.from(`${left.path}\0${left.code}\0${left.message}`, 'utf8'),
      Buffer.from(`${right.path}\0${right.code}\0${right.message}`, 'utf8'),
    ),
  );
}

function validatePreimage(value) {
  const diagnostics = [];
  if (value.schema !== EVIDENCE_ENVELOPE_SCHEMA)
    diagnostics.push(
      diagnostic('unknown-version', '$.schema', 'unsupported envelope schema'),
    );
  if (!KINDS.has(value.kind))
    diagnostics.push(
      diagnostic('invalid-kind', '$.kind', 'unsupported evidence kind'),
    );
  if (!TYPE.test(String(value.type ?? '')))
    diagnostics.push(
      diagnostic('invalid-type', '$.type', 'typed payload schema is required'),
    );
  if (RECEIPT_TYPES.has(value.type) && value.kind !== 'receipt')
    diagnostics.push(
      diagnostic(
        'kind-type-mismatch',
        '$.kind',
        'Project Cut receipt payloads retain receipt epistemic kind',
      ),
    );
  for (const field of ['subject', 'basis', 'disposition', 'evidence']) {
    if (!isObject(value[field]))
      diagnostics.push(
        diagnostic('invalid-field', `$.${field}`, `${field} must be an object`),
      );
  }
  if (
    isObject(value.evidence) &&
    String(value.evidence.schema ?? '') !== value.type
  )
    diagnostics.push(
      diagnostic(
        'payload-type-mismatch',
        '$.evidence.schema',
        'payload schema must equal envelope type',
      ),
    );
  for (const field of ['diagnostics', 'limitations']) {
    if (!Array.isArray(value[field]))
      diagnostics.push(
        diagnostic('invalid-field', `$.${field}`, `${field} must be an array`),
      );
  }
  if (
    Array.isArray(value.limitations) &&
    value.limitations.some(
      (entry) => typeof entry !== 'string' || entry.length === 0,
    )
  )
    diagnostics.push(
      diagnostic(
        'invalid-limitation',
        '$.limitations',
        'limitations must be non-empty strings',
      ),
    );
  if (
    value.observedAt !== null &&
    (typeof value.observedAt !== 'string' ||
      !RFC3339.test(value.observedAt) ||
      Number.isNaN(Date.parse(value.observedAt)))
  )
    diagnostics.push(
      diagnostic(
        'invalid-observation-time',
        '$.observedAt',
        'observedAt must be null or an RFC 3339 timestamp',
      ),
    );
  return orderedDiagnostics(diagnostics);
}

export function createEvidenceEnvelope(input) {
  const preimage = {
    schema: EVIDENCE_ENVELOPE_SCHEMA,
    kind: input.kind,
    type: input.type,
    subject: structuredClone(input.subject),
    basis: structuredClone(input.basis),
    disposition: structuredClone(input.disposition),
    evidence: structuredClone(input.evidence),
    diagnostics: structuredClone(input.diagnostics ?? []),
    limitations: structuredClone(input.limitations ?? []),
    observedAt: input.observedAt ?? null,
  };
  const diagnostics = validatePreimage(preimage);
  if (diagnostics.length > 0)
    throw Object.assign(new Error('invalid evidence envelope'), {
      code: 'evidence-envelope-invalid',
      diagnostics,
    });
  return { ...preimage, envelopeRoot: semanticRoot(preimage) };
}

export function verifyEvidenceEnvelope(value) {
  const diagnostics = [];
  if (!isObject(value))
    return {
      valid: false,
      diagnostics: [
        diagnostic('invalid-field', '$', 'envelope must be an object'),
      ],
    };
  const keys = Object.keys(value).sort();
  const expectedKeys = [...KEYS].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  )
    diagnostics.push(
      diagnostic(
        'unexpected-fields',
        '$',
        'envelope fields must match the v1 contract exactly',
      ),
    );
  diagnostics.push(...validatePreimage(value));
  if (!ROOT.test(String(value.envelopeRoot ?? '')))
    diagnostics.push(
      diagnostic('missing-root', '$.envelopeRoot', 'envelope root is required'),
    );
  else {
    const { envelopeRoot, ...preimage } = value;
    try {
      if (semanticRoot(preimage) !== envelopeRoot)
        diagnostics.push(
          diagnostic(
            'root-mismatch',
            '$.envelopeRoot',
            'envelope root differs',
          ),
        );
    } catch (error) {
      diagnostics.push(
        diagnostic(
          error?.code ?? 'canonicalization-failed',
          error?.path ?? '$',
          String(error.message),
        ),
      );
    }
  }
  return {
    valid: diagnostics.length === 0,
    diagnostics: orderedDiagnostics(diagnostics),
  };
}
