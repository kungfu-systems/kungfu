// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GitHubNativeStatusClient,
  runNativeUnderWarrant,
} from '../framework/dev-delivery/native-under-warrant.mjs';

const workflow = fs.readFileSync(
  '.github/workflows/dev-pr-auto-merge.yml',
  'utf8',
);

test('Dev auto-merge admits only explicitly ready reviewed same-repository PRs', () => {
  const reusableRef = workflow.match(
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/dev-pr-auto-merge\.yml@([0-9a-f]{40})/u,
  )?.[1];
  assert.equal(reusableRef, 'fefb02fbb874bf4bc86dc3fd4a707a9468e14718');
  assert.match(workflow, new RegExp(`buildchain-ref: ${reusableRef}`, 'u'));
  assert.match(workflow, /workflow_run:[\s\S]*Core affected native/u);
  assert.match(workflow, /pull_request_target:[\s\S]*ready_for_review/u);
  assert.match(workflow, /pull_request_review:[\s\S]*submitted, dismissed/u);
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
    /source-workflow-jobs\.json[\s\S]*Candidate source acceptance \/ check[\s\S]*\.conclusion == "success"/u,
  );
  const sourceRunVerification = workflow.slice(
    workflow.indexOf('      - name: Verify exact source qualification run'),
    workflow.indexOf('source-workflow-jobs.json'),
  );
  assert.doesNotMatch(sourceRunVerification, /\.conclusion/u);
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
  assert.match(
    workflow,
    /deliveryClass[\s\S]*native-proof-required[\s\S]*gh run download "\$SOURCE_RUN_ID"[\s\S]*core-dev-delivery-source-proof-\$EXPECTED_HEAD[\s\S]*verify-native[\s\S]*native-proof-json<<BUILDCHAIN_NATIVE_PROOF_EOF/u,
  );
  assert.match(
    workflow,
    /environment-root: \$\{\{ needs\.delivery-contract\.outputs\.environment-root \}\}/u,
  );
  assert.match(
    workflow,
    /environment_root="\$\(jq -er '\.environmentRoot' "\$native_proof"\)"[\s\S]*\(\$input\[0\]\.environmentRoot \/\/ \$environmentRoot\)[\s\S]*echo "environment-root=\$environment_root"/u,
  );
  assert.match(
    workflow,
    /native-proof-json: \$\{\{ needs\.delivery-contract\.outputs\.native-proof-json \}\}/u,
  );
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
  assert.doesNotMatch(requiredChecks || '', /affected-native \/ linux/u);
  assert.doesNotMatch(requiredChecks || '', /Queue admission lease/u);
  assert.match(
    workflow,
    /native-command: >-[\s\S]*dev-delivery:native-under-warrant[\s\S]*--status-context 'affected-native \/ linux'/u,
  );
  assert.match(workflow, /native-heartbeat-seconds: 300/u);
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

test('native Warrant retries transient exact-head reads without retrying writes', async () => {
  const calls = [];
  const delays = [];
  const responses = [
    new TypeError('fetch failed'),
    {
      ok: true,
      async text() {
        return JSON.stringify({ head: { sha: '1'.repeat(40) } });
      },
    },
    new TypeError('write fetch failed'),
  ];
  const client = new GitHubNativeStatusClient({
    repository: 'kungfu-systems/kungfu',
    token: 'test-token',
    fetchImpl: async (_url, options) => {
      calls.push(options.method);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    sleep: async (delayMs) => delays.push(delayMs),
  });

  const pullRequest = await client.request('/pulls/42');
  assert.equal(pullRequest.head.sha, '1'.repeat(40));
  assert.deepEqual(calls, ['GET', 'GET']);
  assert.deepEqual(delays, [1_000]);

  await assert.rejects(
    client.request('/statuses/head', {
      method: 'POST',
      body: { state: 'success' },
    }),
    /write fetch failed/u,
  );
  assert.deepEqual(calls, ['GET', 'GET', 'POST']);
});

test('Dev behind admission produces and forwards an exact Project Cut replay proof', () => {
  assert.match(
    workflow,
    /Check out protected consumer adapter[\s\S]*fetch-depth: 0/u,
  );
  assert.match(
    workflow,
    /Check out exact Buildchain delivery runtime[\s\S]*ref: fefb02fbb874bf4bc86dc3fd4a707a9468e14718/u,
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

function nativeFixture(runStep = () => {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-warrant-native-'));
  const head = '1'.repeat(40);
  const statuses = [];
  return {
    cwd,
    statuses,
    options: {
      cwd,
      repository: 'kungfu-systems/kungfu',
      targetBranch: 'dev/v4/v4.0',
      pullRequestNumber: 42,
      expectedHead: head,
      statusContext: 'affected-native / linux',
      output: 'evidence/native.json',
    },
    dependencies: {
      client: {
        async requirePullRequest(number, actualHead, branch) {
          assert.deepEqual(
            [number, actualHead, branch],
            [42, head, 'dev/v4/v4.0'],
          );
        },
        async status(_head, value) {
          statuses.push(value);
        },
      },
      git(_cwd, args) {
        const command = args.join(' ');
        if (command === 'rev-parse HEAD') return head;
        if (command === 'rev-parse MERGE_HEAD') return '2'.repeat(40);
        if (command === 'write-tree') return '3'.repeat(40);
        if (command === 'ls-files -u' || command === 'diff --check') return '';
        throw new Error(`unexpected git call: ${command}`);
      },
      readPlan: () => ({
        schema: 'kungfu.core-affected-native-plan/v1',
        closureComponents: ['framework/core'],
        sdkQualification: { required: true },
        devQueueQualification: {
          shifuWorkspace: { required: true },
          kfdVerifier: { required: false },
        },
      }),
      runStep,
      now: () => '2026-08-12T00:00:00.000Z',
    },
  };
}

test('two-phase native adapter runs both partitions and seals exact-head success', async (t) => {
  const commands = [];
  const value = nativeFixture((_cwd, name, args, environment) =>
    commands.push({ name, args, environment }),
  );
  t.after(() => fs.rmSync(value.cwd, { recursive: true, force: true }));
  const receipt = await runNativeUnderWarrant(
    value.options,
    value.dependencies,
  );
  assert.match(receipt.receiptRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(
    value.statuses.map(({ state }) => state),
    ['pending', 'success'],
  );
  assert.deepEqual(
    commands
      .filter(({ name }) => name.includes('partition'))
      .map(
        ({ environment }) => environment.KUNGFU_AFFECTED_NATIVE_PARTITION_INDEX,
      ),
    ['0', '1'],
  );
  assert.equal(
    commands.find(({ name }) => name === 'Build Core SDK artifacts')
      ?.environment.KUNGFU_BUILDCHAIN_SOURCE_BUILD,
    '1',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(value.cwd, 'evidence/native.json')))
      .receiptRoot,
    receipt.receiptRoot,
  );
});

test('two-phase native adapter bootstraps Conan for SDK Warrant builds', async (t) => {
  const commands = [];
  const value = nativeFixture((_cwd, name, args, environment) =>
    commands.push({ name, args, environment }),
  );
  value.dependencies.readPlan = () => ({
    schema: 'kungfu.core-affected-native-plan/v1',
    closureComponents: [],
    sdkQualification: { required: true },
    devQueueQualification: {
      shifuWorkspace: { required: false },
      kfdVerifier: { required: false },
    },
  });
  t.after(() => fs.rmSync(value.cwd, { recursive: true, force: true }));

  await runNativeUnderWarrant(value.options, value.dependencies);

  const sdkBuild = commands.find(
    ({ name }) => name === 'Build Core SDK artifacts',
  );
  assert.equal(sdkBuild.environment.KUNGFU_BUILDCHAIN_SOURCE_BUILD, '1');
});

test('two-phase native adapter fails closed and replaces pending with failure', async (t) => {
  const value = nativeFixture((_cwd, name) => {
    if (name.includes('partition 0')) throw new Error('native shard failed');
  });
  t.after(() => fs.rmSync(value.cwd, { recursive: true, force: true }));
  await assert.rejects(
    runNativeUnderWarrant(value.options, value.dependencies),
    /native shard failed/u,
  );
  assert.deepEqual(
    value.statuses.map(({ state }) => state),
    ['pending', 'failure'],
  );
});

test('hosted native jobs remain fail-closed behind the exact active Warrant', () => {
  const sourceWorkflow = fs.readFileSync(
    '.github/workflows/affected-native-pr.yml',
    'utf8',
  );
  assert.match(
    sourceWorkflow,
    /warrant_admission:[\s\S]*dev warrant observe[\s\S]*activeWarrant\.pullRequestNumber[\s\S]*activeWarrant\.sourceHead[\s\S]*activeWarrant\.phase/u,
  );
  for (const job of [
    'affected_native_shards',
    'shifu_workspace',
    'kfd_verifier',
  ]) {
    const start = sourceWorkflow.indexOf(`  ${job}:\n`);
    const remainder = sourceWorkflow.slice(start + 3);
    const relativeEnd = remainder.search(/\n {2}[a-z][a-z0-9_]*:\n/u);
    const end = relativeEnd === -1 ? undefined : start + 3 + relativeEnd;
    const body = sourceWorkflow.slice(start, end);
    assert.match(body, /- warrant_admission/u);
    assert.match(body, /needs\.warrant_admission\.result == 'success'/u);
  }
  assert.match(
    sourceWorkflow,
    /Fail closed without the exact active Warrant[\s\S]*needs\.warrant_admission\.result != 'success'/u,
  );
  assert.match(
    sourceWorkflow,
    /merge_group\)[\s\S]*allowed_phase='\^qualified\$'/u,
  );
});

test('the protected migration bootstrap is one-way and retains legacy native qualification', () => {
  const sourceWorkflow = fs.readFileSync(
    '.github/workflows/affected-native-pr.yml',
    'utf8',
  );
  assert.match(
    sourceWorkflow,
    /Admit the bounded two-phase migration bootstrap[\s\S]*pull_request\)[\s\S]*\.pull_request\.base\.sha[\s\S]*merge_group\)[\s\S]*\.merge_group\.base_sha/u,
  );
  assert.match(
    sourceWorkflow,
    /! grep -Fq 'dev-delivery:native-under-warrant' "\$base_controller" &&[\s\S]*grep -Fq 'dev-delivery:native-under-warrant' "\$head_controller" &&[\s\S]*grep -Fq 'warrant_admission:' "\$head_native"/u,
  );
  assert.match(
    sourceWorkflow,
    /exact PR native qualification and merge-group replay remain mandatory for this transition PR/u,
  );
  assert.doesNotMatch(
    sourceWorkflow,
    /if ! grep -Fq 'dev-delivery:native-under-warrant' "\$head_controller"/u,
  );
});
