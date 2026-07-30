// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = fs.readFileSync(
  path.join(root, '.github/workflows/opencode-agent-repository-work.yml'),
  'utf8',
);
const workflowAuthority = JSON.parse(
  fs.readFileSync(
    path.join(root, 'docs/qualification/gates/workflow-authority.json'),
    'utf8',
  ),
);

test('repository-work experiment is manual and restricted to trusted agent-120', () => {
  assert.equal(
    workflowAuthority.workflows.find(
      ({ path: workflowPath }) =>
        workflowPath === '.github/workflows/opencode-agent-repository-work.yml',
    )?.authority,
    'qualification',
  );
  assert.match(workflow, /^on:\n {2}workflow_dispatch:\s*$/m);
  assert.doesNotMatch(workflow, /^\s+(?:pull_request|push|schedule):/m);
  assert.match(workflow, /permissions:\n {2}contents: read/);
  assert.match(
    workflow,
    /runs-on:\n {6}- self-hosted\n {6}- Linux\n {6}- X64\n {6}- agent-120\n {6}- kungfu-build/,
  );
  assert.match(workflow, /test "\$RUNNER_NAME" = "agent-120-kungfu-systems"/);
  assert.match(workflow, /timeout-minutes: 45/);
});

test('repository-work experiment pins image, model, and local endpoint', () => {
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
    /OPENCODE_HOST_PROBE_URL: http:\/\/172\.17\.0\.1:11435\/v1\/models/,
  );
  assert.match(workflow, /docker image inspect "\$OPENCODE_IMAGE"/);
  assert.doesNotMatch(workflow, /docker pull|:latest\b/);
});

test('workflow preserves bounded evidence and non-secret execution', () => {
  assert.match(workflow, /\.\/shifu build:core/);
  assert.match(workflow, /\.\/shifu qualify:agent-repository-work/);
  assert.match(
    workflow,
    /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/,
  );
  assert.match(workflow, /retention-days: 14/);
  assert.doesNotMatch(
    workflow,
    /secrets\.|GITHUB_TOKEN|api[_-]?key|authorization|password/iu,
  );
  assert.doesNotMatch(workflow, /--privileged|docker\.sock|--network host/);
});
