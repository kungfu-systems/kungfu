// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { upgradeUserMessage } from './upgrade-message';

test('GUI projects the welded reason message and exact documentation anchor', () => {
  const message = upgradeUserMessage(
    'provider-resume-unsupported',
    'https://www.kungfu.tech/docs/guides/upgrading',
    {
      activeWorkContinues: true,
      activationTiming: 'after-safe-point',
      userActionRequired: true,
    },
  );
  assert.equal(message.reasonCode, 'provider-resume-unsupported');
  assert.match(message.activeWork, /pinned runtime/);
  assert.match(message.userAction, /Finish or explicitly stop/);
  assert.equal(
    message.documentationUrl,
    'https://www.kungfu.tech/docs/guides/upgrading#provider-resume-and-session-continuity',
  );
});

test('unknown GUI reasons fail closed to one action-required message', () => {
  const message = upgradeUserMessage(
    'future-reason',
    'https://www.kungfu.tech/docs/guides/upgrading#old',
  );
  assert.equal(message.reasonCode, 'future-reason');
  assert.equal(message.messageReasonCode, 'action-required');
  assert.match(message.documentationUrl, /#troubleshooting$/);
});
