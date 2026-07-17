#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = fileURLToPath(import.meta.url);
const UPGRADE_EVIDENCE =
  'buildchain-retained:product/release/qualification/kungfu-upgrade-qualification-evidence.json';
const DIST_ENVIRONMENT = {
  KF_UPGRADE_QUALIFICATION_REF: UPGRADE_EVIDENCE,
  KF_RUNTIME_ARTIFACT_SIGNATURE: `${UPGRADE_EVIDENCE}#runtime`,
  KF_DESKTOP_ARTIFACT_SIGNATURE: `${UPGRADE_EVIDENCE}#desktop`,
  KF_CLI_ARTIFACT_SIGNATURE: `${UPGRADE_EVIDENCE}#cli`,
};

export function lifecycleEnvironment(env = process.env, task = '') {
  const result = { ...env };
  if (task === 'dist') {
    for (const [name, value] of Object.entries(DIST_ENVIRONMENT)) {
      if (!result[name]) result[name] = value;
    }
  }
  return result;
}

export function cmdCommand(shim, args) {
  if ([shim, ...args].some((value) => /[\r\n%!]/.test(String(value))))
    throw new Error(
      'Windows Shifu lifecycle arguments contain unsafe cmd syntax',
    );
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const command = /^[A-Za-z0-9_.-]+$/.test(String(shim))
    ? String(shim)
    : quote(shim);
  return [command, ...args.map(quote)].join(' ');
}

/** Run the canonical repository shim without assuming bash exists on Windows. */
export function runShifu(args, options = {}) {
  const platform = options.platform || process.platform;
  const root = options.root || ROOT;
  const env = options.env || lifecycleEnvironment();
  let result;
  if (platform === 'win32') {
    const command = options.comspec || env.ComSpec || env.COMSPEC || 'cmd.exe';
    // Match the proven cache-runtime invocation: with `cmd /s /c`, quoting an
    // absolute command name can make cmd preserve the quotes as part of the
    // executable token.  The welded shim is in cwd, so invoke its safe bare
    // name and quote only its arguments.
    result = spawnSync(
      command,
      ['/d', '/s', '/c', cmdCommand('shifu.cmd', args)],
      {
        cwd: root,
        env,
        stdio: options.stdio || 'inherit',
        shell: false,
      },
    );
  } else {
    result = spawnSync(path.join(root, 'shifu'), args, {
      cwd: root,
      env,
      stdio: options.stdio || 'inherit',
    });
  }
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** Build the canonical cache wrapper without relying on a platform shell. */
export function cacheAppliedArgs(args, options = {}) {
  return [
    'cache',
    'apply',
    '--',
    options.node || process.execPath,
    options.script || SCRIPT,
    'direct',
    ...args,
  ];
}

export function cacheAppliedCommandArgs(command, args = []) {
  return ['cache', 'apply', '--', command, ...args];
}

export function cacheAwareArgs(args, options = {}) {
  const env = options.env || process.env;
  return env.SHIFU_CACHE_ACTIVE === '1'
    ? args
    : cacheAppliedArgs(args, options);
}

/** Apply the resolved Shifu cache profile, then re-enter the canonical shim. */
export function runShifuWithCache(args, options = {}) {
  return runShifu(cacheAwareArgs(args, options), options);
}

function main() {
  if (process.argv.length < 3) {
    console.error(
      'usage: node scripts/run-shifu-lifecycle.mjs <task> [args...]',
    );
    process.exit(2);
  }
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'cache-apply') {
    if (args.length === 0) {
      console.error('cache-apply requires a Shifu task');
      process.exit(2);
    }
    process.exitCode = runShifuWithCache(args, {
      env: lifecycleEnvironment(process.env, args[0]),
    });
    return;
  }
  if (mode === 'direct') {
    if (args.length === 0) {
      console.error('direct requires a Shifu task');
      process.exit(2);
    }
    process.exitCode = runShifu(args);
    return;
  }
  process.exitCode = runShifu([mode, ...args], {
    env: lifecycleEnvironment(process.env, mode),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
