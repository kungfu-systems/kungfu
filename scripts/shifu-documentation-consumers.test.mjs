// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { runConsumerQualification } from './shifu-documentation-consumers.mjs';

test('two non-Kungfu consumer shapes compile through one Xinfa authority', () => {
  const receipt = runConsumerQualification();
  assert.equal(receipt.verdict, 'pass');
  assert.equal(receipt.compilerSourceChangesRequired, false);
  assert.equal(receipt.kungfuOnlyCompilerAssumptions, 0);
  assert.equal(receipt.consumers.length, 2);
  assert.equal(receipt.parity, true);
  for (const consumer of receipt.consumers) {
    assert.equal(consumer.deterministic, true);
    assert.equal(consumer.human.atlasRoot, consumer.roots.atlasRoot);
    assert.equal(consumer.agent.atlasRoot, consumer.roots.atlasRoot);
  }
});
