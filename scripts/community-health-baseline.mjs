// SPDX-License-Identifier: Apache-2.0
// @ts-check

/**
 * Public issue content is data only. This module intentionally has no process,
 * shell, network, dynamic import, or filesystem capability.
 */

/**
 * @param {Record<string, unknown>} issue
 * @param {Record<string, unknown>} admission
 */
export function classifyCommunityIntake(issue, admission) {
  const action = typeof issue.action === 'string' ? issue.action : '';
  const labels = Array.isArray(issue.labels)
    ? issue.labels.filter((label) => typeof label === 'string')
    : [];
  const body = typeof issue.body === 'string' ? issue.body : '';
  const events = Array.isArray(admission.events) ? admission.events : [];
  const forms = Array.isArray(admission.recognizedForms)
    ? admission.recognizedForms
    : [];

  if (!events.includes(action)) {
    return {
      disposition: 'ignored-event',
      demandLane: 'none',
      externalDemand: false,
      mutations: [],
    };
  }
  if (labels.includes('source/automation')) {
    return {
      disposition: 'automation',
      demandLane: 'automation',
      externalDemand: false,
      mutations: [],
    };
  }

  const form = forms.find(
    (candidate) =>
      candidate &&
      typeof candidate === 'object' &&
      typeof candidate.marker === 'string' &&
      body.includes(candidate.marker),
  );
  const headings =
    form && Array.isArray(form.requiredSectionHeadings)
      ? form.requiredSectionHeadings
      : [];
  const sectionHasValue = (heading) => {
    if (typeof heading !== 'string') return false;
    const start = body.indexOf(heading);
    if (start < 0) return false;
    const valueStart = start + heading.length;
    const next = body.indexOf('\n### ', valueStart);
    const value = body.slice(valueStart, next < 0 ? body.length : next).trim();
    return value.length > 0 && value !== '_No response_';
  };
  const recognized = form !== undefined;
  const complete =
    recognized && headings.length > 0 && headings.every(sectionHasValue);
  const state = !recognized
    ? admission.bypassState
    : complete
      ? admission.completeState
      : admission.incompleteState;
  const possibleSecret =
    /\b(?:gh[opsu]_[A-Za-z0-9]{8,}|AKIA[A-Z0-9]{8,}|Bearer\s+\S+)\b/u.test(
      body,
    );

  return {
    disposition: !recognized
      ? 'bypass'
      : complete
        ? 'recognized-complete'
        : 'recognized-incomplete',
    demandLane: 'external',
    externalDemand: true,
    recognized,
    complete,
    proposedState: state,
    correctiveCommentRequired: !recognized,
    correctiveCommentId: !recognized ? admission.correctiveCommentId : null,
    possibleSecret,
    rawBodyRetained: false,
    autoClose: false,
    humanReviewRequired: true,
    mutations: [],
  };
}

/**
 * @param {Array<Record<string, unknown>>} issues
 */
export function summarizeCommunityPortfolio(issues) {
  const external = issues.filter((issue) => issue.source === 'external');
  const automation = issues.filter((issue) => issue.source === 'automation');
  const judged = external.filter(
    (issue) =>
      Number.isFinite(issue.openedAt) &&
      Number.isFinite(issue.firstHumanJudgmentAt),
  );
  const latencies = judged.map(
    (issue) => Number(issue.firstHumanJudgmentAt) - Number(issue.openedAt),
  );
  const duplicateCount = external.filter(
    (issue) => issue.state === 'duplicate',
  ).length;
  const unresolvedSeverity = Object.fromEntries(
    ['security', 'data-loss', 'blocking', 'continuity', 'degraded'].map(
      (impact) => [
        impact,
        external.filter(
          (issue) => issue.impact === impact && issue.resolved !== true,
        ).length,
      ],
    ),
  );
  const reviewerLoad = {};
  for (const issue of external) {
    if (typeof issue.reviewer !== 'string' || issue.reviewer.length === 0) {
      continue;
    }
    reviewerLoad[issue.reviewer] = (reviewerLoad[issue.reviewer] ?? 0) + 1;
  }

  return {
    schema: 'kungfu.community-health-portfolio/v1',
    externalArrivals: external.length,
    automationArrivals: automation.length,
    duplicateRate: external.length === 0 ? 0 : duplicateCount / external.length,
    firstHumanJudgmentLatencyMs: {
      observed: latencies.length,
      maximum: latencies.length === 0 ? null : Math.max(...latencies),
    },
    unresolvedSeverity,
    reviewerLoad,
    issueBodiesCopied: false,
  };
}
