// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { resolveCompositionBase } from './check-project-cut-composition-gate.mjs';
import {
  fetchSourceAcceptanceCommit,
  readSourceAcceptanceGit,
  sourceAcceptanceMergeBaseCandidates,
  sourceAcceptancePlan,
  sourceMergeGroupBase,
} from './source-acceptance.mjs';

test('Project Cut composition uses the exact merge-group base without ancestry', () => {
  const baseSha = 'a'.repeat(40);
  assert.equal(
    resolveCompositionBase({
      mergeGroupBase: () => ({
        ref: 'github.merge_group.base_sha',
        sha: baseSha,
        diffOperator: '..',
      }),
      candidates: () => assert.fail('merge-group base must be authoritative'),
      gitRead: () =>
        assert.fail('merge-group base must not require merge-base'),
    }),
    baseSha,
  );
});

test('Project Cut composition retains branch merge-base fallback', () => {
  const baseSha = 'b'.repeat(40);
  const calls = [];
  assert.equal(
    resolveCompositionBase({
      mergeGroupBase: () => null,
      candidates: () => ['origin/dev/v4/v4.0', 'dev/v4/v4.0'],
      gitRead: (args) => {
        calls.push(args);
        return args[1] === 'dev/v4/v4.0' ? baseSha : '';
      },
    }),
    baseSha,
  );
  assert.deepEqual(calls, [
    ['merge-base', 'origin/dev/v4/v4.0', 'HEAD'],
    ['merge-base', 'dev/v4/v4.0', 'HEAD'],
  ]);
});

test('source acceptance fetches exact merge-group base ancestry without blobs', () => {
  const commit = 'a'.repeat(40);
  const calls = [];
  fetchSourceAcceptanceCommit(commit, (command, args, options) => {
    calls.push({ command, args, options });
    return calls.length === 1
      ? { status: 0, stdout: 'true\n', stderr: '' }
      : { status: 0, stdout: '', stderr: '' };
  });
  assert.deepEqual(calls[0].command, 'git');
  assert.deepEqual(calls[0].args, ['rev-parse', '--is-shallow-repository']);
  assert.deepEqual(calls[1].args, [
    'fetch',
    '--no-tags',
    '--no-write-fetch-head',
    '--filter=blob:none',
    '--unshallow',
    'origin',
    commit,
  ]);
  assert.equal(calls[1].options.encoding, 'utf8');
});

test('source acceptance does not unshallow a complete repository', () => {
  const commit = 'a'.repeat(40);
  const calls = [];
  fetchSourceAcceptanceCommit(commit, (command, args, options) => {
    calls.push({ command, args, options });
    return calls.length === 1
      ? { status: 0, stdout: 'false\n', stderr: '' }
      : { status: 0, stdout: '', stderr: '' };
  });
  assert.deepEqual(calls[1].args, [
    'fetch',
    '--no-tags',
    '--no-write-fetch-head',
    '--filter=blob:none',
    'origin',
    commit,
  ]);
});

test('source acceptance exact-base fetch repairs a depth-one history walk', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-source-acceptance-shallow-history-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin');
  const checkout = path.join(root, 'checkout');
  const git = (cwd, args) => readSourceAcceptanceGit(args, { cwd });

  fs.mkdirSync(origin);
  git(origin, ['init', '--quiet']);
  git(origin, ['config', 'user.name', 'KFD Fixture']);
  git(origin, ['config', 'user.email', 'kfd-fixture@kungfu.invalid']);
  fs.writeFileSync(path.join(origin, 'history.txt'), 'baseline\n');
  git(origin, ['add', 'history.txt']);
  git(origin, ['commit', '--quiet', '-m', 'baseline']);
  const baselineSha = git(origin, ['rev-parse', 'HEAD']);
  fs.appendFileSync(path.join(origin, 'history.txt'), 'base\n');
  git(origin, ['commit', '--quiet', '-am', 'base']);
  const baseSha = git(origin, ['rev-parse', 'HEAD']);
  fs.appendFileSync(path.join(origin, 'history.txt'), 'head\n');
  git(origin, ['commit', '--quiet', '-am', 'head']);

  const cloned = spawnSync(
    'git',
    ['clone', '--quiet', '--depth=1', `file://${origin}`, checkout],
    { encoding: 'utf8' },
  );
  assert.equal(cloned.status, 0, cloned.stderr);
  assert.notEqual(
    spawnSync('git', ['cat-file', '-e', `${baselineSha}^{commit}`], {
      cwd: checkout,
      encoding: 'utf8',
    }).status,
    0,
    'depth-one fixture must begin without the historical baseline',
  );

  fetchSourceAcceptanceCommit(baseSha, (command, args, options) =>
    spawnSync(command, args, { ...options, cwd: checkout }),
  );
  assert.equal(git(checkout, ['cat-file', '-t', baselineSha]), 'commit');
  assert.equal(
    git(checkout, ['log', '--format=%H', `${baselineSha}..HEAD`]).split('\n')
      .length,
    2,
  );
});

