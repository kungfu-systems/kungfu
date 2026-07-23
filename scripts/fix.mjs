#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Explicit source-rewriting companion to scripts/check.mjs.
//
//   ./shifu fix          format/fix changed source files
//   ./shifu fix:staged   format/fix only staged source files and re-stage them
//   ./shifu fix:all      format/fix the whole repo
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanStaged, scanTree } from './no-bash-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';
const stagedOnly = process.argv.includes('--staged');
const allFiles = process.argv.includes('--all');

function log(message = '') {
  console.log(message);
}

function warn(message) {
  console.error(`[fix] ${message}`);
}

function run(label, cmd, commandArgs, options = {}) {
  log(`\n[fix] ${label}`);
  log(`[fix] $ ${[cmd, ...commandArgs].join(' ')}`);
  const result = spawnSync(cmd, commandArgs, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    stdio: 'inherit',
    shell: isWin,
  });
  if (result.error) {
    throw new Error(
      `${label} could not start: ${result.error.code || result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status ?? result.signal})`);
  }
}

function git(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`,
    );
  }
  return result.stdout.trim();
}

function gitMaybe(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    ...options,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function has(cmd) {
  return (
    spawnSync(isWin ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status ===
    0
  );
}

function isFile(rel) {
  try {
    return fs.statSync(path.join(ROOT, rel)).isFile();
  } catch {
    return false;
  }
}

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

function stagedFiles() {
  return git(['diff', '--cached', '--name-only', '--diff-filter=ACM'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => isFile(file) && !isGenerated(file));
}

function splitLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function mergeBase() {
  const upstream = gitMaybe([
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]);
  const candidates = [
    upstream,
    'origin/HEAD',
    'nas/dev/v4/v4.0',
    'origin/dev/v4/v4.0',
    'dev/v4/v4.0',
  ].filter(Boolean);
  for (const ref of candidates) {
    const base = gitMaybe(['merge-base', String(ref), 'HEAD']);
    if (base) return { ref: String(ref), sha: base };
  }
  return null;
}

function changedFiles() {
  const base = mergeBase();
  const files = new Set();
  if (base) {
    for (const file of splitLines(
      git(['diff', '--name-only', '--diff-filter=ACM', `${base.sha}...HEAD`]),
    )) {
      files.add(file);
    }
    log(`[fix] changed-file base: ${base.ref} (${base.sha.slice(0, 12)})`);
  } else {
    warn('could not determine merge-base; fixing uncommitted changes only');
  }
  for (const mode of [[], ['--cached']]) {
    for (const file of splitLines(
      git(['diff', ...mode, '--name-only', '--diff-filter=ACM']),
    )) {
      files.add(file);
    }
  }
  for (const file of splitLines(
    git(['ls-files', '--others', '--exclude-standard']),
  )) {
    files.add(file);
  }
  return [...files].filter((file) => isFile(file) && !isGenerated(file));
}

function assertNoBash(hits) {
  if (!hits.length) return;
  throw new Error(
    `bash scripts must be Node (.mjs) so gates run on Windows too:\n${hits
      .map((hit) => `  ${hit}`)
      .join('\n')}`,
  );
}

function fixFiles(scope, files, restageAfterFix) {
  if (!files.length) {
    log(`[fix] no ${scope} source files`);
    return;
  }

  const cpp = files.filter((file) => /\.(h|hpp|hxx|cpp|c|cc|cxx)$/.test(file));
  const py = files.filter((file) => /\.py$/.test(file));
  const web = files.filter((file) =>
    /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|css)$/.test(file),
  );
  const changed = [];

  if (cpp.length) {
    if (has('uvx')) {
      run('C++ format', 'uvx', [
        'clang-format@20.1.8',
        '-style=file',
        '-i',
        ...cpp,
      ]);
      changed.push(...cpp);
    } else if (has('clang-format')) {
      warn('using system clang-format; may differ from pinned 20.1.8');
      run('C++ format', 'clang-format', ['-style=file', '-i', ...cpp]);
      changed.push(...cpp);
    } else {
      warn(`clang-format/uvx not found; skipped C++ format: ${cpp.join(' ')}`);
    }
  }

  if (py.length) {
    if (has('ruff')) {
      run('Python format', 'ruff', ['format', '--force-exclude', ...py]);
      run('Python lint fix', 'ruff', [
        'check',
        '--fix',
        '--force-exclude',
        ...py,
      ]);
      changed.push(...py);
    } else if (has('uvx')) {
      run('Python format', 'uvx', ['ruff', 'format', '--force-exclude', ...py]);
      run('Python lint fix', 'uvx', [
        'ruff',
        'check',
        '--fix',
        '--force-exclude',
        ...py,
      ]);
      changed.push(...py);
    } else {
      warn(`ruff/uvx not found; skipped Python fix: ${py.join(' ')}`);
    }
  }

  if (web.length) {
    run('JS/TS/JSON format + safe lint fixes', 'pnpm', [
      'exec',
      'biome',
      'check',
      '--write',
      '--no-errors-on-unmatched',
      ...web,
    ]);
    changed.push(...web);
  }

  const rust = files.filter((file) => file.startsWith('crates/'));
  if (rust.length) {
    if (has('cargo')) {
      // Workspace scope on purpose: cargo fmt reads the edition from
      // Cargo.toml (no flags to drift), and CI keeps the tree fmt-clean, so
      // --all only ever rewrites the files you touched. Only the files from
      // the given scope are re-staged; collateral rewrites stay unstaged for
      // review.
      run('Rust format', 'cargo', ['fmt', '--all'], {
        cwd: path.join(ROOT, 'crates'),
      });
      changed.push(...rust.filter((file) => file.endsWith('.rs')));
    } else {
      warn(`cargo not found; skipped Rust format: ${rust.join(' ')}`);
    }
  }

  if (restageAfterFix) {
    const restage = [...new Set(changed)].filter(isFile);
    if (restage.length) {
      run('re-stage fixed files', 'git', ['add', '--', ...restage]);
    }
  }
  log(`\n[fix] ${scope} fix complete`);
}

function fixStaged() {
  assertNoBash(scanStaged(ROOT));
  fixFiles('staged', stagedFiles(), true);
}

function fixChanged() {
  assertNoBash(scanTree(ROOT));
  fixFiles('changed', changedFiles(), false);
}

function fixAll() {
  assertNoBash(scanTree(ROOT));
  run('workspace format', 'pnpm', ['run', 'format']);
  run('JS/TS/JSON safe lint fixes', 'pnpm', [
    'exec',
    'biome',
    'check',
    '--write',
    '.',
  ]);
  log('\n[fix] full fix complete');
}

try {
  if (stagedOnly) fixStaged();
  else if (allFiles) fixAll();
  else fixChanged();
} catch (error) {
  console.error(
    `[fix] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
