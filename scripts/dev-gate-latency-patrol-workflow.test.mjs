// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = fs.readFileSync(
  path.join(root, '.github/workflows/dev-gate-latency-patrol.yml'),
  'utf8',
);

test('latency Patrol covers every contract-compatible dev family', () => {
  assert.match(workflow, /push:\n {4}branches:\n {6}- "dev\/v\*\/v\*"/);
  assert.match(workflow, /schedule:\n {4}- cron:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /dev\/v[456]\/v[456]\.\d/u);
  assert.match(workflow, /\.\/shifu dev-gate-latency-patrol:select --/);
  assert.match(workflow, /jq -r '\.branches\[\]'/);
  assert.match(workflow, /--limit 30/);
  assert.match(workflow, /--latency-only/);
});

test('latency Patrol is read-only and cannot become a required gate', () => {
  assert.match(workflow, /permissions:\n {2}contents: read\n {2}actions: read/);
  assert.match(workflow, /collect:\n[\s\S]*runs-on: ubuntu-latest/);
  assert.match(workflow, /capture:\n[\s\S]*continue-on-error: true/);
  assert.match(workflow, /collect:\n[\s\S]*continue-on-error: true/);
  assert.doesNotMatch(workflow, /pull_request:|merge_group:/);
  assert.doesNotMatch(workflow, /dogfood (?:admit|transition)/);
  assert.doesNotMatch(workflow, /permissions:[\s\S]*\bwrite\b/u);
});

test('latency Patrol captures native Findings in persistent agent-121 state', () => {
  assert.match(
    workflow,
    /runs-on:\n {6}- agent-121\n {6}- kungfu-agent-patrol/,
  );
  assert.match(
    workflow,
    /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/,
  );
  assert.doesNotMatch(workflow, /KUNGFU_DOGFOOD_COMMAND:/);
  assert.match(
    workflow,
    /Prepare native Dogfood runtime only for anomalies[\s\S]*?\.captureRequired == true[\s\S]*?\.\/shifu build:core/u,
  );
  assert.match(
    workflow,
    /\$HOME\/\.local\/state\/kungfu-dev-gate-latency-patrol/,
  );
  assert.match(
    workflow,
    /\.\/shifu dev-gate-latency-patrol:dogfood-capture --/,
  );
  assert.match(
    workflow,
    /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/,
  );
  assert.match(workflow, /retention-days: 30/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.match(workflow, /reportRoot/);
});

test('latency Patrol uses runner context only inside steps', () => {
  assert.match(
    workflow,
    /Capture or deduplicate native Dogfood Findings[\s\S]*?env:\n {10}KUNGFU_DEV_GATE_PATROL_EVIDENCE:.*runner\.temp/u,
  );
});

test('latency Patrol passes collector arguments through Shifu once', () => {
  assert.match(
    workflow,
    /\.\/shifu gate:latency:measure \\\n {14}--branch "\$branch"/u,
  );
  assert.doesNotMatch(workflow, /\.\/shifu gate:latency:measure -- \\/u);
});
