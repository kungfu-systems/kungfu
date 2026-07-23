// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  measureCandidateStage,
  measureCandidateStageSync,
} = require('./candidate-timeline-events.cjs');

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-candidate-events-'),
  );
  return {
    root,
    output: path.join(root, 'events.jsonl'),
    env: {
      KUNGFU_CANDIDATE_TIMELINE_EVENTS: path.join(root, 'events.jsonl'),
      KUNGFU_CANDIDATE_GATE_ID: 'source.changed-scope',
      KUNGFU_AFFECTED_NATIVE_PARTITION_INDEX: '0',
      GITHUB_EVENT_NAME: 'merge_group',
      GITHUB_RUN_ID: '42',
      GITHUB_SHA: 'a'.repeat(40),
    },
  };
}

function events(value) {
  return fs
    .readFileSync(value.output, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('candidate stage records bounded source and attempt correlation', () => {
  const value = fixture();
  try {
    assert.equal(
      measureCandidateStageSync('core-build', 'core-build', () => 7, {
        env: value.env,
      }),
      7,
    );
    const [event] = events(value);
    assert.equal(event.attempt.id, 'merge_group-42');
    assert.equal(event.attempt.mergeGroupSha, 'a'.repeat(40));
    assert.equal(event.gate.partition, '0');
    assert.equal(event.status, 'success');
    assert.equal(event.timing.clock, 'monotonic-duration+wall-envelope');
    assert.equal(event.timing.precisionMs, 1);
    assert.deepEqual(Object.keys(event.attributes).sort(), [
      'sourceSha',
      'stage',
    ]);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('candidate stage records failure and rethrows', async () => {
  const value = fixture();
  try {
    await assert.rejects(
      measureCandidateStage(
        'wire-rust',
        'sdk-wire-rust',
        async () => {
          throw new Error('fixture failure');
        },
        { env: value.env, language: 'rust' },
      ),
      /fixture failure/,
    );
    const [event] = events(value);
    assert.equal(event.status, 'failure');
    assert.equal(event.attributes.language, 'rust');
    assert.equal(JSON.stringify(event).includes('fixture failure'), false);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
