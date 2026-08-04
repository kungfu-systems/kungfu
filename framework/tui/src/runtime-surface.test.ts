// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { observeRuntimeSurfaceReceipt } from './runtime-surface.js';

const root = `sha256:${'a'.repeat(64)}`;

test('TUI observes the exact rooted receipt without choosing another surface', () => {
  const receipt = {
    schema: 'kungfu.runtime-surface-receipt/v1',
    receiptRoot: root,
    contractRoot: `sha256:${'b'.repeat(64)}`,
    operationId: 'context.compose',
    runtimeSurface: 'hybrid-boundary',
    selectedProvider: 'atlas-kungfu-hybrid',
    capabilities: ['context.compose', 'runtime.provenance'],
    selection: { fallback: { used: false, reason: null } },
  };

  assert.deepEqual(observeRuntimeSurfaceReceipt(receipt), {
    schema: 'kungfu.tui-runtime-surface-observation/v1',
    receiptRoot: root,
    contractRoot: `sha256:${'b'.repeat(64)}`,
    operationId: 'context.compose',
    runtimeSurface: 'hybrid-boundary',
    selectedProvider: 'atlas-kungfu-hybrid',
    capabilities: ['context.compose', 'runtime.provenance'],
    fallbackUsed: false,
    fallbackReason: null,
  });
});

test('TUI fails closed on unrooted or unknown receipts', () => {
  assert.throws(
    () => observeRuntimeSurfaceReceipt({ schema: 'legacy' }),
    /schema is unsupported/,
  );
  assert.throws(
    () =>
      observeRuntimeSurfaceReceipt({
        schema: 'kungfu.runtime-surface-receipt/v1',
        receiptRoot: root,
        contractRoot: root,
        runtimeSurface: 'windows-runner',
      }),
    /unknown concrete surface/,
  );
});
