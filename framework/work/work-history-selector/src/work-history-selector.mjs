// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { canonicalJson, semanticRoot } from '../../project-cut/index.mjs';

export const WORK_HISTORY_SELECTION_REQUEST_SCHEMA =
  'kungfu.work-history.selection-request/v1';
export const WORK_HISTORY_SELECTION_MANIFEST_SCHEMA =
  'kungfu.work-history.selection-manifest/v1';
export const WORK_HISTORY_SELECTION_POLICY_SCHEMA =
  'kungfu.work-history.selection-policy/v1';
export const WORK_HISTORY_INDEX_SNAPSHOT_SCHEMA =
  'kungfu.work-history.index-snapshot/v1';
export const WORK_HISTORY_CANDIDATE_SCHEMA = 'kungfu.work-history.candidate/v1';

const ROOT = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u;
const AUTHORITY_STATES = new Set(['current', 'ambiguous', 'unknown']);
const SOURCE_STATES = new Set(['current', 'stale', 'missing']);
const VISIBILITIES = new Set(['public', 'internal', 'private-raw']);
const SUPERSESSION_STATES = new Set(['active', 'superseded', 'unknown']);
const INVALIDATION_STATES = new Set(['valid', 'invalidated', 'unknown']);
const APPLICABILITIES = new Set([
  'current-objective',
  'comparable',
  'precedent',
  'unknown',
]);
const CLASS_ORDER = new Map([
  ['current-authority', 0],
  ['recent-comparable', 1],
  ['historical-precedent', 2],
]);
const INCLUDED_CLASSES = new Set(CLASS_ORDER.keys());
const MANIFEST_CLASSES = new Set([
  ...INCLUDED_CLASSES,
  'superseded-or-invalidated',
  'unknown-applicability',
]);
const CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low', 'unknown']);
const MANIFEST_STATUSES = new Set(['complete', 'incomplete']);

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function diagnostic(code, path, message) {
  return { code, path, message };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, at, diagnostics) {
  if (!isObject(value)) {
    diagnostics.push(diagnostic('invalid-type', at, 'expected object'));
    return false;
  }
  const actual = Object.keys(value).sort(compareUtf8);
  const normalized = [...expected].sort(compareUtf8);
  if (canonicalJson(actual) !== canonicalJson(normalized)) {
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

function requireEnum(value, allowed, at, diagnostics) {
  if (!allowed.has(value))
    diagnostics.push(diagnostic('invalid-value', at, 'unsupported value'));
}

function requireRoot(value, at, diagnostics, nullable = false) {
  if (nullable && value === null) return;
  requireText(value, at, diagnostics, ROOT);
}

function requireTimestamp(value, at, diagnostics, nullable = false) {
  if (nullable && value === null) return;
  requireText(value, at, diagnostics, TIMESTAMP);
  if (
    typeof value === 'string' &&
    (!TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value)))
  )
    diagnostics.push(
      diagnostic('invalid-timestamp', at, 'expected a canonical UTC timestamp'),
    );
}

function requireNonNegativeInteger(value, at, diagnostics) {
  if (!Number.isSafeInteger(value) || value < 0)
    diagnostics.push(
      diagnostic('invalid-value', at, 'expected non-negative safe integer'),
    );
}

function requirePositiveInteger(value, at, diagnostics) {
  if (!Number.isSafeInteger(value) || value < 1)
    diagnostics.push(
      diagnostic('invalid-value', at, 'expected positive safe integer'),
    );
}

function requireCanonicalTextSet(value, at, diagnostics, pattern = null) {
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic('invalid-type', at, 'expected array'));
    return;
  }
  value.forEach((entry, index) =>
    requireText(entry, `${at}[${index}]`, diagnostics, pattern),
  );
  const normalized = [...new Set(value)].sort(compareUtf8);
  if (canonicalJson(value) !== canonicalJson(normalized))
    diagnostics.push(
      diagnostic(
        'non-canonical-set',
        at,
        'values must be UTF-8 byte sorted and unique',
      ),
    );
}

function rootPreimage(value, rootKey) {
  const { [rootKey]: _root, ...preimage } = value;
  return preimage;
}

function validateRootedValue(value, rootKey, at, diagnostics) {
  if (!isObject(value) || !ROOT.test(value[rootKey] ?? '')) return;
  if (semanticRoot(rootPreimage(value, rootKey)) !== value[rootKey])
    diagnostics.push(
      diagnostic(
        'root-mismatch',
        `${at}.${rootKey}`,
        'root differs from the canonical semantic preimage',
      ),
    );
}

