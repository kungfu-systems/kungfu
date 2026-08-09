// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkAgentSessionContract,
  validateAgentSessionContractValue,
} from './agent-session-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = JSON.parse(
  fs.readFileSync(
    path.join(
      ROOT,
      'framework',
      'agent-session',
      'kungfu-agent-session.contract.json',
    ),
    'utf8',
  ),
);

test('agent-session contract accepts positive fixtures and rejects all named safety failures', async () => {
  const result = await checkAgentSessionContract(ROOT);
  assert.equal(
    result.contract,
    'framework/agent-session/kungfu-agent-session.contract.json',
  );
  assert.equal(result.validFixtures, 7);
  assert.equal(result.rejectedFixtures, 8);
  assert.ok(['passed', 'skipped'].includes(result.schemaValidation));
});

test('contract keeps PTY delivery separate from semantic work authority', () => {
  assert.equal(
    CONTRACT.interactionPort.deliveryReceiptProves,
    'validated-input-written-to-pty-only',
  );
  assert.equal(
    CONTRACT.interactionPort.outcomeReceiptAuthority,
    'provider-structured-event-or-profile-kfd-action',
  );
  assert.equal(
    CONTRACT.authorities.workFacts.owner,
    'profile-kfd-action-episode',
  );
  assert.equal(
    CONTRACT.frameClasses.find(
      (frame) => frame.id === 'volatile-terminal-transport',
    ).portableFactAuthority,
    false,
  );
});

test('coordinator and session stream epochs remain independent', () => {
  assert.equal(CONTRACT.epochs.coordinatorEpoch.resetsSessionStream, false);
  assert.deepEqual(CONTRACT.epochs.sessionStreamEpoch.stableAcross, [
    'gui-restart',
    'coordinator-restart',
  ]);
});

test('unknown modal state cannot admit an automatic semantic instruction', () => {
  const issues = validateAgentSessionContractValue('sessionAction', {
    operation: 'instruct',
    automatic: true,
    interactionState: 'unknown',
    admissionDecision: 'written',
    capsuleGeneration: '3',
    sessionStreamEpoch: '4',
    expectedSessionStreamEpoch: '4',
    controllerLease: {
      state: 'active',
      capsuleGeneration: '3',
    },
    foreground: { state: 'running' },
  });
  assert.ok(issues.some((item) => item.code === 'unsafe-modal-instruction'));
});
