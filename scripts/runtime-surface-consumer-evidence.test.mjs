// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { consumerEvidence, valueRoot } from './qualify-runtime-surface.mjs';

const receipt = {
  schema: 'kungfu.runtime-surface-receipt/v1',
  receiptRoot: `sha256:${'a'.repeat(64)}`,
};

test('consumer evidence roots the complete real probe output and receipt', () => {
  const output = { schema: 'consumer.output/v1', ok: true };
  const evidence = consumerEvidence({
    rowId: 'context-hybrid',
    consumer: 'atlas.xinfa.context',
    output,
    receipts: [receipt],
    observers: ['kungfu.tui.runtime-surface'],
  });

  assert.equal(evidence.probe.outputRoot, valueRoot(output));
  assert.equal(
    evidence.evidenceRoot,
    valueRoot(
      Object.fromEntries(
        Object.entries(evidence).filter(([key]) => key !== 'evidenceRoot'),
      ),
    ),
  );
  assert.deepEqual(evidence.receipts, [receipt]);
});

test('consumer evidence rejects receipt-free assertions', () => {
  assert.throws(
    () =>
      consumerEvidence({
        rowId: 'portable-bundle-installed',
        consumer: 'kungfu.agent.docs.verify',
        output: { valid: true },
        receipts: [],
      }),
    /at least one receipt/,
  );
});
