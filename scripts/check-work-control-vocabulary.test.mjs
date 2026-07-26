// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { auditWorkControlVocabulary } from './check-work-control-vocabulary.mjs';

test('native Work Control surfaces do not leak Atlas workflow vocabulary', () => {
  assert.deepEqual(auditWorkControlVocabulary(), []);
});
