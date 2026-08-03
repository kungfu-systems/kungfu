// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflow = fs.readFileSync(
  '.github/workflows/dev-pr-auto-merge.yml',
  'utf8',
);

test('Dev auto-merge admits only explicitly ready reviewed same-repository PRs', () => {
  const reusableRef = workflow.match(
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/dev-pr-auto-merge\.yml@([0-9a-f]{40})/u,
  )?.[1];
  assert.equal(reusableRef, '1659da98053f8ea8c75471e414b7732e3a491580');
  assert.match(workflow, new RegExp(`buildchain-ref: ${reusableRef}`, 'u'));
  assert.match(workflow, /workflow_run:[\s\S]*Core affected native/u);
  assert.match(workflow, /cron: "23,53 \* \* \* \*"/u);
  assert.match(workflow, /ready-label: state\/ready/u);
  assert.match(
    workflow,
    /block-labels: state\/blocked,blocked,do-not-merge,work-in-progress/u,
  );
  assert.match(
    workflow,
    /allowed-head-prefixes: feature\/,fix\/,chore\/,docs\/,ci\/,refactor\//u,
  );
  assert.match(workflow, /require-approval: true/u);
  assert.match(workflow, /same-repository-only: true/u);
  assert.match(workflow, /max-merges: 1/u);
});

test('Dev auto-merge waits for PR checks and lands through the native queue', () => {
  const requiredChecks = workflow.match(
    /required-status-checks: \|-\n([\s\S]*?)\n\s+queue-admission-context:/u,
  )?.[1];
  assert.match(requiredChecks || '', /Candidate source acceptance \/ check/u);
  assert.match(requiredChecks || '', /affected-native \/ linux/u);
  assert.doesNotMatch(requiredChecks || '', /Queue admission lease/u);
  assert.match(workflow, /statuses: write/u);
  assert.match(workflow, /queue-admission-context: Queue admission lease/u);
  assert.match(workflow, /merge-method: rebase/u);
  assert.match(workflow, /landing-mode: queue/u);
  assert.match(
    workflow,
    /dry-run: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.dry-run \}\}/u,
  );
  assert.match(
    workflow,
    /github-token: \$\{\{ secrets\.KUNGFU_GITHUB_TOKEN \}\}/u,
  );
  assert.doesNotMatch(workflow, /gh pr merge|npm publish|git tag/iu);
});
