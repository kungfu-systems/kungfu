// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  jsonRoot,
  parseAgentClaim,
  validateContinuityReport,
} from './run-agent-opencode-continuity.mjs';

const root = (letter) => `sha256:${letter.repeat(64)}`;

function validReport() {
  const current = root('1');
  const claim = root('2');
  const assessment = root('3');
  const successor = root('4');
  const replay = jsonRoot({ fixture: 'stable', transition: 'continuity' });
  return {
    schema: 'kungfu.run-agent-opencode-continuity-report/v1',
    evidenceClass: 'preparatory',
    runtime: { sameVerifiedExecutable: true },
    episodeVerification: { a: { ok: true }, b: { ok: true } },
    distinct_agent_sessions: 2,
    prior_transcript_bytes_given_to_agent_b: 0,
    human_reexplanation_count: 0,
    sessions: {
      a: {
        providerSessionId: 'session-a',
        processExitSettlesWork: false,
        selfReportSettlesWork: false,
      },
      b: {
        providerSessionId: 'session-b',
        recovered: {
          currentCutRoot: current,
          priorClaimRoot: claim,
          assessmentRoot: assessment,
          remainingObligation: 'write exact oracle including final newline',
          nextAction: 'write-oracle',
          reportedBeforeTaskEdit: true,
        },
      },
    },
    claim: { root: claim },
    assessment: {
      root: assessment,
      claimRoot: claim,
      independent: true,
      outcome: 'partial',
    },
    continuation: {
      currentCutRoot: current,
      priorClaimRoot: claim,
      assessmentRoot: assessment,
      remainingObligation: 'write exact oracle including final newline',
      nextAction: 'write-oracle',
    },
    warrant: { fresh: true },
    oracle: { passed: true },
    cuts: {
      current: { cutRoot: current },
      successor: { cutRoot: successor, parentCutRoots: [current] },
    },
    settlement: {
      status: 'settled',
      admittedSuccessor: true,
      receiptValid: true,
      successorCutRoot: successor,
    },
    stateTransitionClass:
      'partial-claim/independent-assessment/transcript-free-resume/successor-cut-settled',
    semanticReplay: { firstRoot: replay, secondRoot: replay },
  };
}

function rejected(mutator, pattern) {
  const report = structuredClone(validReport());
  mutator(report);
  assert.throws(() => validateContinuityReport(report), pattern);
}

test('accepts the exact two-session continuity transition', () => {
  assert.equal(validateContinuityReport(validReport()), true);
});

test('normalizes a schema-omitting free-model claim without weakening content', () => {
  assert.deepEqual(
    parseAgentClaim(`\`\`\`json
{
  "items": ["alpha", "beta", "gamma"],
  "itemCount": 3,
  "completed": "inventory-inspected",
  "remainingObligation": "write-inventory-summary",
  "nextAction": "write-inventory-summary"
}
\`\`\``),
    {
      items: ['alpha', 'beta', 'gamma'],
      itemCount: 3,
      completed: 'inventory-inspected',
      remainingObligation: 'write-inventory-summary',
      nextAction: 'write-inventory-summary',
    },
  );
  assert.throws(
    () =>
      parseAgentClaim(
        '{"schema":"wrong","items":["alpha","beta","gamma"],"itemCount":3,"completed":"inventory-inspected","remainingObligation":"write-inventory-summary","nextAction":"write-inventory-summary"}',
      ),
    /deterministic oracle/,
  );
});

test('rejects a reused Agent session', () => {
  rejected((report) => {
    report.sessions.b.providerSessionId = report.sessions.a.providerSessionId;
  }, /not distinct/);
});

test('rejects missing provider session identity', () => {
  rejected((report) => {
    report.sessions.b.providerSessionId = '';
  }, /provider session ids/);
});

test('rejects prior transcript injection and human restatement', () => {
  rejected((report) => {
    report.prior_transcript_bytes_given_to_agent_b = 1;
  }, /transcript injection/);
  rejected((report) => {
    report.human_reexplanation_count = 1;
  }, /human task restatement/);
});

test('rejects mismatched Claim, Assessment, continuation, and Cut roots', () => {
  rejected((report) => {
    report.assessment.claimRoot = root('9');
  }, /Claim roots/);
  rejected((report) => {
    report.continuation.assessmentRoot = root('8');
  }, /continuation roots/);
  rejected((report) => {
    report.cuts.successor.parentCutRoots = [root('7')];
  }, /successor Project Cut relation/);
});

test('rejects missing independent assessment', () => {
  rejected((report) => {
    report.assessment.independent = false;
  }, /independent partial assessment/);
});

test('rejects process exit or self-report presented as completion', () => {
  rejected((report) => {
    report.sessions.a.processExitSettlesWork = true;
  }, /process exit/);
  rejected((report) => {
    report.sessions.a.selfReportSettlesWork = true;
  }, /self-report/);
});

test('rejects oracle failure, stale warrant, and unadmitted settlement', () => {
  rejected((report) => {
    report.oracle.passed = false;
  }, /oracle/);
  rejected((report) => {
    report.warrant.fresh = false;
  }, /stale/);
  rejected((report) => {
    report.settlement.admittedSuccessor = false;
  }, /admitted verified successor/);
});

test('rejects nondeterministic semantic replay and transition drift', () => {
  rejected((report) => {
    report.semanticReplay.secondRoot = root('6');
  }, /semantic replay/);
  rejected((report) => {
    report.stateTransitionClass = 'process-exit-is-completion';
  }, /transition class/);
});
