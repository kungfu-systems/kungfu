#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// kungfu pre-commit logic — all in Node so it runs identically on macOS, Linux
// and Windows. The .githooks/pre-commit shim is a tiny POSIX sh file that only
// execs this (git needs a launchable hook and sh is the one interpreter it ships
// everywhere, incl. Git-for-Windows bundled bash); no checks live in the shim.
//
// On the staged (Added/Copied/Modified) set it, in order:
//   1. blocks a reintroduced *.sh (shares the scan with scripts/verify.mjs 0a);
//   2. auto-formats C++ (clang-format), Python (ruff) and re-stages;
//   3. runs `biome check --write` on staged JS/TS: applies safe format + lint +
//      import fixes, then BLOCKS on any remaining (unfixable) lint error.
//
// A missing formatter warns and skips — a setup gap must not block a commit; run
// `./kungfu-code sync` to install the toolchain. A real .sh or an unfixable lint
// error blocks. Bypass everything with `git commit -n`.
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { scanStaged } from './no-bash-guard.mjs';

const isWin = process.platform === 'win32';

function git(args, opts = {}) {
  return spawnSync('git', args, { encoding: 'utf8', ...opts });
}

const ROOT = git(['rev-parse', '--show-toplevel']).stdout?.trim();
if (!ROOT) process.exit(0);

function warn(msg) {
  process.stderr.write(`[kungfu pre-commit] ${msg}\n`);
}

/** command-on-PATH probe (which/where — real executables, not shell builtins). */
function has(cmd) {
  return (
    spawnSync(isWin ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status ===
    0
  );
}

// Run a formatter/linter at ROOT, inheriting stdio. shell:isWin so Windows can
// launch the .cmd shims that node CLIs (biome/pnpm) resolve to — the same reason
// verify.mjs uses shell:isWin (residual caveat: on Windows a staged path with a
// space would be mis-split by the shell; rare in this tree). Returns the spawn
// result, or null if the tool could not be spawned at all — a setup gap must
// warn and skip, never block the commit.
function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: isWin });
  if (r.error) {
    warn(
      `${cmd} could not be spawned (${r.error.code || r.error.message}); skipped ${label}`,
    );
    return null;
  }
  return r;
}

function isFile(rel) {
  try {
    return fs.statSync(path.join(ROOT, rel)).isFile();
  } catch {
    return false;
  }
}

const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACM'])
  .stdout.split('\n')
  .map((s) => s.trim())
  .filter(Boolean);
if (staged.length === 0) process.exit(0);

// ── 1. no-bash guard (fail fast) ───────────────────────────────────
const shHits = scanStaged(ROOT);
if (shHits.length) {
  warn('bash scripts must be Node (.mjs) so gates run on Windows too:');
  for (const h of shHits) warn(`  ${h}`);
  process.exit(1);
}

// A file is "generated" if its path matches a known generated shape or its head
// carries a generator marker; regeneration stays authoritative, so skip it.
// Kept in sync with the ruff/biome exclude configs.
function isGenerated(rel) {
  if (
    /(?:^|\/)generated\//.test(rel) ||
    /\/fb\/[A-Z][^/]*\.py$/.test(rel) ||
    /_fb\.py$/.test(rel) ||
    /_generated\.[^/]+$/.test(rel)
  ) {
    return true;
  }
  try {
    const head = fs
      .readFileSync(path.join(ROOT, rel), 'utf8')
      .split('\n', 3)
      .join('\n');
    return /automatically generated|do not (edit|modify)/i.test(head);
  } catch {
    return false;
  }
}

const src = staged.filter((f) => isFile(f) && !isGenerated(f));
const cpp = src.filter((f) => /\.(h|hpp|hxx|cpp|c|cc|cxx)$/.test(f));
const py = src.filter((f) => /\.py$/.test(f));
const web = src.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));
const changed = [];

// ── 2a. C++ — clang-format, pinned via uvx (byte-identical across machines) ──
if (cpp.length) {
  if (has('uvx')) {
    if (run('uvx', ['clang-format@20.1.8', '-style=file', '-i', ...cpp], 'C++'))
      changed.push(...cpp);
  } else if (has('clang-format')) {
    warn('using system clang-format; may differ from pinned 20.1.8');
    if (run('clang-format', ['-style=file', '-i', ...cpp], 'C++'))
      changed.push(...cpp);
  } else {
    warn(`clang-format (uv) not found; skipped C++: ${cpp.join(' ')}`);
  }
}

// ── 2b. Python — ruff format (--force-exclude honors excludes on explicit args) ─
if (py.length) {
  if (has('ruff')) {
    if (run('ruff', ['format', '--force-exclude', ...py], 'Python'))
      changed.push(...py);
  } else if (has('uvx')) {
    if (run('uvx', ['ruff', 'format', '--force-exclude', ...py], 'Python'))
      changed.push(...py);
  } else {
    warn(`ruff/uv not found; skipped Python: ${py.join(' ')}`);
  }
}

// ── 2c/3. JS/TS — biome check --write: format + safe lint/import fixes, then a
// non-zero exit means real (unfixable) lint errors remain → block. Explicit
// paths still honor biome.json ignores (generated/, fixtures/), so ignored
// staged files are simply skipped.
let biomeBlocked = false;
if (web.length) {
  const biomeArgs = ['check', '--write', '--no-errors-on-unmatched', ...web];
  const label = 'JS/TS format + lint';
  let r = null;
  if (has('biome')) r = run('biome', biomeArgs, label);
  else if (has('pnpm')) r = run('pnpm', ['exec', 'biome', ...biomeArgs], label);
  else warn('biome/pnpm not found; skipped JS/TS format + lint');
  // r is null when the tool could not be spawned (setup gap → skip, not block);
  // a real non-zero exit means unfixable lint errors remain → block.
  if (r) {
    changed.push(...web);
    if (r.status !== 0) biomeBlocked = true;
  }
}

// Re-stage exactly the files a formatter processed (parity with the prior hook:
// unrelated unstaged edits to an untouched file are never captured).
const restage = [...new Set(changed)].filter(isFile);
if (restage.length) git(['add', '--', ...restage], { stdio: 'ignore' });

if (biomeBlocked) {
  warn(
    'biome reported lint errors needing manual fixes (above); fix and re-stage, or `git commit -n` to bypass.',
  );
  process.exit(1);
}
process.exit(0);
