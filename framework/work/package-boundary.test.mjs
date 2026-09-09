// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORK_PACKAGE_BOUNDARY,
  action,
  assignmentRuntime,
  evidence,
  projectCut,
} from './index.mjs';

test('publishes Work protocols without claiming native writer authority', () => {
  assert.equal(WORK_PACKAGE_BOUNDARY.semanticOwner, 'work');
  assert.equal(WORK_PACKAGE_BOUNDARY.nativeWriterOwner, '@kungfu-tech/core');
  assert.equal(WORK_PACKAGE_BOUNDARY.portableFormatOwner, '@kungfu-tech/spec');
  assert.equal(typeof action.canonicalJson, 'function');
  assert.equal(typeof assignmentRuntime.validateContract, 'function');
  assert.equal(typeof evidence.createEvidenceEnvelope, 'function');
  assert.equal(typeof projectCut.buildProjectCut, 'function');
});
