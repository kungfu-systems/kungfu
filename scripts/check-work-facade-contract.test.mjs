// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const contract = JSON.parse(
  fs.readFileSync('framework/work-loop/work-api.contract.json', 'utf8'),
);

test('Work API freezes one complete public lifecycle', () => {
  assert.equal(contract.schema, 'kungfu.work-api.contract/v1');
  assert.deepEqual(
    contract.actions.map(({ id }) => id),
    [
      'inspect',
      'begin',
      'checkpoint',
      'complete',
      'settle',
      'resume',
      'recover',
      'export',
      'import',
    ],
  );
  assert.equal(contract.publicMindset, 'current Project Cut -> Work -> successor Project Cut');
});

test('facade operations map to existing authorities without becoming one', () => {
  assert.match(contract.authority.facade, /orchestration plans/u);
  assert.equal(contract.safety.completeIsSettle, false);
  assert.equal(contract.safety.selfReportIsProof, false);
  assert.equal(contract.safety.readOnlyInitializesRuntime, false);
  assert.equal(contract.safety.uiOwnsAuthority, false);
  for (const action of contract.actions) {
    assert.match(action.output, /^kungfu\.work\./u, action.id);
    assert.ok(action.nextActions.length > 0, action.id);
  }
});

test('progressive disclosure keeps five-object detail behind explain', () => {
  assert.deepEqual(contract.progressiveDisclosure.default, [
    'cut',
    'work',
    'confidence',
    'gaps',
    'nextActions',
  ]);
  assert.ok(contract.progressiveDisclosure.explain.includes('authorityReceipts'));
  assert.equal(contract.simpleSession.hiddenState, false);
  assert.match(contract.simpleSession.ambiguity, /fail visibly/u);
});
