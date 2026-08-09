// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { checkCommunityHealthBaseline } from './check-community-health-baseline.mjs';
import {
  classifyCommunityIntake,
  summarizeCommunityPortfolio,
} from './community-health-baseline.mjs';

test('the community-health baseline rehearsal is complete and inert', () => {
  const result = checkCommunityHealthBaseline();
  assert.equal(result.verdict, 'pass', JSON.stringify(result.issues));
  assert.equal(result.liveMutation, false);
  assert.match(result.receiptRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(result.checks.length, 13);
});

test('admission revalidates bypass and edited content without closing', () => {
  const admission = {
    events: ['opened', 'edited', 'reopened'],
    recognizedForms: [
      {
        marker: '<!-- form/v1 -->',
        requiredSectionHeadings: ['### Required'],
      },
    ],
    completeState: 'preserve-local-form-state',
    incompleteState: 'state/needs-information',
    bypassState: 'state/needs-intake',
    correctiveCommentId: 'correction/v1',
  };
  const bypass = classifyCommunityIntake(
    { action: 'opened', labels: [], body: 'arbitrary API body' },
    admission,
  );
  const edited = classifyCommunityIntake(
    { action: 'edited', labels: ['source/external'], body: '<!-- form/v1 -->' },
    admission,
  );
  assert.equal(bypass.proposedState, 'state/needs-intake');
  assert.equal(bypass.correctiveCommentRequired, true);
  assert.equal(bypass.autoClose, false);
  assert.equal(edited.proposedState, 'state/needs-information');
  assert.deepEqual(edited.mutations, []);
});

test('portfolio metrics separate automation and never retain issue bodies', () => {
  const result = summarizeCommunityPortfolio([
    {
      source: 'external',
      state: 'duplicate',
      openedAt: 0,
      firstHumanJudgmentAt: 25,
      reviewer: 'human-a',
      body: 'private projection boundary',
    },
    { source: 'automation', body: 'machine finding' },
  ]);
  assert.equal(result.externalArrivals, 1);
  assert.equal(result.automationArrivals, 1);
  assert.equal(result.duplicateRate, 1);
  assert.equal(result.firstHumanJudgmentLatencyMs.maximum, 25);
  assert.equal(result.issueBodiesCopied, false);
  assert.doesNotMatch(JSON.stringify(result), /private projection boundary/u);
});
