#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  exposeGateMeasurementPython,
  exposeGateMeasurementRunnerTemp,
  gateMeasurementToolPath,
  gateMeasurementUvCommand,
} from './gate-measurement-environment.mjs';
import { prepareGateMeasurementHistory } from './prepare-gate-measurement-history.mjs';
import { cacheAppliedCommandArgs, runShifu } from './run-shifu-lifecycle.mjs';

const node = process.execPath;
const root = fileURLToPath(new URL('..', import.meta.url));
const shifuLauncher = path.join(
  root,
  process.platform === 'win32' ? 'shifu.cmd' : 'shifu',
);
const lifecycle = fileURLToPath(
  new URL('./run-shifu-lifecycle.mjs', import.meta.url),
);
const measurementScript = fileURLToPath(import.meta.url);

function exposeUserToolchain() {
  const pathKey =
    Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ||
    'PATH';
  const current = process.env[pathKey] || '';
  const candidates = [
    path.join(os.homedir(), '.cargo', 'bin'),
    path.join(os.homedir(), '.local', 'bin'),
  ].filter((directory) => fs.existsSync(directory));
  process.env[pathKey] = gateMeasurementToolPath(current, candidates, {
    managedUv: process.env.SHIFU_CACHE_MANAGED_UV === '1',
  });
}

function spawn(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: options.stdio ?? 'inherit',
    encoding: options.encoding,
  });
  if (result.error) throw result.error;
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return result;
  }
  process.exitCode = result.status ?? 1;
  return result;
}

function runNativeGate(args) {
  if (process.platform === 'win32') {
    const pinned = process.env.SHIFU_BIN;
    if (!pinned)
      throw new Error(
        'focused Windows Gate requires the cache-pinned native Shifu binary',
      );
    return spawn(pinned, args).status ?? 1;
  }
  process.exitCode = runShifu(args, {
    root,
    env: process.env,
  });
  return process.exitCode;
}

function runPreparation(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    shell: options.shell ?? false,
  });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  process.exitCode = result.status ?? 1;
}

function assertCleanSource() {
  const result = spawnSync(
    'git',
    ['status', '--porcelain', '--untracked-files=normal'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `cannot verify measurement source: ${result.stderr.trim()}`,
    );
  }
  if (result.stdout.trim()) {
    throw new Error(
      `measurement preparation dirtied the locked source:\n${result.stdout.trim()}`,
    );
  }
}

function prepareWorkspace() {
  runPreparation(shifuLauncher, ['install', '--frozen-lockfile'], {
    shell: process.platform === 'win32',
  });
  if (process.exitCode) return;
  const uv = gateMeasurementUvCommand();
  runPreparation(
    uv.command,
    ['sync', '--project', 'framework/core', '--frozen'],
    { shell: uv.shell },
  );
  if (process.exitCode) return;
  exposeGateMeasurementPython(path.join(root, 'framework', 'core'));
  runPreparation(
    shifuLauncher,
    ['--filter', '@kungfu-tech/core', 'run', 'configure'],
    { shell: process.platform === 'win32' },
  );
  if (process.exitCode) return;
  runPreparation(node, [lifecycle, 'direct', 'check:gate-catalog']);
  if (process.exitCode) return;
  assertCleanSource();
}

function prepareHistory() {
  prepareGateMeasurementHistory(process.cwd(), { baseRef: 'dev/v4/v4.0' });
}

// Dependency installation, catalog bootstrap, and managed Python materialization
// are runner preparation, not Gate observations. Keeping them outside the
// profile run prevents a cold checkout from consuming a Gate's own timeout or
// duration measurement.
exposeGateMeasurementRunnerTemp();
exposeUserToolchain();
if (process.env.SHIFU_CACHE_ACTIVE !== '1') {
  prepareHistory();
  process.exitCode = runShifu(
    cacheAppliedCommandArgs(node, [
      measurementScript,
      ...process.argv.slice(2),
    ]),
  );
} else {
  prepareWorkspace();
  if (process.exitCode) process.exit(process.exitCode);
  runNativeGate(process.argv.slice(2));
}
