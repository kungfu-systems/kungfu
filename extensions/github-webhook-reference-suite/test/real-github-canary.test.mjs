// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  awsPartitionForRegion,
  canaryPlan,
  lambdaHandlerSource,
} from '../scripts/real-github-canary.mjs';

test('real canary plan is bounded, rooted, and teardown-complete', () => {
  const plan = canaryPlan({
    repo: 'kungfu-origin/kungfu',
    region: 'us-east-1',
    nonce: 'fixture',
  });
  assert.match(plan.planRoot, /^sha256:[0-9a-f]{64}$/);
  assert.equal(plan.mode, 'one-shot-ping-only');
  assert.equal(plan.awsPartition, 'aws');
  assert.deepEqual(plan.retains, ['redacted-rooted-receipt']);
  assert.deepEqual(plan.retainsNo, [
    'secret',
    'signature',
    'payload',
    'public-endpoint',
  ]);
  assert.deepEqual(plan.teardownOrder, [
    'repository-webhook',
    'http-api',
    'lambda-function',
    'iam-role',
    'log-group',
  ]);
  assert.ok(plan.verifies.includes('lambda-function-absent'));
  assert.equal(
    plan.verifies.includes('lambda-invocation-policy-absent'),
    false,
  );
});

test('real canary derives the AWS ARN partition from the selected region', () => {
  assert.equal(awsPartitionForRegion('us-east-1'), 'aws');
  assert.equal(awsPartitionForRegion('cn-northwest-1'), 'aws-cn');
  assert.equal(awsPartitionForRegion('us-gov-west-1'), 'aws-us-gov');
  assert.throws(() => awsPartitionForRegion('not-a-region'), /invalid/u);
});

test('canary handler only accepts bounded signed GitHub ping deliveries', () => {
  const source = lambdaHandlerSource();
  for (const requirement of [
    'hmac.compare_digest',
    'x-hub-signature-256',
    'x-github-event',
    'ping',
    'payload-oversized',
    'signature-rejected',
    'return response(202, "ping-accepted"',
  ]) {
    assert.ok(source.includes(requirement), `missing ${requirement}`);
  }
  assert.equal(source.includes('print('), false);
});
