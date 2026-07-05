// SPDX-License-Identifier: Apache-2.0
//
// Shared harness for the tests/fixtures/*/run.mjs drivers. These replace the
// former run.sh scripts so the verification gate runs on every platform pnpm
// runs on (Windows included) — no bash dependency. Pure Node: child_process,
// fs, os, crypto. Cross-platform differences (the runtime library path, the
// python launcher) are collapsed here so each fixture stays a plain recipe.

import { spawnSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isWin = process.platform === 'win32';

/** Resolve a fixture's own dir and the framework/core dir from its module url. */
export function locate(importMetaUrl) {
  const fixtureDir = path.dirname(fileURLToPath(importMetaUrl));
  const coreDir = path.resolve(fixtureDir, '..', '..', '..', 'framework', 'core');
  return { fixtureDir, coreDir };
}

/**
 * The env additions a dev-python import of pykungfu needs so dyld/ld/Windows
 * can find the runtime libs (libnode/libkungfu) shipped under dist/kungfu —
 * the frozen kfc resolves them @executable_path-relative, but uv's python does
 * not. Collapsed per platform (the only OS-specific knob in a fixture).
 */
export function runtimeEnv(coreDir) {
  const dist = path.join(coreDir, 'dist', 'kungfu');
  if (process.platform === 'darwin') {
    return prependPath('DYLD_FALLBACK_LIBRARY_PATH', dist);
  }
  if (process.platform === 'linux') {
    return prependPath('LD_LIBRARY_PATH', dist);
  }
  // Windows resolves dependent DLLs via PATH.
  return prependPath('PATH', dist);
}

function prependPath(key, value) {
  const cur = process.env[key];
  return { [key]: cur ? `${value}${path.delimiter}${cur}` : value };
}

/** Make a temp dir; return its path and register cleanup on process exit. */
export function tmpDir(prefix = 'kf-fixture-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  onCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const cleanups = [];
let cleanupArmed = false;
export function onCleanup(fn) {
  cleanups.push(fn);
  if (!cleanupArmed) {
    cleanupArmed = true;
    const run = () => {
      while (cleanups.length) {
        try {
          cleanups.pop()();
        } catch {
          /* best-effort */
        }
      }
    };
    process.on('exit', run);
    process.on('SIGINT', () => {
      run();
      process.exit(130);
    });
    process.on('SIGTERM', () => {
      run();
      process.exit(143);
    });
  }
}

/** Fail the fixture with a message (mirrors `echo ... >&2; exit 1`). */
export function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

/** Skip the fixture cleanly (exit 0) — for platform-specific capabilities. */
export function skip(reason) {
  console.log(`SKIP: ${reason}`);
  process.exit(0);
}

/** Run a command, inheriting nothing; throw (fail) on non-zero unless allowFail. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
    shell: false,
  });
  if (r.error) fail(`${cmd} spawn error: ${r.error.message}`);
  if (!opts.allowFail && r.status !== 0) {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    fail(`${cmd} ${args.join(' ')} exited ${r.status}`);
  }
  return r;
}

/** uv run --frozen python <args>, from coreDir (the dev python launcher). */
export function uvPython(coreDir, args, opts = {}) {
  return run('uv', ['run', '--frozen', 'python', ...args], {
    cwd: coreDir,
    env: { ...runtimeEnv(coreDir), ...(opts.env || {}) },
    allowFail: opts.allowFail,
  });
}

/**
 * The dev-console kfc: `uv run --frozen python .devtools/kungfu_cli.py -H <home> <args>`.
 * Returns the spawnSync result; `.stdout` carries any --json payload.
 */
export function kfc(coreDir, home, args, opts = {}) {
  return uvPython(
    coreDir,
    ['.devtools/kungfu_cli.py', '-H', home, ...args],
    opts,
  );
}

/** Parse the single JSON object a `--json` command prints to stdout. */
export function json(result) {
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    fail(`expected JSON on stdout, got: ${result.stdout?.slice(0, 200)}`);
  }
}

/** sha256 of a file, pure Node (replaces sha256sum/shasum). */
export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Spawn a detached background process (e.g. a mock upstream), register it for
 * kill on cleanup, and return its handle. Does not hold a captured pipe open.
 */
export function background(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
    stdio: 'ignore',
    detached: false,
  });
  onCleanup(() => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  });
  return child;
}

/** Poll until a file exists and is non-empty (replaces `while [ ! -s f ]`). */
export function waitForFile(file, { timeoutMs = 10000, intervalMs = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (fs.statSync(file).size > 0) return fs.readFileSync(file, 'utf8').trim();
    } catch {
      /* not yet */
    }
    // busy-wait with a short sleep via Atomics (no async in these recipes)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
  }
  fail(`timed out waiting for ${file}`);
}

/**
 * Assert a spawnSync result's output contains a substring/regex (replaces
 * `... | grep -q pattern`). Checks stdout+stderr combined.
 */
export function assertContains(result, pattern, label) {
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  const ok =
    pattern instanceof RegExp ? pattern.test(out) : out.includes(pattern);
  if (!ok) fail(`${label || 'output'} missing ${pattern}; got: ${out.slice(0, 300)}`);
}

/** Assert a file's contents match a substring/regex (replaces `grep pattern file`). */
export function assertFileContains(file, pattern, label) {
  const out = fs.readFileSync(file, 'utf8');
  const ok =
    pattern instanceof RegExp ? pattern.test(out) : out.includes(pattern);
  if (!ok) fail(`${label || file} missing ${pattern}`);
}

/** Find an executable among candidate paths (replaces slice find_bin). */
export function findBin(candidates) {
  for (const c of candidates) {
    const p = isWin && !c.endsWith('.exe') ? `${c}.exe` : c;
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}
