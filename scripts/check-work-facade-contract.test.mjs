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
  assert.equal(
    contract.publicMindset,
    'current Project Cut -> Work -> successor Project Cut',
  );
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
  assert.ok(
    contract.progressiveDisclosure.explain.includes('authorityReceipts'),
  );
  assert.equal(contract.simpleSession.hiddenState, false);
  assert.match(contract.simpleSession.ambiguity, /fail visibly/u);
});

test('GUI and TUI project one read-only shared WorkLoop adapter', () => {
  assert.deepEqual(contract.surfaces.sharedAdapter.operations, [
    'capabilities',
    'inspect',
    'recover',
  ]);
  assert.equal(contract.surfaces.sharedAdapter.mutates, false);
  assert.equal(contract.surfaces.gui.capability, 'workLoop');
  assert.equal(contract.surfaces.gui.status, 'available');
  assert.equal(contract.surfaces.tui.capability, 'workLoop');
  assert.equal(contract.surfaces.tui.status, 'available');
});

test('portable Work binds one current Cut and remains verify-first', () => {
  assert.equal(
    contract.portability.envelopeSchema,
    'kungfu.work.portable-envelope/v1',
  );
  assert.equal(
    contract.portability.importReceiptSchema,
    'kungfu.work.import-receipt/v1',
  );
  assert.match(contract.portability.import, /verify the current Cut/u);
  assert.match(contract.portability.recovery, /missing verified prefix/u);
  assert.ok(contract.portability.excludes.includes('credentials'));
  assert.ok(contract.portability.excludes.includes('local timestamps'));
  assert.equal(contract.portability.limits.envelopeBytes, 4 * 1024 * 1024);
  assert.ok(
    contract.portability.nonClaims.includes(
      'portableRoot is an integrity root, not an origin signature',
    ),
  );
});
