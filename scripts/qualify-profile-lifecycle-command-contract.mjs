#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// shifu-entry-contract: qualify the built wheel through ./shifu only.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const wheelDir = path.join(
  root,
  'framework',
  'core',
  'build',
  'python',
  'dist',
);
const qualificationRoot = path.join(
  root,
  'framework',
  'core',
  'build',
  'qualification',
  'profile-lifecycle-command-contract',
);

function fail(message) {
  console.error(`[profile-command-contract] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    ...options,
  });
  if (result.error || result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    fail(
      result.error
        ? `${command} failed: ${result.error.message}`
        : `${command} exited ${result.status}`,
    );
  }
  return result.stdout;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function semanticRoot(value) {
  return `sha256:${crypto.createHash('sha256').update(canonical(value)).digest('hex')}`;
}

if (!fs.existsSync(wheelDir))
  fail('built wheel directory is unavailable; run ./shifu build:core');
const wheels = fs
  .readdirSync(wheelDir)
  .filter((name) => /^kungfu-.*\.whl$/u.test(name))
  .sort();
if (wheels.length !== 1)
  fail(`expected one built Kungfu wheel, found ${wheels.length}`);

fs.mkdirSync(qualificationRoot, { recursive: true });
const environment = fs.mkdtempSync(path.join(qualificationRoot, 'installed-'));
const python = path.join(
  environment,
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python',
);
const binary = path.join(
  environment,
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'kungfu.cmd' : 'kungfu',
);
const wheel = path.join(wheelDir, wheels[0]);
run('uv', ['venv', environment, '--python', '3.13']);
run('uv', ['pip', 'install', '--python', python, wheel]);
if (process.platform === 'win32') {
  fs.writeFileSync(binary, `@echo off\r\n"${python}" -m kungfu %*\r\n`, 'utf8');
} else {
  fs.writeFileSync(
    binary,
    `#!/bin/sh\nexec ${JSON.stringify(python)} -m kungfu "$@"\n`,
    { encoding: 'utf8', mode: 0o755 },
  );
}

const home = path.join(environment, 'home');
const capabilities = JSON.parse(
  run(binary, ['--home', home, 'profile', 'capabilities', '--json']),
);
const manager = JSON.parse(
  run(binary, ['--home', home, 'profile', 'manager', '--json']),
);
const contract = capabilities.lifecycleCommandContract;
if (contract?.schema !== 'kungfu.profile-lifecycle-command-contract/v1')
  fail('installed capabilities omit the lifecycle command contract');
if (canonical(manager.lifecycleCommandContract) !== canonical(contract))
  fail(
    'installed capabilities and manager project different command contracts',
  );
const { contractRoot: recordedRoot, ...body } = contract;
if (recordedRoot !== semanticRoot(body))
  fail('installed command contract root mismatch');

const commands = new Map(contract.commands.map((row) => [row.id, row]));
for (const id of [
  'profile.capabilities',
  'profile.inspect',
  'profile.list',
  'profile.manager',
  'profile.plan.upgrade',
]) {
  if (commands.get(id)?.mutation !== false)
    fail(`reader/plan command is not mutation-free: ${id}`);
}
for (const id of ['profile.apply', 'profile.authorize-upgrade']) {
  if (commands.get(id)?.mutation !== true)
    fail(`mutating command is not fenced: ${id}`);
}

console.log(
  JSON.stringify(
    {
      schema: 'kungfu.profile-lifecycle-command-contract-qualification/v1',
      status: 'qualified',
      wheel,
      binary,
      contractRoot: recordedRoot,
      commandCount: contract.commands.length,
      readerPlanCount: contract.commands.filter((row) => row.mutation === false)
        .length,
      mutationCount: contract.commands.filter((row) => row.mutation === true)
        .length,
      home,
    },
    null,
    2,
  ),
);