function validateSnapshot(value, diagnostics) {
  if (
    !exactKeys(
      value,
      ['schema', 'snapshotRoot', 'capturedAt', 'sourceCutRoot'],
      '$.indexSnapshot',
      diagnostics,
    )
  )
    return;
  if (value.schema !== WORK_HISTORY_INDEX_SNAPSHOT_SCHEMA)
    diagnostics.push(
      diagnostic(
        'unknown-version',
        '$.indexSnapshot.schema',
        'unsupported index snapshot schema',
      ),
    );
  requireRoot(value.snapshotRoot, '$.indexSnapshot.snapshotRoot', diagnostics);
  requireTimestamp(value.capturedAt, '$.indexSnapshot.capturedAt', diagnostics);
  requireRoot(
    value.sourceCutRoot,
    '$.indexSnapshot.sourceCutRoot',
    diagnostics,
  );
  validateRootedValue(value, 'snapshotRoot', '$.indexSnapshot', diagnostics);
}

function validatePolicy(value, diagnostics) {
  if (
    !exactKeys(
      value,
      [
        'schema',
        'id',
        'version',
        'policyRoot',
        'maxSelected',
        'recentWindowSeconds',
        'maximumIndexAgeSeconds',
        'allowedAuthorityRoots',
        'allowedRecordSchemas',
        'allowedSourceIds',
        'allowedVisibilities',
      ],
      '$.policy',
      diagnostics,
    )
  )
    return;
  if (value.schema !== WORK_HISTORY_SELECTION_POLICY_SCHEMA)
    diagnostics.push(
      diagnostic(
        'unknown-version',
        '$.policy.schema',
        'unsupported selection policy schema',
      ),
    );
  requireText(value.id, '$.policy.id', diagnostics, ID);
  requirePositiveInteger(value.version, '$.policy.version', diagnostics);
  requireRoot(value.policyRoot, '$.policy.policyRoot', diagnostics);
  requirePositiveInteger(
    value.maxSelected,
    '$.policy.maxSelected',
    diagnostics,
  );
  requireNonNegativeInteger(
    value.recentWindowSeconds,
    '$.policy.recentWindowSeconds',
    diagnostics,
  );
  requireNonNegativeInteger(
    value.maximumIndexAgeSeconds,
    '$.policy.maximumIndexAgeSeconds',
    diagnostics,
  );
  requireCanonicalTextSet(
    value.allowedAuthorityRoots,
    '$.policy.allowedAuthorityRoots',
    diagnostics,
    ROOT,
  );
  requireCanonicalTextSet(
    value.allowedRecordSchemas,
    '$.policy.allowedRecordSchemas',
    diagnostics,
    ID,
  );
  requireCanonicalTextSet(
    value.allowedSourceIds,
    '$.policy.allowedSourceIds',
    diagnostics,
    ID,
  );
  requireCanonicalTextSet(
    value.allowedVisibilities,
    '$.policy.allowedVisibilities',
    diagnostics,
    ID,
  );
  if (value.allowedVisibilities.includes('private-raw'))
    diagnostics.push(
      diagnostic(
        'privacy-denied',
        '$.policy.allowedVisibilities',
        'private raw corpus cannot be admitted by selection policy',
      ),
    );
  validateRootedValue(value, 'policyRoot', '$.policy', diagnostics);
}

