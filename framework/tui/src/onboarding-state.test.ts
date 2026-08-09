// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { readTuiOnboardingState } from './agent-work-lab-view.js';

test('TUI reads the shared user-level onboarding state without Project state', () => {
  const state = readTuiOnboardingState('/config', (file) => {
    assert.equal(file, '/config/config.json');
    return JSON.stringify({
      schema: 'kungfu.config.override/v1',
      ui: {
        onboarding: {
          version: 1,
          status: 'completed',
          route: 'agent',
          labCompleted: false,
          tourCompleted: false,
          completedAt: '2026-08-02T12:00:00Z',
        },
      },
    });
  });
  assert.equal(state.status, 'completed');
  assert.equal(state.route, 'agent');
});

test('TUI treats missing or unreadable user state as first launch', () => {
  const state = readTuiOnboardingState('/config', () => {
    throw new Error('missing');
  });
  assert.equal(state.status, 'unseen');
});
