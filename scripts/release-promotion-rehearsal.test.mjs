// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  extractWorkflowJob,
  runFixtureSuite,
  runRehearsal,
  validatePromotionContract,
  validateWorkflowSources,
} from './release-promotion-rehearsal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'docs/release-promotion-rehearsal.contract.json'),
    'utf8',
  ),
);

test('the committed Buildchain promotion consumer contract is coherent', () => {
  const result = validatePromotionContract(ROOT);
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
});

test('alpha and stable promotion fixtures cover admission and fail-closed paths', () => {
  const result = runFixtureSuite(ROOT);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.fixtures.map((fixture) => [fixture.base_ref, fixture.expected_ok]),
    [
      ['alpha/v4/v4.0', false],
      ['alpha/v4/v4.0', true],
      ['release/v4/v4.0', false],
      ['release/v4/v4.0', true],
    ],
  );
});

test('promotion workflow drift is rejected before Buildchain promotion', () => {
  const promotionPath = CONTRACT.workflows.promotion;
  const original = fs.readFileSync(path.join(ROOT, promotionPath), 'utf8');
  const drifted = original.replace(
    'required-status-check: build',
    'required-status-check: skipped',
  );
  assert.notEqual(drifted, original);
  const result = validateWorkflowSources(ROOT, CONTRACT, {
    promotion: drifted,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.findings.some((entry) =>
      entry.message.includes('required status check drifted'),
    ),
  );
});

test('promotion preflight owns no release credentials or side-effect commands', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, CONTRACT.workflows.promotion),
    'utf8',
  );
  const preflight = extractWorkflowJob(workflow, 'promotion-contract');
  assert.ok(preflight);
  assert.doesNotMatch(preflight, /^\s+secrets:/m);
  for (const command of CONTRACT.safety.forbidden_commands) {
    assert.equal(preflight.includes(command), false, command);
  }
});

test('the full rehearsal preserves tracked files, branches, and tags', () => {
  const result = runRehearsal({ root: ROOT });
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
  assert.equal(result.side_effects.tracked_files_changed, false);
  assert.equal(result.side_effects.refs_changed, false);
  assert.equal(result.side_effects.remote_mutations_attempted, false);
  assert.equal(result.side_effects.promotion_credentials_consumed, false);
});

test('an actual GitHub promotion event traverses the ADR gate CLI', () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-event-'));
  const eventPath = path.join(directory, 'event.json');
  fs.writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        base: { ref: 'alpha/v4/v4.0', sha: head },
        head: { ref: 'dev/v4/v4.0', sha: head },
        html_url: 'https://github.com/kungfu-systems/kungfu/pull/999903',
        body: `<!-- kungfu-adr-release:v1\n${JSON.stringify({
          schema: 'kungfu.adr-release-pr/v1',
          kind: 'alpha-settlement',
          no_adr_progress_reason:
            'Synthetic no-delta promotion proves the immutable event path',
        })}\n-->`,
      },
    }),
  );
  try {
    const result = runRehearsal({ root: ROOT, eventPath });
    assert.equal(result.ok, true, result.event?.output);
    assert.equal(result.event?.report?.mode, 'alpha');
    assert.equal(result.event?.report?.ok, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an actual stable event fails closed on the current ADR balance sheet', () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-event-'));
  const eventPath = path.join(directory, 'event.json');
  fs.writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        base: { ref: 'release/v4/v4.0', sha: head },
        head: { ref: 'alpha/v4/v4.0', sha: head },
        html_url: 'https://github.com/kungfu-systems/kungfu/pull/999904',
        body: `<!-- kungfu-adr-release:v1\n${JSON.stringify({
          schema: 'kungfu.adr-release-pr/v1',
          kind: 'stable-admission',
          release: '4.0.0',
        })}\n-->`,
      },
    }),
  );
  try {
    const result = runRehearsal({ root: ROOT, eventPath });
    assert.equal(result.ok, false);
    assert.equal(result.event?.report?.mode, 'stable');
    assert.equal(result.event?.report?.ok, false);
    assert.ok(result.event?.report?.summary.blocked > 0);
    assert.ok(result.findings.some((entry) => entry.code === 'event'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
