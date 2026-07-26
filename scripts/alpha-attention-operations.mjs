// SPDX-License-Identifier: Apache-2.0
// @ts-check

/**
 * Public issue content is data only. This module intentionally has no process,
 * shell, network, dynamic import, or filesystem capability.
 */

const REQUIRED_FIELDS = [
  'version',
  'installChannel',
  'osArch',
  'providerAgent',
  'expected',
  'actual',
  'reproduction',
  'diagnostics',
  'impactFlags',
];

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** @param {string} value */
function normalized(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

/** @param {Record<string, unknown>} issue */
export function issueFingerprint(issue) {
  return [
    text(issue.form),
    text(issue.version),
    text(issue.installChannel),
    text(issue.osArch),
    text(issue.providerAgent),
    text(issue.title),
  ]
    .map(normalized)
    .join('|');
}

/**
 * @param {number} externalIssues
 * @param {{credibleSecurity?: boolean, credibleDataLoss?: boolean}} [signals]
 */
export function attentionBand(externalIssues, signals = {}) {
  if (!Number.isInteger(externalIssues) || externalIssues < 0) {
    throw new TypeError('externalIssues must be a non-negative integer');
  }
  if (signals.credibleSecurity || signals.credibleDataLoss) return 'Red';
  if (externalIssues <= 10) return 'Green';
  if (externalIssues <= 30) return 'Yellow';
  if (externalIssues <= 60) return 'Orange';
  return 'Red';
}

/**
 * Build a proposal without reproducing public diagnostics or executing any
 * public text. Every consequential result remains human-reviewed.
 *
 * @param {Record<string, unknown>} issue
 * @param {Array<Record<string, unknown>>} existingIssues
 * @param {Array<Record<string, unknown>>} knownIssues
 */
export function buildTriageProposal(
  issue,
  existingIssues = [],
  knownIssues = [],
) {
  const fingerprint = issueFingerprint(issue);
  const duplicateCandidates = existingIssues
    .filter((candidate) => issueFingerprint(candidate) === fingerprint)
    .map((candidate) => ({
      number: candidate.number,
      reason: 'exact-structured-fingerprint',
    }));
  const searchable = normalized(
    [text(issue.title), text(issue.expected), text(issue.actual)].join(' '),
  );
  const knownIssueCandidates = knownIssues
    .filter((known) =>
      Array.isArray(known.matchTerms)
        ? known.matchTerms.some((term) =>
            searchable.includes(normalized(text(term))),
          )
        : false,
    )
    .map((known) => ({ id: known.id, url: known.url }));
  const fieldPresence = Object.fromEntries(
    REQUIRED_FIELDS.map((field) => [
      field,
      Array.isArray(issue[field])
        ? issue[field].length > 0
        : text(issue[field]).length > 0,
    ]),
  );

  return {
    schema: 'kungfu.alpha-attention-triage-proposal/v1',
    acknowledgement:
      'Thanks for the structured report. A human maintainer will review its routing, impact, and next action.',
    sanitizationGuidance:
      'Keep only the minimum redacted reproduction and diagnostics. Remove secrets, credentials, tokens, private logs, customer data, and private URLs.',
    structuredSummary: {
      number: issue.number,
      title: text(issue.title),
      form: text(issue.form),
      fieldPresence,
      reproductionLength: text(issue.reproduction).length,
      diagnosticsLength: text(issue.diagnostics).length,
    },
    duplicateCandidates,
    knownIssueCandidates,
    proposedImpactFlags: Array.isArray(issue.impactFlags)
      ? issue.impactFlags.map(text).filter(Boolean)
      : [],
    humanReviewRequired: true,
    mutations: [],
    publicTextExecuted: false,
  };
}
