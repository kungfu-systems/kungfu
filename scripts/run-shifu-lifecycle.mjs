#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  const quote = (value) => {
    const text = String(value);
    if (/^[A-Za-z0-9_./:@=+\\-]+$/.test(text)) return text;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const command = /^[A-Za-z0-9_.-]+$/.test(String(shim))
    ? String(shim)
    : quote(shim);
  return [command, ...args.map(quote)].join(' ');
}

export function windowsCmdArgs(shim, args) {
  if ([shim, ...args].some((value) => /[\r\n%!&|<>^]/.test(String(value))))
    throw new Error(
      'Windows Shifu lifecycle arguments contain unsafe cmd syntax',
    );
  const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  // cmd.exe owns everything after /c as one command string. Keep that payload
  // as one spawn argument and let its token quotes reach cmd.exe verbatim.
  // Node's default Windows escaping turns those quotes into literal \" bytes;
  // an outer quote pair drops tasks, while discrete post-/c argv exits 255.
  const payload = `call ${[shim, ...args].map(quote).join(' ')}`;
  return ['/d', '/s', '/c', payload];
}

/** Run the canonical repository shim without assuming bash exists on Windows. */
export function runShifu(args, options = {}) {
  const platform = options.platform || process.platform;
  const root = options.root || ROOT;
  const env = options.env || lifecycleEnvironment();
  let result;
  if (platform === 'win32') {
    const pinnedBinary = env.SHIFU_BIN;
    if (pinnedBinary && existsSync(pinnedBinary)) {
      result = spawnSync(pinnedBinary, args, {
        cwd: root,
        env: {
          ...env,
          SHIFU_ENTRYPOINT: '1',
          SHIFU_FROM_SHIM: '1',
        },
        stdio: options.stdio || 'inherit',
        shell: false,
        windowsHide: true,
      });
      if (result.error) throw result.error;
      return result.status ?? 1;
    }
    const command = options.comspec || env.ComSpec || env.COMSPEC || 'cmd.exe';
    // Match the native launcher's proven cmd.exe raw-argument protocol. The
    // complete /s /c payload needs one outer quote pair in addition to the
    // quotes around each token.
    result = spawnSync(
      command,
      windowsCmdArgs(path.join(root, 'shifu.cmd'), args),
      {
        cwd: root,
        env,
        stdio: options.stdio || 'inherit',
        shell: false,
        windowsVerbatimArguments: true,
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

/** Run the canonical repository shim asynchronously for bounded parallel gates. */
export function runShifuAsync(args, options = {}) {
  const platform = options.platform || process.platform;
  const root = options.root || ROOT;
  const env = options.env || lifecycleEnvironment();
  return new Promise((resolve, reject) => {
    let child;
    if (platform === 'win32') {
      const pinnedBinary = env.SHIFU_BIN;
      if (pinnedBinary && existsSync(pinnedBinary)) {
        child = spawn(pinnedBinary, args, {
          cwd: root,
          env: {
            ...env,
            SHIFU_ENTRYPOINT: '1',
            SHIFU_FROM_SHIM: '1',
          },
          stdio: options.stdio || 'inherit',
          shell: false,
          windowsHide: true,
        });
      } else {
        const command =
          options.comspec || env.ComSpec || env.COMSPEC || 'cmd.exe';
        child = spawn(
          command,
          windowsCmdArgs(path.join(root, 'shifu.cmd'), args),
          {
            cwd: root,
            env,
            stdio: options.stdio || 'inherit',
            shell: false,
            windowsVerbatimArguments: true,
            windowsHide: true,
          },
        );
      }
    } else {
      child = spawn(path.join(root, 'shifu'), args, {
        cwd: root,
        env,
        stdio: options.stdio || 'inherit',
      });
    }
    child.once('error', reject);
    child.once('close', (status, signal) => {
      if (signal) {
        const error = new Error(`Shifu exited on signal ${signal}`);
        error.signal = signal;
        reject(error);
        return;
      }
      resolve(status ?? 1);
    });
  });
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

export function runShifuWithCacheAsync(args, options = {}) {
  return runShifuAsync(cacheAwareArgs(args, options), options);
}

export function buildchainBuildPlan(
  platform = process.platform,
  arch = process.arch,
  root = ROOT,
) {
  if (platform !== 'linux' || arch !== 'arm64') {
    return [{ args: ['dist'], env: {} }];
  }
  return [
    // The Buildchain install stage intentionally omits optional dependencies
    // so full-product lanes cannot consume prebuilt Kungfu artifacts. The
    // bounded native ARM64 Core and CLI lane still needs libnode's exact host
    // package to link from source, so restore platform optionals under the
    // frozen lock before entering the Core lifecycle.
    { args: ['install', '--frozen-lockfile'], env: {} },
    { args: ['rebuild:core'], env: {} },
    { args: ['freeze'], env: { KF_REQUIRE_NATIVE_HOST: '1' } },
    {
      args: ['pack:core-platform'],
      env: {
        KF_PACKAGE_STAGE_DIR: path.join(root, 'product', 'release', 'npm'),
      },
    },
    { args: ['dist:cli'], env: {} },
  ];
}

function main() {
  if (process.argv.length < 3) {
    console.error(
      'usage: node scripts/run-shifu-lifecycle.mjs <task> [args...]',
    );
    process.exit(2);
  }
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'buildchain-build') {
    for (const stage of buildchainBuildPlan()) {
      const task = stage.args[0];
      const status = runShifuWithCache(stage.args, {
        env: lifecycleEnvironment({ ...process.env, ...stage.env }, task),
      });
      if (status !== 0) {
        process.exitCode = status;
        return;
      }
    }
    return;
  }
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
  if (mode === 'cache-apply-command') {
    if (args.length === 0) {
      console.error('cache-apply-command requires a child command');
      process.exit(2);
    }
    const [command, ...commandArgs] = args;
    process.exitCode = runShifu(cacheAppliedCommandArgs(command, commandArgs), {
      env: lifecycleEnvironment(process.env),
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