function validateCandidate(value, at, diagnostics) {
  if (
    !exactKeys(
      value,
      [
        'schema',
        'candidateRoot',
        'recordSchema',
        'authority',
        'source',
        'temporal',
        'supersession',
        'invalidation',
        'applicability',
        'evidenceRoots',
        'ranking',
      ],
      at,
      diagnostics,
    )
  )
    return;
  if (value.schema !== WORK_HISTORY_CANDIDATE_SCHEMA)
    diagnostics.push(
      diagnostic('unknown-version', `${at}.schema`, 'unsupported candidate'),
    );
  requireRoot(value.candidateRoot, `${at}.candidateRoot`, diagnostics);
  requireText(value.recordSchema, `${at}.recordSchema`, diagnostics, ID);
  if (
    exactKeys(
      value.authority,
      ['root', 'status'],
      `${at}.authority`,
      diagnostics,
    )
  ) {
    requireRoot(value.authority.root, `${at}.authority.root`, diagnostics);
    requireEnum(
      value.authority.status,
      AUTHORITY_STATES,
      `${at}.authority.status`,
      diagnostics,
    );
  }
  if (
    exactKeys(
      value.source,
      ['id', 'root', 'status', 'visibility'],
      `${at}.source`,
      diagnostics,
    )
  ) {
    requireText(value.source.id, `${at}.source.id`, diagnostics, ID);
    requireRoot(value.source.root, `${at}.source.root`, diagnostics);
    requireEnum(
      value.source.status,
      SOURCE_STATES,
      `${at}.source.status`,
      diagnostics,
    );
    requireEnum(
      value.source.visibility,
      VISIBILITIES,
      `${at}.source.visibility`,
      diagnostics,
    );
  }
  if (
    exactKeys(
      value.temporal,
      ['availableAt', 'indexedAt', 'completedAt'],
      `${at}.temporal`,
      diagnostics,
    )
  ) {
    requireTimestamp(
      value.temporal.availableAt,
      `${at}.temporal.availableAt`,
      diagnostics,
    );
    requireTimestamp(
      value.temporal.indexedAt,
      `${at}.temporal.indexedAt`,
      diagnostics,
    );
    requireTimestamp(
      value.temporal.completedAt,
      `${at}.temporal.completedAt`,
      diagnostics,
    );
  }
  if (
    exactKeys(
      value.supersession,
      ['status', 'at', 'replacementRoot'],
      `${at}.supersession`,
      diagnostics,
    )
  ) {
    requireEnum(
      value.supersession.status,
      SUPERSESSION_STATES,
      `${at}.supersession.status`,
      diagnostics,
    );
    requireTimestamp(
      value.supersession.at,
      `${at}.supersession.at`,
      diagnostics,
      true,
    );
    requireRoot(
      value.supersession.replacementRoot,
      `${at}.supersession.replacementRoot`,
      diagnostics,
      true,
    );
    if (
      value.supersession.status === 'superseded' &&
      (value.supersession.at === null ||
        value.supersession.replacementRoot === null)
    )
      diagnostics.push(
        diagnostic(
          'incomplete-supersession',
          `${at}.supersession`,
          'superseded candidates require time and replacement root',
        ),
      );
  }
  if (
    exactKeys(
      value.invalidation,
      ['status', 'at', 'evidenceRoot'],
      `${at}.invalidation`,
      diagnostics,
    )
  ) {
    requireEnum(
      value.invalidation.status,
      INVALIDATION_STATES,
      `${at}.invalidation.status`,
      diagnostics,
    );
    requireTimestamp(
      value.invalidation.at,
      `${at}.invalidation.at`,
      diagnostics,
      true,
    );
    requireRoot(
      value.invalidation.evidenceRoot,
      `${at}.invalidation.evidenceRoot`,
      diagnostics,
      true,
    );
    if (
      value.invalidation.status === 'invalidated' &&
      (value.invalidation.at === null ||
        value.invalidation.evidenceRoot === null)
    )
      diagnostics.push(
        diagnostic(
          'incomplete-invalidation',
          `${at}.invalidation`,
          'invalidated candidates require time and evidence root',
        ),
      );
  }
  requireEnum(
    value.applicability,
    APPLICABILITIES,
    `${at}.applicability`,
    diagnostics,
  );
  requireCanonicalTextSet(
    value.evidenceRoots,
    `${at}.evidenceRoots`,
    diagnostics,
    ROOT,
  );
  if (exactKeys(value.ranking, ['score'], `${at}.ranking`, diagnostics))
    requireNonNegativeInteger(
      value.ranking.score,
      `${at}.ranking.score`,
      diagnostics,
    );
  validateRootedValue(value, 'candidateRoot', at, diagnostics);
}

function validateRequest(request) {
  const diagnostics = [];
  if (
    !exactKeys(
      request,
      [
        'schema',
        'objectiveRoot',
        'xinfaRoot',
        'asOf',
        'indexSnapshot',
        'policy',
        'candidates',
      ],
      '$',
      diagnostics,
    )
  )
    return diagnostics;
  if (request.schema !== WORK_HISTORY_SELECTION_REQUEST_SCHEMA)
    diagnostics.push(
      diagnostic('unknown-version', '$.schema', 'unsupported request schema'),
    );
  requireRoot(request.objectiveRoot, '$.objectiveRoot', diagnostics);
  requireRoot(request.xinfaRoot, '$.xinfaRoot', diagnostics);
  requireTimestamp(request.asOf, '$.asOf', diagnostics);
  validateSnapshot(request.indexSnapshot, diagnostics);
  validatePolicy(request.policy, diagnostics);
  if (!Array.isArray(request.candidates))
    diagnostics.push(
      diagnostic('invalid-type', '$.candidates', 'expected candidate array'),
    );
  else {
    request.candidates.forEach((candidate, index) =>
      validateCandidate(candidate, `$.candidates[${index}]`, diagnostics),
    );
    const roots = request.candidates
      .map((candidate) => candidate?.candidateRoot)
      .filter((root) => typeof root === 'string');
    if (new Set(roots).size !== roots.length)
      diagnostics.push(
        diagnostic(
          'duplicate-candidate',
          '$.candidates',
          'candidate roots must be unique',
        ),
      );
  }
  return diagnostics.sort(
    (left, right) =>
      compareUtf8(left.path, right.path) || compareUtf8(left.code, right.code),
  );
}

