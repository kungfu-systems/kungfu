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
import {
  qualificationAuthority,
  qualificationHostDescriptor,
  removalAuthority,
} from './_kfx-authority.mjs';

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

/** Resolve the interpreter selected by the Core uv project under Shifu. */
export function corePython(coreDir) {
  const result = uvPython(coreDir, [
    '-c',
    'import sys; print(sys.executable)',
  ]);
  const executable = result.stdout.trim();
  if (!path.isAbsolute(executable) || !fs.existsSync(executable)) {
    fail(`core Python resolution returned an invalid path: ${executable}`);
  }
  return executable;
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

function writeFixtureJson(prefix, value) {
  const file = path.join(tmpDir(prefix), 'authority.json');
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

/** Build exact-root admission evidence for one source package fixture. */
export function kfxQualificationAuthorityFile(
  coreDir,
  home,
  sourceRoot,
  packageKey,
) {
  const inspected = json(
    kfc(coreDir, home, [
      'kfx',
      'native',
      'inspect',
      packageKey,
      '--root',
      `workspace=${sourceRoot}`,
    ]),
  );
  const repoDir = path.resolve(coreDir, '..', '..');
  return writeFixtureJson(
    'kfx-qualification-authority-',
    qualificationAuthority(
      repoDir,
      inspected.package.packageRoot,
      inspected.package.declaredCapabilities,
    ),
  );
}

/** Build a qualification-only host descriptor bound to one exact package closure. */
export function kfxQualificationHostDescriptorFile(
  coreDir,
  home,
  sourceRoot,
  packageKey,
  runtime,
) {
  const inspected = json(
    kfc(coreDir, home, [
      'kfx',
      'native',
      'inspect',
      packageKey,
      '--root',
      `workspace=${sourceRoot}`,
    ]),
  );
  return writeFixtureJson(
    'kfx-qualification-host-',
    qualificationHostDescriptor(
      packageKey,
      inspected.package.packageRoot,
      runtime,
    ),
  );
}

/**
 * Recreate the package directory seen by `kungfu kfx install <tgz>` so the
 * qualification authority binds the exact npm transport closure, not the
 * larger source checkout that produced it.
 */
export function extractPackedKfx(coreDir, tgz) {
  const root = tmpDir('kfx-packed-root-');
  const packageRoot = path.join(root, 'package');
  fs.mkdirSync(packageRoot);
  uvPython(coreDir, [
    '-c',
    [
      'import pathlib, sys, tarfile',
      'source, destination = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])',
      'with tarfile.open(source, "r:gz") as archive:',
      '    members = [member for member in archive.getmembers() if member.name.startswith("package/")]',
      '    for member in members: member.name = member.name[len("package/"):]',
      '    archive.extractall(destination, members=[member for member in members if member.name], filter="data")',
    ].join('\n'),
    tgz,
    packageRoot,
  ]);
  return packageRoot;
}

/** Build a current owner recovery Warrant for one installed fixture package. */
export function kfxRemovalAuthorityFile(coreDir, home, packageKey) {
  const installedRoot = path.join(home, 'extensions');
  const rootArg = `user=${installedRoot}`;
  const inspected = json(
    kfc(coreDir, home, [
      'kfx',
      'native',
      'inspect',
      packageKey,
      '--root',
      rootArg,
    ]),
  );
  const status = json(
    kfc(coreDir, home, ['kfx', 'native', 'status', '--root', rootArg]),
  );
  return writeFixtureJson(
    'kfx-removal-authority-',
    removalAuthority(
      inspected.package.packageRoot,
      status,
      `${packageKey}-fixture-removal`,
    ),
  );
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
  child.unref();
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
    const extensions =
      isWin && !path.extname(c)
        ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
        : [''];
    const roots =
      path.isAbsolute(c) || c.includes(path.sep)
        ? ['']
        : (process.env.PATH || '').split(path.delimiter);
    for (const root of roots) {
      for (const extension of extensions) {
        const candidate = root
          ? path.join(root, `${c}${extension}`)
          : `${c}${extension}`;
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        } catch {
          /* next */
        }
      }
    }
  }
  return null;
}
