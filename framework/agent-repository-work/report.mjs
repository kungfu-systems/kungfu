// SPDX-License-Identifier: Apache-2.0

const REPORT_SCHEMA = 'kungfu.agent-repository-work.report/v1';
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function validateExperimentReport(report) {
  if (report?.schema !== REPORT_SCHEMA)
    throw new Error('repository-work report schema is unsupported');
  if (report.evidenceClass !== 'bounded-experiment')
    throw new Error('repository-work evidence class must stay bounded');
  if (report.nonClaims?.auditableDemo !== true)
    throw new Error('Auditable Demo non-integration boundary is required');
  if (report.nonClaims?.agentWorkLab !== true)
    throw new Error('Qualification Lab non-integration boundary is required');
  if (
    report.nonClaims?.releaseGate !== true ||
    report.nonClaims?.publicClaim !== true
  )
    throw new Error('release and public-claim boundaries are required');
  if (report.passed) {
    if (report.sessions?.distinct !== 2)
      throw new Error('exactly two fresh provider sessions are required');
    if (report.continuity?.priorTranscriptBytes !== 0)
      throw new Error('Agent B must receive zero prior transcript bytes');
    if (report.continuity?.humanRestatementCount !== 0)
      throw new Error('Agent B must receive no human task restatement');
    if (report.warrant?.agentAZeroModification !== true)
      throw new Error('Agent A modified the production fixture');
    if (report.oracle?.passed !== true || report.oracle?.authoritative !== true)
      throw new Error('external deterministic oracle is authoritative');
    if (
      report.sessions.a.providerSessionId ===
      report.sessions.b.providerSessionId
    )
      throw new Error('provider sessions are not fresh and distinct');
    for (const value of [
      report.claim?.root,
      report.assessment?.root,
      report.continuity?.root,
      report.oracle?.reportRoot,
    ])
      if (!ROOT_PATTERN.test(value || ''))
        throw new Error('repository-work evidence root is invalid');
  }
  return true;
}