function secondsBetween(later, earlier) {
  return (Date.parse(later) - Date.parse(earlier)) / 1000;
}

function sourceReference(candidate) {
  return {
    sourceId: candidate.source.id,
    sourceRoot: candidate.source.root,
  };
}

function excluded(candidate, classification, reasons) {
  return {
    candidateRoot: candidate.candidateRoot,
    classification,
    sourceReference: sourceReference(candidate),
    reasons: [...new Set(reasons)].sort(compareUtf8),
  };
}

function gateCandidate(candidate, request) {
  const { policy, indexSnapshot, asOf } = request;

  // Gate order is a protocol invariant. Ranking fields are not read here.
  if (
    candidate.authority.status !== 'current' ||
    !policy.allowedAuthorityRoots.includes(candidate.authority.root)
  )
    return excluded(candidate, 'unknown-applicability', [
      candidate.authority.status === 'ambiguous'
        ? 'ambiguous-authority'
        : 'unknown-or-unapproved-authority',
    ]);

  if (
    Date.parse(candidate.temporal.availableAt) > Date.parse(asOf) ||
    Date.parse(candidate.temporal.completedAt) > Date.parse(asOf)
  )
    return excluded(candidate, 'unknown-applicability', ['temporal-leakage']);
  if (
    Date.parse(candidate.temporal.completedAt) >
      Date.parse(candidate.temporal.availableAt) ||
    Date.parse(candidate.temporal.availableAt) >
      Date.parse(candidate.temporal.indexedAt)
  )
    return excluded(candidate, 'unknown-applicability', [
      'temporal-order-invalid',
    ]);
  if (
    Date.parse(candidate.temporal.availableAt) >
      Date.parse(indexSnapshot.capturedAt) ||
    Date.parse(candidate.temporal.completedAt) >
      Date.parse(indexSnapshot.capturedAt) ||
    Date.parse(candidate.temporal.indexedAt) >
      Date.parse(indexSnapshot.capturedAt) ||
    Date.parse(candidate.temporal.indexedAt) > Date.parse(asOf)
  )
    return excluded(candidate, 'unknown-applicability', [
      'index-temporal-mismatch',
    ]);

  if (!policy.allowedRecordSchemas.includes(candidate.recordSchema))
    return excluded(candidate, 'unknown-applicability', [
      'schema-incompatible',
    ]);

  if (
    candidate.source.visibility === 'private-raw' ||
    !policy.allowedVisibilities.includes(candidate.source.visibility)
  )
    return excluded(candidate, 'unknown-applicability', ['privacy-denied']);
  if (
    candidate.source.status !== 'current' ||
    !policy.allowedSourceIds.includes(candidate.source.id)
  )
    return excluded(candidate, 'unknown-applicability', [
      candidate.source.status === 'stale'
        ? 'stale-source'
        : 'missing-or-unapproved-source',
    ]);

  if (candidate.supersession.status === 'unknown')
    return excluded(candidate, 'unknown-applicability', [
      'unknown-supersession-state',
    ]);
  if (
    candidate.supersession.status === 'superseded' &&
    Date.parse(candidate.supersession.at) <= Date.parse(asOf)
  )
    return excluded(candidate, 'superseded-or-invalidated', ['superseded']);

  if (candidate.invalidation.status === 'unknown')
    return excluded(candidate, 'unknown-applicability', [
      'unknown-invalidation-state',
    ]);
  if (
    candidate.invalidation.status === 'invalidated' &&
    Date.parse(candidate.invalidation.at) <= Date.parse(asOf)
  )
    return excluded(candidate, 'superseded-or-invalidated', [
      Date.parse(candidate.invalidation.at) >
      Date.parse(indexSnapshot.capturedAt)
        ? 'invalidation-after-index'
        : 'invalidated',
    ]);

  if (candidate.evidenceRoots.length === 0)
    return excluded(candidate, 'unknown-applicability', ['missing-evidence']);

  if (candidate.applicability === 'unknown')
    return excluded(candidate, 'unknown-applicability', [
      'unknown-applicability',
    ]);

  let classification = 'historical-precedent';
  if (candidate.applicability === 'current-objective')
    classification = 'current-authority';
  else if (
    candidate.applicability === 'comparable' &&
    secondsBetween(asOf, candidate.temporal.completedAt) <=
      policy.recentWindowSeconds
  )
    classification = 'recent-comparable';
  return {
    candidateRoot: candidate.candidateRoot,
    classification,
    sourceReference: sourceReference(candidate),
    evidenceRoots: candidate.evidenceRoots,
    rank: {
      classOrder: CLASS_ORDER.get(classification),
      score: candidate.ranking.score,
      completedAt: candidate.temporal.completedAt,
    },
    reasons: [],
  };
}

