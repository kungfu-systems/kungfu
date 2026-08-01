// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';
import { PROJECT_TOUR_STORY_STEPS } from './starter-project-view/index.js';

test('Project recovery tour tells the complete user lifecycle without granting mock authority', () => {
  assert.equal(PROJECT_TOUR_STORY_STEPS.length, 7);
  assert.match(PROJECT_TOUR_STORY_STEPS[0], /Starter template/u);
  assert.match(PROJECT_TOUR_STORY_STEPS[1], /file tree/u);
  assert.match(PROJECT_TOUR_STORY_STEPS[2], /exit 75/u);
  assert.match(PROJECT_TOUR_STORY_STEPS[3], /exit 23/u);
  assert.match(PROJECT_TOUR_STORY_STEPS[5], /native Work authority/u);
  assert.match(PROJECT_TOUR_STORY_STEPS[6], /inventory/u);
});
