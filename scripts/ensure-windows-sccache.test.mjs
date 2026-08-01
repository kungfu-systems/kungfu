// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  WINDOWS_SCCACHE_DIR,
  WINDOWS_SCCACHE_TOOL_CONTRACT,
  ensureWindowsSccache,
} from '../.github/actions/require-alpha-preflight/windows-alpha-sccache.mjs';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('Windows sccache installer verifies pinned bytes and exports auditable bindings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-sccache-'));
  const home = path.join(root, 'home');
  const githubPath = path.join(root, 'github-path');
  const githubEnv = path.join(root, 'github-env');
  const archive = Buffer.from('pinned archive fixture');
  const executable = Buffer.from('pinned executable fixture');
  try {
    const receipt = await ensureWindowsSccache({
      cwd: root,
      homedir: home,
      platform: 'win32',
      arch: 'x64',
      env: {
        BUILDCHAIN_COMPILER_CACHE_PROVIDER: 'sccache',
        BUILDCHAIN_PLATFORM_ID: 'windows-x64',
        BUILDCHAIN_SOURCE_SHA: 'a'.repeat(40),
        RUNNER_OS: 'Windows',
        RUNNER_ARCH: 'X64',
        GITHUB_PATH: githubPath,
        GITHUB_ENV: githubEnv,
      },
      expectedArchiveSha256: sha256(archive),
      expectedExecutableSha256: sha256(executable),
      async downloadArchive(_url, outputPath) {
        fs.writeFileSync(outputPath, archive);
      },
      extractArchive(_archivePath, destinationPath) {
        const nested = path.join(destinationPath, 'sccache-fixture');
        fs.mkdirSync(nested, { recursive: true });
        fs.writeFileSync(path.join(nested, 'sccache.exe'), executable);
      },
      runCommand(command, args) {
        assert.match(command, /sccache\.exe$/u);
        assert.deepEqual(args, ['--version']);
        return {
          status: 0,
          signal: null,
          stdout: 'sccache 0.16.0\n',
          stderr: '',
        };
      },
      now: () => new Date('2026-07-31T00:00:00.000Z'),
    });
    assert.equal(receipt.contract, WINDOWS_SCCACHE_TOOL_CONTRACT);
    assert.equal(receipt.status, 'ready');
    assert.equal(receipt.reused, false);
    assert.equal(receipt.bindings.sourceCommit, 'a'.repeat(40));
    assert.equal(receipt.bindings.cacheDirectory, WINDOWS_SCCACHE_DIR);
    assert.equal(
      receipt.bindings.cacheDirectoryResolution,
      'repository-workspace',
    );
    assert.match(receipt.root, /^sha256:[0-9a-f]{64}$/u);
    assert.match(receipt.toolRoot, /^sha256:[0-9a-f]{64}$/u);
    const exported = fs.readFileSync(githubEnv, 'utf8');
    const exportedEnvironment = Object.fromEntries(
      exported
        .trim()
        .split('\n')
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    const resolvedCacheDirectory = path.resolve(root, WINDOWS_SCCACHE_DIR);
    assert.equal(
      exportedEnvironment.KUNGFU_WINDOWS_ALPHA_SCCACHE_DIR,
      resolvedCacheDirectory,
    );
    assert.equal(exportedEnvironment.SCCACHE_DIR, resolvedCacheDirectory);
    assert.match(
      exported,
      new RegExp(`BUILDCHAIN_COMPILER_CACHE_TOOL_ROOT=${receipt.root}`, 'u'),
    );
    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(root, '.buildchain/diagnostics/sccache-tool.json'),
        'utf8',
      ),
    );
    assert.deepEqual(persisted, receipt);

    const reused = await ensureWindowsSccache({
      cwd: root,
      homedir: home,
      platform: 'win32',
      arch: 'x64',
      env: {
        BUILDCHAIN_COMPILER_CACHE_PROVIDER: 'sccache',
        GITHUB_PATH: githubPath,
        GITHUB_ENV: githubEnv,
      },
      expectedArchiveSha256: sha256(archive),
      expectedExecutableSha256: sha256(executable),
      async downloadArchive() {
        throw new Error('cached tool must not download again');
      },
      runCommand() {
        return {
          status: 0,
          signal: null,
          stdout: 'sccache 0.16.0\n',
          stderr: '',
        };
      },
    });
    assert.equal(reused.reused, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sccache installer is inert off Windows and in explicit off mode', async () => {
  assert.deepEqual(
    await ensureWindowsSccache({
      platform: 'linux',
      env: { BUILDCHAIN_COMPILER_CACHE_PROVIDER: 'sccache' },
    }),
    { status: 'not-applicable', provider: 'sccache' },
  );
  assert.deepEqual(
    await ensureWindowsSccache({
      platform: 'win32',
      env: { BUILDCHAIN_COMPILER_CACHE_PROVIDER: 'none' },
    }),
    { status: 'not-applicable', provider: 'none' },
  );
});