function compareIncluded(left, right) {
  return (
    left.rank.classOrder - right.rank.classOrder ||
    right.rank.score - left.rank.score ||
    Date.parse(right.rank.completedAt) - Date.parse(left.rank.completedAt) ||
    compareUtf8(left.candidateRoot, right.candidateRoot)
  );
}

function validateSourceReference(value, at, diagnostics) {
  if (!exactKeys(value, ['sourceId', 'sourceRoot'], at, diagnostics)) return;
  requireText(value.sourceId, `${at}.sourceId`, diagnostics, ID);
  requireRoot(value.sourceRoot, `${at}.sourceRoot`, diagnostics);
}

function validateIncludedEntry(value, at, diagnostics) {
  if (
    !exactKeys(
      value,
      [
        'candidateRoot',
        'classification',
        'sourceReference',
        'evidenceRoots',
        'rank',
        'reasons',
      ],
      at,
      diagnostics,
    )
  )
    return;
  requireRoot(value.candidateRoot, `${at}.candidateRoot`, diagnostics);
  requireEnum(
    value.classification,
    INCLUDED_CLASSES,
    `${at}.classification`,
    diagnostics,
  );
  validateSourceReference(
    value.sourceReference,
    `${at}.sourceReference`,
    diagnostics,
  );
  requireCanonicalTextSet(
    value.evidenceRoots,
    `${at}.evidenceRoots`,
    diagnostics,
    ROOT,
  );
  if (Array.isArray(value.evidenceRoots) && value.evidenceRoots.length === 0)
    diagnostics.push(
      diagnostic(
        'missing-evidence',
        `${at}.evidenceRoots`,
        'included candidates require evidence',
      ),
    );
  if (
    exactKeys(
      value.rank,
      ['classOrder', 'score', 'completedAt'],
      `${at}.rank`,
      diagnostics,
    )
  ) {
    requireNonNegativeInteger(
      value.rank.classOrder,
      `${at}.rank.classOrder`,
      diagnostics,
    );
    requireNonNegativeInteger(
      value.rank.score,
      `${at}.rank.score`,
      diagnostics,
    );
    requireTimestamp(
      value.rank.completedAt,
      `${at}.rank.completedAt`,
      diagnostics,
    );
    if (
      INCLUDED_CLASSES.has(value.classification) &&
      value.rank.classOrder !== CLASS_ORDER.get(value.classification)
    )
      diagnostics.push(
        diagnostic(
          'classification-rank-mismatch',
          `${at}.rank.classOrder`,
          'class order differs from classification',
        ),
      );
  }
  if (!Array.isArray(value.reasons) || value.reasons.length !== 0)
    diagnostics.push(
      diagnostic(
        'included-reasons-not-empty',
        `${at}.reasons`,
        'included candidates cannot carry exclusion reasons',
      ),
    );
}

function validateExcludedEntry(value, at, diagnostics) {
  if (
    !exactKeys(
      value,
      ['candidateRoot', 'classification', 'sourceReference', 'reasons'],
      at,
      diagnostics,
    )
  )
    return;
  requireRoot(value.candidateRoot, `${at}.candidateRoot`, diagnostics);
  requireEnum(
    value.classification,
    MANIFEST_CLASSES,
    `${at}.classification`,
    diagnostics,
  );
  validateSourceReference(
    value.sourceReference,
    `${at}.sourceReference`,
    diagnostics,
  );
  requireCanonicalTextSet(value.reasons, `${at}.reasons`, diagnostics, ID);
  if (Array.isArray(value.reasons) && value.reasons.length === 0)
    diagnostics.push(
      diagnostic(
        'missing-exclusion-reason',
        `${at}.reasons`,
        'excluded candidates require at least one reason',
      ),
    );
}

function sourceReferenceOrder(left, right) {
  return (
    compareUtf8(left.sourceId, right.sourceId) ||
    compareUtf8(left.sourceRoot, right.sourceRoot)
  );
}

function requireCanonicalObjectList(value, normalized, at, diagnostics) {
  if (canonicalJson(value) !== canonicalJson(normalized))
    diagnostics.push(
      diagnostic(
        'non-canonical-set',
        at,
        'entries must be deterministically sorted and unique',
      ),
    );
}

