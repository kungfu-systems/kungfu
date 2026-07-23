// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  aggregatePlatformReceipts,
  buildPlatformReceipt,
  verifyAggregateReceipt,
} from './alpha-promotion-preflight.mjs';

const ROOT_FILES = [
  '.github/actions/require-alpha-preflight/action.yml',
  '.github/workflows/alpha-promotion-preflight.yml',
  '.github/workflows/build.yml',
  '.github/workflows/embedding-membrane-spike.yml',
  '.github/workflows/release-new-version.yml',
  '.github/workflows/shifu-ci.yml',
  '.node-version',
  '.buildchain/alpha-contract-lock.json',
  '.buildchain/contract-lock.json',
  'crates/libwasm-spike/rust-toolchain.toml',
  'crates/libwasm-spike/wasmer/Cargo.lock',
  'crates/libwasm-spike/wasmtime/Cargo.lock',
  'docs/qualification/gates/execution-profiles.json',
  'docs/release-promotion-rehearsal.contract.json',
  'package.json',
  'pnpm-lock.yaml',
  'scripts/alpha-promotion-preflight.mjs',
  'scripts/probe-release-platform.mjs',
  'shifu.gates.json',
];
const PLATFORMS = ['linux-x64', 'macos-arm64', 'windows-x64'];

function git(root, ...args) {
  return childProcess
    .execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    .trim();
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ROOT_FILES) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${file}\n`);
  }
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Preflight Test');
  git(root, 'config', 'user.email', 'preflight@example.invalid');
  git(root, 'add', '.');
  git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'fixture');
  return root;
}

function aggregate(root, generatedAt = '2026-07-23T00:00:00.000Z') {
  return aggregatePlatformReceipts({
    root,
    generatedAt,
    receipts: PLATFORMS.map((platform) =>
      buildPlatformReceipt({ root, platform, generatedAt }),
    ),
  });
}

test('aggregate receipt binds the exact commit, tree and reusable roots', (t) => {
  const root = fixture(t);
  const receipt = aggregate(root);
  assert.equal(
    verifyAggregateReceipt({
      root,
      receipt,
      expectedSourceCommit: git(root, 'rev-parse', 'HEAD'),
      now: Date.parse('2026-07-23T00:01:00.000Z'),
    }),
    receipt,
  );
  assert.deepEqual(receipt.reuse.excludedEvidence, [
    'credentials',
    'notarization',
    'publication',
    'signing',
  ]);
  assert.deepEqual(
    receipt.platforms.map((entry) => entry.platform),
    PLATFORMS,
  );
});

test('workflow, gate, toolchain and policy drift fail closed', (t) => {
  const root = fixture(t);
  for (const file of [
    '.github/workflows/build.yml',
    'shifu.gates.json',
    'crates/libwasm-spike/rust-toolchain.toml',
    'docs/qualification/gates/execution-profiles.json',
  ]) {
    const receipt = aggregate(root);
    fs.appendFileSync(path.join(root, file), 'drift\n');
    assert.throws(
      () =>
        verifyAggregateReceipt({
          root,
          receipt,
          expectedSourceCommit: git(root, 'rev-parse', 'HEAD'),
          now: Date.parse('2026-07-23T00:01:00.000Z'),
        }),
      /Root mismatch/u,
    );
    git(root, 'checkout', '--', file);
  }
});

test('receipt root, source commit, age and platform coverage fail closed', (t) => {
  const root = fixture(t);
  const now = Date.parse('2026-07-23T00:01:00.000Z');
  const receipt = aggregate(root);
  assert.throws(
    () =>
      verifyAggregateReceipt({
        root,
        receipt: { ...receipt, status: 'failed' },
        expectedSourceCommit: git(root, 'rev-parse', 'HEAD'),
        now,
      }),
    /receipt root mismatch/u,
  );
  assert.throws(
    () =>
      verifyAggregateReceipt({
        root,
        receipt,
        expectedSourceCommit: 'f'.repeat(40),
        now,
      }),
    /sourceCommit mismatch/u,
  );
  assert.throws(
    () =>
      verifyAggregateReceipt({
        root,
        receipt,
        expectedSourceCommit: git(root, 'rev-parse', 'HEAD'),
        now: Date.parse('2026-08-01T00:00:00.000Z'),
      }),
    /receipt age/u,
  );
});
