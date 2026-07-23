// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { recoverFocusedGateReceipt } from './recover-focused-gate-receipt.mjs';

const receipt = Buffer.from(
  `${JSON.stringify({ schema: 'shifu.gate-receipt/v1', status: 'pass' })}\n`,
);
const marker = `KUNGFU_GATE_RECEIPT_BASE64=${receipt.toString('base64')}`;

test('recovers a focused Gate receipt from a prefixed Actions log line', () => {
  assert.deepEqual(
    recoverFocusedGateReceipt(`job step timestamp ${marker}\n`),
    receipt,
  );
});

test('rejects logs without a receipt marker', () => {
  assert.throws(
    () => recoverFocusedGateReceipt('measurement completed without evidence\n'),
    /marker is missing/,
  );
});

test('rejects multiple distinct receipts', () => {
  const other = Buffer.from(
    JSON.stringify({ schema: 'shifu.gate-receipt/v1', status: 'fail' }),
  ).toString('base64');
  assert.throws(
    () => recoverFocusedGateReceipt(`${marker}\n${marker}AA\n${other}\n`),
    /multiple distinct/,
  );
});