function manifestDiagnostics(manifest) {
  const diagnostics = [];
  if (
    !exactKeys(
      manifest,
      [
        'schema',
        'advisory',
        'query',
        'xinfaRoot',
        'asOf',
        'indexSnapshot',
        'policy',
        'sourceReferences',
        'included',
        'excluded',
        'coverage',
        'status',
        'selectionRoot',
      ],
      '$',
      diagnostics,
    )
  )
    return diagnostics;
  if (manifest.schema !== WORK_HISTORY_SELECTION_MANIFEST_SCHEMA)
    diagnostics.push(
      diagnostic('unknown-version', '$.schema', 'unsupported manifest schema'),
    );
  if (
    exactKeys(
      manifest.advisory,
      ['readOnly', 'workAuthority', 'mayMutateAssignments'],
      '$.advisory',
      diagnostics,
    ) &&
    (manifest.advisory.readOnly !== true ||
      manifest.advisory.workAuthority !== false ||
      manifest.advisory.mayMutateAssignments !== false)
  )
    diagnostics.push(
      diagnostic(
        'advisory-boundary-mismatch',
        '$.advisory',
        'manifest must remain read-only and non-authoritative',
      ),
    );
  if (exactKeys(manifest.query, ['objectiveRoot'], '$.query', diagnostics))
    requireRoot(
      manifest.query.objectiveRoot,
      '$.query.objectiveRoot',
      diagnostics,
    );
  requireRoot(manifest.xinfaRoot, '$.xinfaRoot', diagnostics);
  requireTimestamp(manifest.asOf, '$.asOf', diagnostics);
  if (
    exactKeys(
      manifest.indexSnapshot,
      ['root', 'capturedAt', 'sourceCutRoot'],
      '$.indexSnapshot',
      diagnostics,
    )
  ) {
    requireRoot(
      manifest.indexSnapshot.root,
      '$.indexSnapshot.root',
      diagnostics,
    );
    requireTimestamp(
      manifest.indexSnapshot.capturedAt,
      '$.indexSnapshot.capturedAt',
      diagnostics,
    );
    requireRoot(
      manifest.indexSnapshot.sourceCutRoot,
      '$.indexSnapshot.sourceCutRoot',
      diagnostics,
    );
  }
  if (
    exactKeys(
      manifest.policy,
      ['id', 'version', 'root'],
      '$.policy',
      diagnostics,
    )
  ) {
    requireText(manifest.policy.id, '$.policy.id', diagnostics, ID);
    requirePositiveInteger(
      manifest.policy.version,
      '$.policy.version',
      diagnostics,
    );
    requireRoot(manifest.policy.root, '$.policy.root', diagnostics);
  }

  const sourceStart = diagnostics.length;
  if (!Array.isArray(manifest.sourceReferences))
    diagnostics.push(
      diagnostic('invalid-type', '$.sourceReferences', 'expected array'),
    );
  else {
    manifest.sourceReferences.forEach((entry, index) =>
      validateSourceReference(
        entry,
        `$.sourceReferences[${index}]`,
        diagnostics,
      ),
    );
    if (diagnostics.length === sourceStart) {
      const byRoot = new Map(
        manifest.sourceReferences.map((entry) => [
          `${entry.sourceId}\0${entry.sourceRoot}`,
          entry,
        ]),
      );
      requireCanonicalObjectList(
        manifest.sourceReferences,
        [...byRoot.values()].sort(sourceReferenceOrder),
        '$.sourceReferences',
        diagnostics,
      );
    }
  }
  const sourceReferencesValid =
    Array.isArray(manifest.sourceReferences) &&
    diagnostics.length === sourceStart;

  const includedStart = diagnostics.length;
  if (!Array.isArray(manifest.included))
    diagnostics.push(
      diagnostic('invalid-type', '$.included', 'expected array'),
    );
  else {
    manifest.included.forEach((entry, index) =>
      validateIncludedEntry(entry, `$.included[${index}]`, diagnostics),
    );
    if (diagnostics.length === includedStart)
      requireCanonicalObjectList(
        manifest.included,
        [...manifest.included].sort(compareIncluded),
        '$.included',
        diagnostics,
      );
  }
  const includedValid =
    Array.isArray(manifest.included) && diagnostics.length === includedStart;

  const excludedStart = diagnostics.length;
  if (!Array.isArray(manifest.excluded))
    diagnostics.push(
      diagnostic('invalid-type', '$.excluded', 'expected array'),
    );
  else {
    manifest.excluded.forEach((entry, index) =>
      validateExcludedEntry(entry, `$.excluded[${index}]`, diagnostics),
    );
    if (diagnostics.length === excludedStart)
      requireCanonicalObjectList(
        manifest.excluded,
        [
          ...new Map(
            manifest.excluded.map((entry) => [entry.candidateRoot, entry]),
          ).values(),
        ].sort((left, right) =>
          compareUtf8(left.candidateRoot, right.candidateRoot),
        ),
        '$.excluded',
        diagnostics,
      );
  }
  const excludedValid =
    Array.isArray(manifest.excluded) && diagnostics.length === excludedStart;

  if (
    exactKeys(
      manifest.coverage,
      [
        'candidateCount',
        'includedCount',
        'excludedCount',
        'gaps',
        'confidence',
      ],
      '$.coverage',
      diagnostics,
    )
  ) {
    requireNonNegativeInteger(
      manifest.coverage.candidateCount,
      '$.coverage.candidateCount',
      diagnostics,
    );
    requireNonNegativeInteger(
      manifest.coverage.includedCount,
      '$.coverage.includedCount',
      diagnostics,
    );
    requireNonNegativeInteger(
      manifest.coverage.excludedCount,
      '$.coverage.excludedCount',
      diagnostics,
    );
    requireCanonicalTextSet(
      manifest.coverage.gaps,
      '$.coverage.gaps',
      diagnostics,
      ID,
    );
    requireEnum(
      manifest.coverage.confidence,
      CONFIDENCE_LEVELS,
      '$.coverage.confidence',
      diagnostics,
    );
    if (
      Array.isArray(manifest.included) &&
      Array.isArray(manifest.excluded) &&
      (manifest.coverage.includedCount !== manifest.included.length ||
        manifest.coverage.excludedCount !== manifest.excluded.length ||
        manifest.coverage.candidateCount !==
          manifest.included.length + manifest.excluded.length)
    )
      diagnostics.push(
        diagnostic(
          'coverage-count-mismatch',
          '$.coverage',
          'coverage counts differ from candidate entries',
        ),
      );
  }
  requireEnum(manifest.status, MANIFEST_STATUSES, '$.status', diagnostics);

  if (Array.isArray(manifest.included) && Array.isArray(manifest.excluded)) {
    const roots = [...manifest.included, ...manifest.excluded]
      .map((entry) => entry?.candidateRoot)
      .filter((root) => typeof root === 'string');
    if (new Set(roots).size !== roots.length)
      diagnostics.push(
        diagnostic(
          'duplicate-candidate',
          '$.included',
          'candidate roots must be unique across included and excluded',
        ),
      );
    if (sourceReferencesValid && includedValid && excludedValid) {
      const expectedReferences = [
        ...new Map(
          [...manifest.included, ...manifest.excluded]
            .filter((entry) => isObject(entry?.sourceReference))
            .map((entry) => [
              `${entry.sourceReference.sourceId}\0${entry.sourceReference.sourceRoot}`,
              entry.sourceReference,
            ]),
        ).values(),
      ].sort(sourceReferenceOrder);
      if (
        canonicalJson(manifest.sourceReferences) !==
        canonicalJson(expectedReferences)
      )
        diagnostics.push(
          diagnostic(
            'source-reference-closure-mismatch',
            '$.sourceReferences',
            'source references must close over all candidate entries',
          ),
        );
    }
  }

  requireRoot(manifest.selectionRoot, '$.selectionRoot', diagnostics);
  if (ROOT.test(manifest.selectionRoot ?? '')) {
    try {
      if (
        semanticRoot(rootPreimage(manifest, 'selectionRoot')) !==
        manifest.selectionRoot
      )
        diagnostics.push(
          diagnostic(
            'root-mismatch',
            '$.selectionRoot',
            'selection root differs from its canonical preimage',
          ),
        );
    } catch {
      diagnostics.push(
        diagnostic(
          'invalid-canonical-value',
          '$',
          'manifest cannot be encoded by canonical JSON',
        ),
      );
    }
  }
  return diagnostics.sort(
    (left, right) =>
      compareUtf8(left.path, right.path) || compareUtf8(left.code, right.code),
  );
}