test('source acceptance falls back to the verified merge-group base ref', () => {
  assert.deepEqual(
    sourceAcceptanceMergeBaseCandidates(['origin/dev/v4/v4.0']),
    ['origin/dev/v4/v4.0', 'refs/buildchain/source-proof/current-base'],
  );
});

test('source acceptance hydrates and directly diffs an exact merge-group base', () => {
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  let hydrated = false;
  const calls = [];
  const result = sourceMergeGroupBase({
    env: {
      GITHUB_EVENT_NAME: 'merge_group',
      GITHUB_EVENT_PATH: '/event.json',
    },
    readFile: () =>
      JSON.stringify({
        merge_group: { base_sha: baseSha, head_sha: headSha },
      }),
    gitRead: (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return headSha;
      if (args[0] === 'cat-file') return hydrated ? 'commit' : '';
      return '';
    },
    fetchCommit: (commit) => {
      assert.equal(commit, baseSha);
      hydrated = true;
    },
  });

  assert.deepEqual(result, {
    ref: 'github.merge_group.base_sha',
    sha: baseSha,
    diffOperator: '..',
  });
  assert.deepEqual(calls, [
    ['rev-parse', 'HEAD'],
    ['cat-file', '-t', baseSha],
    ['cat-file', '-t', baseSha],
  ]);
});

test('source acceptance rejects a merge-group event for another checkout', () => {
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  assert.throws(
    () =>
      sourceMergeGroupBase({
        env: {
          GITHUB_EVENT_NAME: 'merge_group',
          GITHUB_EVENT_PATH: '/event.json',
        },
        readFile: () =>
          JSON.stringify({
            merge_group: { base_sha: baseSha, head_sha: headSha },
          }),
        gitRead: () => 'c'.repeat(40),
        fetchCommit: () => assert.fail('mismatched event must not fetch'),
      }),
    /does not match source checkout/u,
  );
});

test('source plan binds protected ratchets to the exact evidence base', () => {
  const evidenceBaseCommit = 'a'.repeat(40);
  const plan = sourceAcceptancePlan(
    ['scripts/example.mjs'],
    evidenceBaseCommit,
  );
  assert.deepEqual(
    plan.find((step) => step.label === 'code complexity budget ratchet').env,
    { KUNGFU_COMPLEXITY_PROTECTED_REF: evidenceBaseCommit },
  );
  assert.deepEqual(
    plan.find((step) => step.label === 'documentation contracts').env,
    {
      KUNGFU_ADR_EVIDENCE_BASE_SHA: evidenceBaseCommit,
      KUNGFU_EVOLUTION_BASE: evidenceBaseCommit,
    },
  );
});

test('source acceptance retains Git patches larger than the spawnSync default buffer', (t) => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-source-acceptance-large-git-output-'),
  );
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const gitRead = (args) => readSourceAcceptanceGit(args, { cwd: repository });
  gitRead(['init', '--quiet']);
  gitRead(['config', 'user.name', 'KFD Fixture']);
  gitRead(['config', 'user.email', 'kfd-fixture@kungfu.invalid']);
  fs.writeFileSync(path.join(repository, 'large.txt'), '0\n'.repeat(600_000));
  gitRead(['add', 'large.txt']);
  gitRead(['commit', '--quiet', '-m', 'large source patch']);
  const baseSha = gitRead(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repository, 'large.txt'), '1\n'.repeat(600_000));

  const patch = gitRead(['diff', '--binary', '--full-index', baseSha, '--']);
  assert.ok(patch.length > 1024 * 1024);
  assert.match(patch, /\+1/u);
});
