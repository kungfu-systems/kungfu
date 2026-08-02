// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_KUNGFU_ONBOARDING_STATE,
  beginKungfuOnboardingRoute,
  finishKungfuOnboarding,
  kungfuAgentBriefCommand,
  kungfuAgentFirstPrompt,
  parseKungfuOnboardingState,
  shouldShowKungfuOnboarding,
} from '../src/capability/onboarding.ts';

test('onboarding is versioned, resumable, and hidden only after an explicit outcome', () => {
  const unseen = parseKungfuOnboardingState(undefined);
  assert.deepEqual(unseen, DEFAULT_KUNGFU_ONBOARDING_STATE);
  assert.equal(shouldShowKungfuOnboarding(unseen), true);

  const started = beginKungfuOnboardingRoute(unseen, 'agent');
  assert.equal(started.status, 'started');
  assert.equal(started.route, 'agent');
  assert.equal(shouldShowKungfuOnboarding(started), true);

  const completed = finishKungfuOnboarding(started, {
    completedAt: '2026-08-02T12:00:00.000Z',
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.route, 'agent');
  assert.equal(shouldShowKungfuOnboarding(completed), false);
});

test('unknown onboarding versions fail back to the current first entry', () => {
  assert.deepEqual(
    parseKungfuOnboardingState({
      version: 99,
      status: 'completed',
      route: 'agent',
    }),
    DEFAULT_KUNGFU_ONBOARDING_STATE,
  );
});

test('agent first entry carries an exact shell-safe local brief command', () => {
  const command = kungfuAgentBriefCommand('/Applications/Kungfu App/kungfu', [
    '--profile',
    'First User',
  ]);
  assert.equal(
    command,
    "'/Applications/Kungfu App/kungfu' --profile 'First User' agent brief",
  );
  assert.match(kungfuAgentFirstPrompt(command), /current agent/u);
  assert.match(kungfuAgentFirstPrompt(command), /durable Work layer/u);
});