export function buildWorkHistoryIndexSnapshot(input) {
  const preimage = {
    schema: WORK_HISTORY_INDEX_SNAPSHOT_SCHEMA,
    capturedAt: input.capturedAt,
    sourceCutRoot: input.sourceCutRoot,
  };
  return { ...preimage, snapshotRoot: semanticRoot(preimage) };
}

export function buildWorkHistorySelectionPolicy(input) {
  const preimage = {
    schema: WORK_HISTORY_SELECTION_POLICY_SCHEMA,
    id: input.id,
    version: input.version,
    maxSelected: input.maxSelected,
    recentWindowSeconds: input.recentWindowSeconds,
    maximumIndexAgeSeconds: input.maximumIndexAgeSeconds,
    allowedAuthorityRoots: input.allowedAuthorityRoots,
    allowedRecordSchemas: input.allowedRecordSchemas,
    allowedSourceIds: input.allowedSourceIds,
    allowedVisibilities: input.allowedVisibilities,
  };
  return { ...preimage, policyRoot: semanticRoot(preimage) };
}

export function buildWorkHistoryCandidate(input) {
  const preimage = { schema: WORK_HISTORY_CANDIDATE_SCHEMA, ...input };
  return { ...preimage, candidateRoot: semanticRoot(preimage) };
}

