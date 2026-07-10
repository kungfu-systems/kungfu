// SPDX-License-Identifier: Apache-2.0
//
// Shared harness for the capability-slice run.mjs drivers (replacing run.sh),
// so `./shifu verify --full` runs the slice proofs on every platform pnpm
// runs on — no bash. Pure Node: child_process, fs, os, crypto. The slices drive
// native binaries built under the core build dir; this collapses binary
// discovery, the dynamic-dependency cut-proof, and checksums into one place.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isWin = process.platform === 'win32';

/** Resolve a slice's own dir, framework/core, and the build dir (argv[2]|default). */
export function locate(importMetaUrl) {
  const sliceDir = path.dirname(fileURLToPath(importMetaUrl));
  const coreDir = path.resolve(sliceDir, '..', '..');
  const buildDir = process.argv[2] || path.join(coreDir, 'build');
  return { sliceDir, coreDir, buildDir };
}

/** Executables land in build/Release, or a per-subdir/flat fallback. */
export function findBin(buildDir, name, subdir) {
  const bases = [
    path.join(buildDir, 'Release', name),
    subdir ? path.join(buildDir, subdir, 'Release', name) : null,
    subdir ? path.join(buildDir, subdir, name) : null,
    path.join(buildDir, name),
  ].filter(Boolean);
  for (const b of bases) {
    const p = isWin && !b.endsWith('.exe') ? `${b}.exe` : b;
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

export function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

export function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  onCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const cleanups = [];
let armed = false;
export function onCleanup(fn) {
  cleanups.push(fn);
  if (!armed) {
    armed = true;
    process.on('exit', () => {
      while (cleanups.length) {
        try {
          cleanups.pop()();
        } catch {
          /* best-effort */
        }
      }
    });
  }
}

/** Run a command; throw (fail) on non-zero unless allowFail. Returns result. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
    stdio: opts.inherit ? 'inherit' : 'pipe',
  });
  if (r.error) fail(`${cmd} spawn error: ${r.error.message}`);
  if (!opts.allowFail && r.status !== 0) {
    if (!opts.inherit) {
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
    }
    fail(`${cmd} ${args.join(' ')} exited ${r.status}`);
  }
  return r;
}

export function sha256(file) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
}

/** Read a nested field from a JSON file (replaces `python -c json.load[...]`). */
export function jsonField(file, ...keys) {
  let v = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of keys) v = v?.[k];
  return v;
}

export function assertContains(text, pattern, label) {
  const ok =
    pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern);
  if (!ok) fail(`${label || 'output'} missing ${pattern}`);
}

export function assertNotContains(text, pattern, label) {
  const hit =
    pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern);
  if (hit) fail(`${label || 'output'} should not contain ${pattern}`);
}

/**
 * The cut-proof: a slice tool must link only the yijinjing static core, so its
 * dynamic deps are exactly the system C/C++ runtime. Per-platform tool
 * (otool/ldd/dumpbin); skips cleanly where none is available.
 */
export function assertNoExtraDylibs(bin) {
  let deps = '';
  if (has('otool')) {
    const out = run('otool', ['-L', bin]).stdout;
    deps = out
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean)
      .filter((d) => !/^\/usr\/lib\/(libc\+\+|libSystem|libobjc)/.test(d))
      .join('\n');
  } else if (has('ldd')) {
    const out = run('ldd', [bin], { allowFail: true }).stdout;
    deps = out
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean)
      .filter(
        (d) =>
          !/^(linux-vdso|libc\.|libm\.|libgcc_s|libstdc\+\+|libpthread|libdl\.|librt\.|\/lib)/.test(
            d,
          ),
      )
      .join('\n');
  } else if (has('dumpbin')) {
    const out = run('dumpbin', ['/DEPENDENTS', bin], {
      allowFail: true,
    }).stdout;
    deps = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /\.dll$/i.test(l))
      .filter(
        (d) => !/^(KERNEL32|VCRUNTIME|api-ms-|ucrtbase|MSVCP|ntdll)/i.test(d),
      )
      .join('\n');
  } else {
    console.log('  (skip: no otool/ldd/dumpbin on this platform)');
    return;
  }
  if (deps) fail(`unexpected dynamic dependencies in ${bin}:\n${deps}`);
  console.log(`  ${path.basename(bin)}: system runtime only`);
}

function has(tool) {
  const extensions = isWin
    ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')]
    : [''];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const base = directory.replace(/^"|"$/g, '');
    for (const extension of extensions) {
      try {
        fs.accessSync(
          path.join(base, `${tool}${extension}`),
          fs.constants.X_OK,
        );
        return true;
      } catch {
        /* next candidate */
      }
    }
  }
  return false;
}
