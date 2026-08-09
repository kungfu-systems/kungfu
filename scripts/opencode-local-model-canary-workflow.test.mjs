// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = fs.readFileSync(
  path.join(root, '.github/workflows/opencode-local-model-canary.yml'),
  'utf8',
);

test('local-model canary is manual, immutable, and bounded to agent-120', () => {
  assert.match(workflow, /^on:\n {2}workflow_dispatch:\s*$/m);
  assert.doesNotMatch(workflow, /^\s+(?:pull_request|push|schedule):/m);
  assert.match(workflow, /permissions:\n {2}contents: read/);
  assert.match(
    workflow,
    /runs-on:\n {6}- self-hosted\n {6}- Linux\n {6}- X64\n {6}- agent-120\n {6}- kungfu-build/,
  );
  assert.match(workflow, /test "\$RUNNER_NAME" = "agent-120-kungfu-systems"/);
  assert.match(
    workflow,
    /opencode-ci@sha256:4083ee089fa9a419f4915505094a6c1bcce433ff77455605ce8993af3b684ed3/,
  );
  assert.match(workflow, /docker image inspect "\$OPENCODE_IMAGE"/);
  assert.doesNotMatch(workflow, /docker pull|:latest\b/);
});

test('local-model canary preserves the narrow endpoint and verifier boundary', () => {
  assert.match(
    workflow,
    /OPENCODE_BASE_URL: http:\/\/host\.docker\.internal:11435\/v1/,
  );
  assert.match(
    workflow,
    /OPENCODE_HOST_PROBE_URL: http:\/\/172\.17\.0\.1:11435\/v1\/models/,
  );
  assert.match(workflow, /OPENCODE_MODEL: qwen3-coder:30b-opencode-64k/);
  assert.match(workflow, /--add-host host\.docker\.internal:host-gateway/);
  assert.match(workflow, /--user "\$\(id -u\):\$\(id -g\)"/);
  assert.match(workflow, /--read-only/);
  assert.match(workflow, /--cap-drop ALL/);
  assert.match(workflow, /--security-opt no-new-privileges/);
  assert.match(workflow, /OPENCODE_VERIFY_COMMAND=/);
  assert.match(workflow, /opencode-ci-verify/);
  assert.match(
    workflow,
    /\.passed == true and \.model == \$model and \.opencode_exit == 0 and \.verifier_exit == 0/,
  );
  assert.doesNotMatch(workflow, /--network host|docker\.sock|privileged/);
});

test('local-model canary does not admit credentials or untrusted source', () => {
  assert.doesNotMatch(workflow, /actions\/checkout|GITHUB_TOKEN|secrets\./);
  assert.doesNotMatch(workflow, /api[_-]?key|authorization|password/i);
  assert.match(
    workflow,
    /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/,
  );
});
