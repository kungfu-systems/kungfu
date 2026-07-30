// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = '.github/workflows/kungfu-agent-patrol.yml';
const workflow = fs.readFileSync(path.join(root, workflowPath), 'utf8');

test('Agent Patrol is scheduled synthetic or trusted manual only', () => {
  assert.match(workflow, /^on:\n {2}[\s\S]*schedule:/m);
  assert.match(workflow, /cron: "0 18 \* \* 1-6"/);
  assert.match(workflow, /cron: "0 18 \* \* 0"/);
  assert.match(workflow, /^ {2}workflow_dispatch:\n {4}inputs:/m);
  assert.match(workflow, /default: light/);
  assert.match(
    workflow,
    /(?:\n {10}- light)(?:\n {10}- deep)(?:\n {10}- real-snapshot)/,
  );
  assert.doesNotMatch(workflow, /^\s+(?:pull_request|push):/m);
  assert.match(workflow, /github\.repository == 'kungfu-systems\/kungfu'/);
  assert.match(
    workflow,
    /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/,
  );
  assert.match(workflow, /github\.ref_protected == true/);
  assert.match(workflow, /permissions:\n {2}contents: read/);
});

test('Agent Patrol is isolated to the dedicated agent-121 runner', () => {
  assert.match(
    workflow,
    /runs-on:\n {6}- agent-121\n {6}- kungfu-agent-patrol/,
  );
  assert.doesNotMatch(workflow, /\n {6}- (?:self-hosted|Linux|X64)\n/);
  assert.match(workflow, /test "\$RUNNER_NAME" = "agent-121-kungfu-systems"/);
  assert.match(workflow, /test "\$\(id -u\)" = "996"/);
  assert.match(workflow, /DOCKER_HOST=%s\\n' "\$docker_host" >>"\$GITHUB_ENV"/);
  assert.match(workflow, /group: kungfu-agent-patrol-agent-121/);
  assert.match(workflow, /timeout-minutes: 90/);
});

test('Agent Patrol bounds the protected-source checkout transport', () => {
  assert.match(
    workflow,
    /- name: Check out exact protected source\n {8}uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n {8}env:\n {10}GIT_CONFIG_COUNT: "1"\n {10}GIT_CONFIG_KEY_0: http\.version\n {10}GIT_CONFIG_VALUE_0: HTTP\/1\.1\n {8}with:/,
  );
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /fetch-depth: 1/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /git config --global/u);
});

test('Agent Patrol pins its local-model runtime and retains bounded evidence', () => {
  assert.match(
    workflow,
    /opencode-ci@sha256:4083ee089fa9a419f4915505094a6c1bcce433ff77455605ce8993af3b684ed3/,
  );
  assert.match(workflow, /OPENCODE_MODEL: qwen3-coder:30b-opencode-64k/);
  assert.match(
    workflow,
    /OPENCODE_BASE_URL: http:\/\/host\.docker\.internal:11435\/v1/,
  );
  assert.match(
    workflow,
    /OPENCODE_HOST_PROBE_URL: http:\/\/127\.0\.0\.1:11435\/v1\/models/,
  );
  assert.match(workflow, /docker image inspect "\$OPENCODE_IMAGE"/);
  assert.doesNotMatch(workflow, /docker pull|:latest\b/);
  assert.match(
    workflow,
    /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/,
  );
  assert.match(workflow, /retention-days: 14/);
  assert.match(workflow, /\/plan\.json/);
  assert.match(workflow, /repository-work\/\*\/evidence/);
});

test('Agent Patrol selects and serially executes bounded fixture suites', () => {
  assert.match(workflow, /\.\/shifu agent-patrol:select --/);
  assert.match(workflow, /--rotation-key "\$PATROL_ROTATION_KEY"/);
  assert.match(workflow, /--fixture "\$fixture"/);
  assert.match(workflow, /jq -r '\.fixtures\[\]'/);
  assert.match(workflow, /group: kungfu-agent-patrol-agent-121/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test('Agent Patrol captures deduplicated Findings but can never admit Issues', () => {
  assert.match(workflow, /\.\/shifu agent-patrol:classify --/);
  assert.match(workflow, /\.\/shifu agent-patrol:dogfood-capture --/);
  assert.match(workflow, /\.issueAdmitted == false/);
  assert.doesNotMatch(workflow, /dogfood (?:admit|transition)/);
  assert.doesNotMatch(
    workflow,
    /secrets\.|GITHUB_TOKEN|api[_-]?key|authorization|password/iu,
  );
  assert.doesNotMatch(
    workflow,
    /--privileged|(?:-v|--volume|--mount)[^\n]*docker\.sock|--network(?:=| )host/,
  );
});
