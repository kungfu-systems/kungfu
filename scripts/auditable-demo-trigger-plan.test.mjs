// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAuditableDemoTriggerPlan,
  verifyAuditableDemoTriggerPlan,
} from './auditable-demo-trigger-plan.mjs';

const SOURCE_SHA = '1'.repeat(40);

function plan(overrides = {}) {
  return buildAuditableDemoTriggerPlan({
    eventName: 'workflow_dispatch',
    sourceSha: SOURCE_SHA,
    ...overrides,
  });
}

test('manual dispatch preserves Gate-only and full-media validation modes', () => {
  const gateOnly = plan({});
  assert.equal(gateOnly.triggerClass, 'manual');
  assert.equal(gateOnly.demoId, 'agent-work-lab');
  assert.equal(gateOnly.renderMedia, false);
  assert.equal(gateOnly.refreshRequired, false);

  const refresh = plan({
    requestedDemoId: 'agent-work-lab-secondary',
    requestedRenderMedia: true,
  });
  assert.equal(refresh.demoId, 'agent-work-lab-secondary');
  assert.equal(refresh.renderMedia, true);
  assert.equal(refresh.refreshRequired, true);
  assert.equal(verifyAuditableDemoTriggerPlan(refresh), refresh);
});

test('Alpha and Release promotions require the same default media refresh plan', () => {
  const alpha = plan({
    eventName: 'pull_request',
    baseRef: 'alpha/v4/v4.0',
  });
  const release = plan({
    eventName: 'pull_request',
    baseRef: 'release/v4/v4.0',
  });
  for (const candidate of [alpha, release]) {
    assert.equal(candidate.demoId, 'agent-work-lab');
    assert.equal(candidate.renderMedia, true);
    assert.equal(candidate.refreshRequired, true);
    assert.equal(candidate.executionContract, alpha.executionContract);
    assert.equal(candidate.publicationAuthority, false);
  }
  assert.equal(alpha.triggerClass, 'alpha');
  assert.equal(release.triggerClass, 'release');
});

test('unsupported or ambiguous trigger inputs fail closed', () => {
  assert.throws(() => plan({ eventName: 'push' }), /unsupported event push/u);
  assert.throws(
    () =>
      plan({
        eventName: 'pull_request',
        baseRef: 'dev/v4/v4.0',
      }),
    /not an Alpha or Release channel/u,
  );
  assert.throws(
    () =>
      plan({
        eventName: 'pull_request',
        baseRef: 'alpha/v4/v4.0',
        requestedDemoId: 'secondary',
      }),
    /must use the catalog default/u,
  );
  const tampered = plan({ requestedRenderMedia: true });
  tampered.renderMedia = false;
  assert.throws(
    () => verifyAuditableDemoTriggerPlan(tampered),
    /plan root mismatch/u,
  );
});
