// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { activeProjection } from '@kungfu-tech/product-kungfu/version-line/version-line-authority';
import { digest } from './alpha-ruleset.mjs';

const workflow = fs.readFileSync(
  '.github/workflows/stable-candidate-patrol.yml',
  'utf8',
);
const policy = fs.readFileSync('.buildchain/buildchain.toml', 'utf8');
const continuation = JSON.parse(
  fs.readFileSync(
    'docs/qualification/stable-release-continuation.contract.json',
    'utf8',
  ),
);
const { line: activeLine } = activeProjection();

test('Stable Patrol is an exact-pinned Buildchain caller with a protected target', () => {
  const reusableRef = workflow.match(
    /uses: kungfu-systems\/buildchain\/.github\/workflows\/stable-candidate-patrol\.yml@([0-9a-f]{40})/u,
  )?.[1];
  assert.equal(reusableRef, '978520e86134683f66b607bc70c2d18f623e2410');
  assert.match(workflow, new RegExp(`buildchain-ref: ${reusableRef}`, 'u'));
  assert.match(
    workflow,
    /target-branch: \$\{\{ needs\.resolve-version-line\.outputs\.stable-branch \}\}/u,
  );
  assert.match(
    workflow,
    /ledger-ref: \$\{\{ needs\.resolve-version-line\.outputs\.candidate-ledger \}\}/u,
  );
  assert.match(
    workflow,
    /\.\/shifu version-line:resolve --github-output "\$GITHUB_OUTPUT"/u,
  );
  assert.match(workflow, /cron: "0 19 \* \* \*"/u);
  assert.match(workflow, /release-now: \$\{\{ inputs\.release-now \}\}/u);
  assert.match(workflow, /auto-approve: false/u);
  assert.match(workflow, /auto-merge: true/u);
  assert.match(workflow, /merge-method: rebase/u);
  assert.match(
    workflow,
    /dry-run: \$\{\{ github\.event_name == 'workflow_dispatch' && !inputs\.create-pull-request \}\}/u,
  );
  assert.match(
    workflow,
    /promotion-token: \$\{\{ secrets\.KUNGFU_GITHUB_TOKEN \}\}/u,
  );
  assert.doesNotMatch(
    workflow,
    /npm publish|gh release create|git tag|gh pr merge/iu,
  );
});

test('Stable policy retains independent approval and durable candidate evidence', () => {
  assert.match(policy, /\[release\.stable\]/u);
  assert.match(policy, /strategy = "latest-qualified-alpha"/u);
  assert.match(policy, /timezone = "Asia\/Shanghai"/u);
  assert.match(policy, /publish_at = "03:00"/u);
  assert.match(policy, /minimum_soak_seconds = 86400/u);
  assert.match(policy, /required_checks = \["alpha-release"\]/u);
  assert.match(
    policy,
    new RegExp(
      `ledger_ref = "${activeLine.candidateLedger.replaceAll('.', '\\.')}"`,
      'u',
    ),
  );
  assert.match(policy, /auto_promote = true/u);
  assert.match(policy, /auto_merge = true/u);
});

test('reviewed stable dry-run prepares the next patch Alpha without publishing', () => {
  const { contractRoot, ...body } = continuation;
  assert.equal(contractRoot, digest(body));
  assert.equal(continuation.status, 'qualified');
  assert.equal(
    continuation.buildchain.ref,
    '7629c4b499cd2d4eebf4c020fbc81637ae1dcb39',
  );
  assert.equal(continuation.candidate.targetRef, 'release/v4/v4.0');
  assert.equal(continuation.expectedTransaction.stableTag, 'v4.0.0');
  assert.equal(continuation.expectedTransaction.nextAlphaTag, 'v4.0.1-alpha.0');
  assert.deepEqual(continuation.expectedTransaction.nextAlphaRefs, [
    'alpha/v4/v4.0',
    'dev/v4/v4.0',
  ]);
  assert.deepEqual(continuation.expectedTransaction.versionState, [
    '4.0.0',
    '4.0.1-alpha.0',
  ]);
  assert.equal(
    continuation.expectedTransaction.publishTransaction,
    'enabled:lifecycle.publish',
  );
  assert.deepEqual(continuation.safety, {
    dryRun: true,
    modifiedRefs: false,
    modifiedTags: false,
    published: false,
  });
});