export function selectWorkHistory(request) {
  const diagnostics = validateRequest(request);
  if (diagnostics.length > 0)
    return {
      ok: false,
      action: 'work-history-select',
      manifest: null,
      diagnostics,
    };

  const gaps = new Set();
  const included = [];
  const excludedEntries = [];
  const indexAge = secondsBetween(
    request.asOf,
    request.indexSnapshot.capturedAt,
  );
  const indexUnusable =
    indexAge < 0 || indexAge > request.policy.maximumIndexAgeSeconds;
  if (indexAge < 0) gaps.add('index-from-future');
  if (indexAge > request.policy.maximumIndexAgeSeconds)
    gaps.add('stale-index-snapshot');

  const candidates = [...request.candidates].sort((left, right) =>
    compareUtf8(left.candidateRoot, right.candidateRoot),
  );
  for (const candidate of candidates) {
    const entry = indexUnusable
      ? excluded(candidate, 'unknown-applicability', [
          indexAge < 0 ? 'index-from-future' : 'stale-index-snapshot',
        ])
      : gateCandidate(candidate, request);
    if (Object.hasOwn(entry, 'rank')) included.push(entry);
    else {
      excludedEntries.push(entry);
      if (entry.reasons.includes('invalidation-after-index'))
        gaps.add('index-missed-invalidation');
      if (entry.classification === 'unknown-applicability')
        gaps.add('unknown-applicability');
    }
  }
  included.sort(compareIncluded);
  if (included.length > request.policy.maxSelected) {
    for (const entry of included.splice(request.policy.maxSelected))
      excludedEntries.push({
        candidateRoot: entry.candidateRoot,
        classification: entry.classification,
        sourceReference: entry.sourceReference,
        reasons: ['selection-limit'],
      });
  }
  excludedEntries.sort((left, right) =>
    compareUtf8(left.candidateRoot, right.candidateRoot),
  );
  if (candidates.length === 0) gaps.add('no-candidates');
  if (included.length === 0) gaps.add('no-selected-candidates');

  const sourceReferences = [
    ...new Map(
      candidates.map((candidate) => {
        const reference = sourceReference(candidate);
        return [`${reference.sourceId}\0${reference.sourceRoot}`, reference];
      }),
    ).values(),
  ].sort(
    (left, right) =>
      compareUtf8(left.sourceId, right.sourceId) ||
      compareUtf8(left.sourceRoot, right.sourceRoot),
  );
  const normalizedGaps = [...gaps].sort(compareUtf8);
  const confidence =
    included.length === 0
      ? candidates.length === 0
        ? 'unknown'
        : 'low'
      : normalizedGaps.length === 0
        ? 'high'
        : 'medium';
  const preimage = {
    schema: WORK_HISTORY_SELECTION_MANIFEST_SCHEMA,
    advisory: {
      readOnly: true,
      workAuthority: false,
      mayMutateAssignments: false,
    },
    query: { objectiveRoot: request.objectiveRoot },
    xinfaRoot: request.xinfaRoot,
    asOf: request.asOf,
    indexSnapshot: {
      root: request.indexSnapshot.snapshotRoot,
      capturedAt: request.indexSnapshot.capturedAt,
      sourceCutRoot: request.indexSnapshot.sourceCutRoot,
    },
    policy: {
      id: request.policy.id,
      version: request.policy.version,
      root: request.policy.policyRoot,
    },
    sourceReferences,
    included,
    excluded: excludedEntries,
    coverage: {
      candidateCount: candidates.length,
      includedCount: included.length,
      excludedCount: excludedEntries.length,
      gaps: normalizedGaps,
      confidence,
    },
    status: !indexUnusable && included.length > 0 ? 'complete' : 'incomplete',
  };
  const manifest = { ...preimage, selectionRoot: semanticRoot(preimage) };
  return {
    ok: true,
    action: 'work-history-select',
    manifest,
    diagnostics: [],
  };
}

export function verifyWorkHistorySelectionManifest(manifest) {
  const diagnostics = manifestDiagnostics(manifest);
  return {
    ok: diagnostics.length === 0,
    schema: 'kungfu.work-history.selection-verification/v1',
    selectionRoot: manifest?.selectionRoot ?? null,
    diagnostics,
  };
}
