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
  assert.equal(reusableRef, '733812ff9405241705f5f267fe2e5ec6351e1a2d');
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

test('Dev Agent admission binds every targeted run to one exact PR head', () => {
  assert.match(
    workflow,
    /expected-pr-number:[\s\S]*type: number[\s\S]*default: 0/u,
  );
  assert.match(
    workflow,
    /expected-head-sha:[\s\S]*type: string[\s\S]*default: ""/u,
  );
  assert.match(
    workflow,
    /source-workflow-run-id:[\s\S]*type: number[\s\S]*default: 0/u,
  );
  assert.match(
    workflow,
    /workflow_run must resolve to exactly one pull request/u,
  );
  assert.match(
    workflow,
    /expected-pr-number and expected-head-sha must be provided together/u,
  );
  assert.match(
    workflow,
    /expected head must be an exact lowercase 40-character commit SHA/u,
  );
  assert.match(
    workflow,
    /executing targeted admission requires source-workflow-run-id/u,
  );
  assert.match(
    workflow,
    /Verify exact source qualification run[\s\S]*\.name == "Core affected native"[\s\S]*\.path == "\.github\/workflows\/affected-native-pr\.yml"[\s\S]*\.head_sha == \$head[\s\S]*\.pull_requests\[0\]\.number == \$pullRequest/u,
  );
  assert.match(
    workflow,
    /expected-pr-number: \$\{\{ fromJSON\(needs\.resolve-target\.outputs\.expected-pr-number \|\| '0'\) \}\}/u,
  );
  assert.match(
    workflow,
    /expected-head-sha: \$\{\{ needs\.resolve-target\.outputs\.expected-head-sha \}\}/u,
  );
  assert.match(
    workflow,
    /source-workflow-run-id: \$\{\{ fromJSON\(needs\.resolve-target\.outputs\.source-workflow-run-id \|\| '0'\) \}\}/u,
  );
  assert.match(workflow, /handoff-workflow-id: dev-pr-auto-merge\.yml/u);
  assert.match(workflow, /permissions:\n {6}actions: write/u);
  assert.match(workflow, /diagnostic-context: Buildchain delivery intent/u);
  assert.match(
    workflow,
    /delivery-warrant-mode:.*workflow_run.*workflow_dispatch.*inputs\.dry-run == false.*required/u,
  );
  assert.doesNotMatch(workflow, /delivery-warrant-mode:[^\n]*shadow/u);
});

test('Dev cadence patrol remains an explicit non-targeted path', () => {
  assert.match(workflow, /expected_pr_number=""/u);
  assert.match(workflow, /expected_head_sha=""/u);
  assert.match(workflow, /if \[ "\$expected_pr_number" = "0" \]; then/u);
  assert.match(workflow, /cron: "23,53 \* \* \* \*"/u);
  assert.doesNotMatch(workflow, /auto-merge-enabled|autoMergeEnabled/u);
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

test('Dev behind admission produces and forwards an exact Project Cut replay proof', () => {
  assert.match(
    workflow,
    /Check out protected consumer adapter[\s\S]*fetch-depth: 0/u,
  );
  assert.match(
    workflow,
    /Check out exact Buildchain delivery runtime[\s\S]*ref: 733812ff9405241705f5f267fe2e5ec6351e1a2d/u,
  );
  assert.match(
    workflow,
    /Produce exact Project Cut replay proof[\s\S]*project-cut:queue-admission[\s\S]*dev-delivery-proof\.mjs replay-proof[\s\S]*--qualification-receipt/u,
  );
  assert.match(
    workflow,
    /project-cut:queue-admission[\s\S]*tee "\$qualification_output"[\s\S]*tail -n 1 "\$qualification_output" > "\$qualification"[\s\S]*jq -e/u,
  );
  assert.match(
    workflow,
    /dev-delivery-proof\.mjs verify-replay[\s\S]*project-cut-proof-json<<BUILDCHAIN_PROJECT_CUT_EOF/u,
  );
  assert.match(
    workflow,
    /project-cut-proof-json: \$\{\{ needs\.delivery-contract\.outputs\.project-cut-proof-json \}\}/u,
  );
  assert.match(
    workflow,
    /git ls-remote --exit-code origin "refs\/heads\/\$TARGET_BRANCH"[\s\S]*test "\$current_base" = "\$remote_base"/u,
  );
  assert.doesNotMatch(
    workflow,
    /test "\$current_base" = "\$\(jq -r '\.base\.sha'/u,
  );
});
