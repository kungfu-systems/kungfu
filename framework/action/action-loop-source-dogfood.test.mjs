// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectQualificationResult,
  renderQualificationResult,
} from './action-loop-source-dogfood.mjs';

const ROOT = `sha256:${'1'.repeat(64)}`;

test('human and JSON qualification surfaces project the same canonical fields', () => {
  const result = {
    ok: true,
    code: 'resumed',
    state: 'running',
    envelope: {
      state: 'running',
      roles: {
        pursuit: { id: 'pursuit:one', root: ROOT },
        atlas: { id: 'atlas:one', root: ROOT },
        warrant: { id: 'warrant:one', root: ROOT },
        episode: { id: 'episode:one', root: null },
        fact: { id: 'fact:one', root: ROOT },
      },
      factRef: { name: 'action-loop/one', cutRoot: ROOT, revision: 3 },
      residualRisk: ['source checkout only'],
    },
    receipts: [{ receiptRoot: ROOT }],
    checkpointRoot: ROOT,
    nextStep: 'seal-episode',
    writeOccurred: false,
  };

  const projected = projectQualificationResult(result);
  const rendered = renderQualificationResult(projected);

  assert.equal(projected.status, 'running');
  assert.equal(projected.identities.pursuit, 'pursuit:one');
  assert.equal(projected.authority.pursuit, ROOT);
  assert.deepEqual(projected.residualRisk, ['source checkout only']);
  assert.match(rendered, /status: running \(resumed\)/);
  assert.match(rendered, new RegExp(`pursuit: pursuit:one @ ${ROOT}`));
  assert.match(rendered, /residualRisk: source checkout only/);
});
