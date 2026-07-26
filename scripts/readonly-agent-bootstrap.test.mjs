// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function copyFile(sourceRoot, targetRoot, relative) {
  const target = path.join(targetRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, relative), target);
}

function executableOnPath(name) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching the declared PATH.
    }
  }
  throw new Error(`${name} is not available on PATH`);
}

function snapshotSource(root) {
  const rows = [];
  const visit = (directory) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === '.git') continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) {
        rows.push(`d:${relative}`);
        visit(absolute);
      } else if (entry.isFile()) {
        rows.push(
          `f:${relative}:${crypto
            .createHash('sha256')
            .update(fs.readFileSync(absolute))
            .digest('hex')}`,
        );
      }
    }
  };
  visit(root);
  return rows;
}

function makeReadOnly(root) {
  const directories = [];
  const visit = (directory) => {
    directories.push(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile())
        fs.chmodSync(absolute, entry.name === 'shifu' ? 0o555 : 0o444);
    }
  };
  visit(root);
  for (const directory of directories.reverse()) fs.chmodSync(directory, 0o555);
}

function restoreWritable(root) {
  if (!fs.existsSync(root)) return;
  const visit = (directory) => {
    fs.chmodSync(directory, 0o755);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) fs.chmodSync(absolute, 0o644);
    }
  };
  visit(root);
}

test('declared discovery routes are zero-write in a cold read-only fixture', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX filesystem fixture; shifu.cmd parity is checked statically');
    return;
  }

  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-readonly-bootstrap-'),
  );
  const fixture = path.join(temporary, 'source');
  const tools = path.join(temporary, 'tools');
  const home = path.join(temporary, 'home');
  const toolLog = path.join(temporary, 'unexpected-tool.log');
  fs.mkdirSync(tools);
  fs.mkdirSync(home);
  t.after(() => {
    restoreWritable(fixture);
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  const git = executableOnPath('git');
  const node = process.execPath;
  const cloned = spawnSync(
    git,
    ['clone', '--shared', '--quiet', ROOT, fixture],
    { encoding: 'utf8' },
  );
  assert.equal(cloned.status, 0, cloned.stderr);
  for (const relative of [
    'shifu',
    'shifu.cmd',
    'scripts/kungfu-invariant-discovery.mjs',
    'scripts/kungfu-invariant.mjs',
    'scripts/code-complexity-budget.mjs',
    'scripts/code-complexity-budget.test.mjs',
    'scripts/readonly-agent-bootstrap.test.mjs',
    'scripts/shifu-readonly-entry.mjs',
    'framework/maintainability/code-complexity-policy.json',
    'framework/maintainability/code-complexity-baseline.json',
    'framework/maintainability/semantic-amplification.manifest.json',
    'framework/maintainability/semantic-amplification-report.json',
    'framework/maintainability/semantic-amplification.mjs',
  ])
    copyFile(ROOT, fixture, relative);
  fs.chmodSync(path.join(fixture, 'shifu'), 0o755);

  fs.symlinkSync(git, path.join(tools, 'git'));
  fs.symlinkSync(node, path.join(tools, 'node'));
  for (const name of ['cargo', 'corepack', 'curl', 'fnm', 'pnpm', 'uv']) {
    const file = path.join(tools, name);
    fs.writeFileSync(
      file,
      '#!/bin/sh\nprintf "%s\\n" "$0" >> "$KUNGFU_READONLY_TOOL_LOG"\nexit 99\n',
    );
    fs.chmodSync(file, 0o755);
  }

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Kungfu Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@kungfu.invalid',
    GIT_COMMITTER_NAME: 'Kungfu Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@kungfu.invalid',
  };
  for (const args of [
    ['config', 'core.fileMode', 'false'],
    ['add', '.'],
    ['commit', '--allow-empty', '--quiet', '-m', 'readonly fixture'],
  ]) {
    const result = spawnSync(git, args, {
      cwd: fixture,
      encoding: 'utf8',
      env: gitEnv,
    });
    assert.equal(result.status, 0, result.stderr);
  }

  const before = snapshotSource(fixture);
  makeReadOnly(fixture);
  const env = {
    ...process.env,
    HOME: home,
    XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    KUNGFU_READONLY_TOOL_LOG: toolLog,
    PATH: `${tools}:/usr/bin:/bin`,
  };
  const cases = [
    [
      'architecture',
      [
        'core:architecture',
        '--path',
        'framework/core/src/libkungfu/src/runtime/storage/service.cpp',
        '--json',
      ],
      'kungfu.core-architecture-query/v1',
    ],
    [
      'architecture-health',
      ['core:architecture:health', '--json'],
      'kungfu.core-architecture-health/v1',
    ],
    [
      'invariant-discovery',
      ['invariant:verify', '--', '--list', '--json'],
      'kungfu.invariant-discovery/v1',
    ],
    [
      'complexity-budget',
      ['maintainability:complexity', '--json'],
      'kungfu.code-complexity-budget-report/v1',
    ],
    [
      'semantic-amplification',
      ['maintainability:amplification', '--json'],
      'kungfu.semantic-amplification-report/v1',
    ],
    [
      'task-graph',
      ['maintainability:query', 'storage-query', '--json'],
      'kungfu.maintainability-task-graph/v1',
    ],
  ];
  for (const [name, args, schema] of cases) {
    const result = spawnSync(path.join(fixture, 'shifu'), args, {
      cwd: fixture,
      encoding: 'utf8',
      env,
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(
      result.status,
      0,
      `${name}: ${result.stderr || result.stdout}`,
    );
    assert.equal(JSON.parse(result.stdout).schema, schema);
  }
  assert.deepEqual(snapshotSource(fixture), before);
  assert.equal(fs.existsSync(toolLog), false, 'bootstrap tool was invoked');
  assert.equal(
    spawnSync(git, ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: fixture,
      encoding: 'utf8',
      env,
    }).stdout,
    '',
  );
});
