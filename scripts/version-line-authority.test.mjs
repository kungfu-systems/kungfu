// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  checkVersionLineAuthority,
  narrowMatches,
  scanNarrowBindings,
} from '../framework/version-line/check-version-line-authority.mjs';
import {
  deriveProjection,
  digest,
  readAuthority,
  renderedProjections,
  rulesetContract,
  validateAuthority,
} from '../framework/version-line/version-line-authority.mjs';

test('checked-in version-line authority and projections are qualifying', () => {
  const result = checkVersionLineAuthority();
  assert.equal(result.line.id, '4.0');
  assert.equal(result.scan.violations.length, 0);
});

test('synthetic v5 and v6 lines require data only and derive exact runtime objects', () => {
  const authority = structuredClone(readAuthority());
  authority.authorityRoot = undefined;
  authority.lines = [
    ...authority.lines,
    { id: '5.0', major: 5, minor: 0, lifecycle: 'supported' },
    { id: '6.2', major: 6, minor: 2, lifecycle: 'supported' },
  ];
  authority.authorityRoot = digest(authority);
  validateAuthority(authority);
  const projection = deriveProjection(authority);
  assert.deepEqual(
    projection.lines.slice(1).map(({ branches, candidateLedger }) => ({
      branches,
      candidateLedger,
    })),
    [
      {
        branches: {
          dev: 'dev/v5/v5.0',
          alpha: 'alpha/v5/v5.0',
          stable: 'release/v5/v5.0',
          majorPublicationGate: 'publish-gate/major/v5/v5.0/*',
        },
        candidateLedger: 'buildchain/candidate-ledger/v5/v5.0',
      },
      {
        branches: {
          dev: 'dev/v6/v6.2',
          alpha: 'alpha/v6/v6.2',
          stable: 'release/v6/v6.2',
          majorPublicationGate: 'publish-gate/major/v6/v6.2/*',
        },
        candidateLedger: 'buildchain/candidate-ledger/v6/v6.2',
      },
    ],
  );
  authority.activeLine = '6.2';
  authority.authorityRoot = undefined;
  authority.authorityRoot = digest(authority);
  assert.equal(rulesetContract(authority, 'alpha').targetRef, 'alpha/v6/v6.2');
  assert.equal(
    rulesetContract(authority, 'stable').targetRef,
    'release/v6/v6.2',
  );
});

test('generator reproduces every declared checked-in projection byte-for-byte', () => {
  for (const [file, expected] of renderedProjections()) {
    assert.equal(fs.readFileSync(file, 'utf8'), expected, file);
  }
});

test('formal native release lanes are hosted while diagnostic aliases remain self-hosted', () => {
  const projection = deriveProjection(readAuthority());
  assert.deepEqual(
    projection.runnerRouting.matrices.native.map(
      ({ id, runner, environment }) => ({
        id,
        runner,
        environment: environment ?? {},
      }),
    ),
    [
      {
        id: 'linux-x64',
        runner: '["ubuntu-24.04"]',
        environment: { CC: 'gcc-14', CXX: 'g++-14' },
      },
      { id: 'linux-arm64', runner: '["ubuntu-24.04-arm"]', environment: {} },
      { id: 'macos-arm64', runner: '["macos-15"]', environment: {} },
      { id: 'windows-x64', runner: '["windows-2022"]', environment: {} },
    ],
  );
  assert.ok(
    projection.runnerRouting.matrices.selfHosted.every(({ runner }) =>
      JSON.parse(runner).includes('self-hosted'),
    ),
  );
});

test('narrow literal detector catches branches, ledgers, rulesets, and runner names', () => {
  assert.deepEqual(
    narrowMatches(
      'dev/v9/v9.1 buildchain/candidate-ledger/v9/v9.1 alpha-v9 kungfu-v9-native',
    ),
    [
      'dev/v9/v9.1',
      'buildchain/candidate-ledger/v9/v9.1',
      'kungfu-v9-native',
      'alpha-v9',
    ],
  );
});

test('a new unclassified narrow operational source fails closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-version-line-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scripts/new-release-route.mjs'),
    "export const route = 'release/v9/v9.0';\n",
  );
  const scan = scanNarrowBindings(root);
  assert.deepEqual(scan.violations, [
    {
      file: 'scripts/new-release-route.mjs',
      matches: ['release/v9/v9.0'],
    },
  ]);
});

test('retained native evidence may preserve an exact historical version line', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-version-line-'));
  const evidence = path.join(
    root,
    '.kungfu/retained-native-evidence/exact-cut/manifest.json',
  );
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  fs.writeFileSync(evidence, '{"protectedBase":"dev/v9/v9.0"}\n');
  const scan = scanNarrowBindings(root, {
    immutableEvidencePrefixes: ['.kungfu/retained-native-evidence/'],
  });
  assert.deepEqual(scan, { admitted: [], violations: [] });
});

test('an admitted projection file rejects a narrow value absent from authority data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-version-line-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scripts/release-route.mjs'),
    "export const routes = ['release/v4/v4.0', 'release/v9/v9.0'];\n",
  );
  const scan = scanNarrowBindings(
    root,
    { activeProjectionPaths: ['scripts/release-route.mjs'] },
    new Set(['release/v4/v4.0']),
  );
  assert.deepEqual(scan, {
    admitted: [
      {
        file: 'scripts/release-route.mjs',
        matches: ['release/v4/v4.0'],
      },
    ],
    violations: [
      {
        file: 'scripts/release-route.mjs',
        matches: ['release/v9/v9.0'],
      },
    ],
  });
});

test('tracked source scan excludes untracked CI runtime material', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-version-line-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, '.buildchain/runtime'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'scripts/tracked-route.mjs'),
    "export const route = 'release/v9/v9.0';\n",
  );
  fs.writeFileSync(
    path.join(root, '.buildchain/runtime/transient.mjs'),
    "export const route = 'release/v8/v8.0';\n",
  );
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  assert.equal(
    spawnSync('git', ['-C', root, 'add', 'scripts/tracked-route.mjs']).status,
    0,
  );
  assert.deepEqual(scanNarrowBindings(root).violations, [
    {
      file: 'scripts/tracked-route.mjs',
      matches: ['release/v9/v9.0'],
    },
  ]);
});
