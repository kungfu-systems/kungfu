#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Quality gate for local development and CI.
//
//   ./shifu check          changed-scope read-only gate + shared tests
//   ./shifu check:staged   fast, read-only pre-commit gate
//   ./shifu check:all      whole-tree lint/type/test gate
//
// Formatting fixes live in scripts/fix.mjs. This script must not rewrite source
// files; pre-commit uses it directly, so the hook stays predictable.
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanStaged, scanTree } from './no-bash-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';
const args = process.argv.slice(2);
const stagedOnly = args.includes('--staged');
const allFiles = args.includes('--all');

function log(message = '') {
  console.log(message);
}

function warn(message) {
  console.error(`[check] ${message}`);
}

function run(label, cmd, commandArgs, options = {}) {
  log(`\n[check] ${label}`);
  log(`[check] $ ${[cmd, ...commandArgs].join(' ')}`);
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
    log(`[check] changed-file base: ${base.ref} (${base.sha.slice(0, 12)})`);
  } else {
    warn('could not determine merge-base; checking uncommitted changes only');
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

function checkBiomeFiles(label, files) {
  const web = files.filter((file) =>
    /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|css)$/.test(file),
  );
  if (!web.length) {
    log(`[check] no ${label} JS/TS/JSON/CSS files`);
    return;
  }
  run(`${label} lint + format check`, 'pnpm', [
    'exec',
    'biome',
    'check',
    '--no-errors-on-unmatched',
    ...web,
  ]);
}

// Python format + lint check on an explicit file list, so the changed-scope
// gate carries the same ruff coverage the staged gate already has (a pre-commit
// hook is only developer-local; changed-scope is the gate CONTRIBUTING points CI
// at). Read-only: `ruff format --check` never rewrites (fixes live in fix.mjs),
// `ruff check` lints per framework/core [tool.ruff.lint] (select E/F). Scoped to
// the passed files, so pre-existing lint debt in untouched files does not block.
function checkPythonFiles(label, files) {
  const py = files.filter((file) => /\.py$/.test(file));
  if (!py.length) {
    log(`[check] no ${label} Python files`);
    return;
  }
  if (has('ruff')) {
    run(`${label} Python format check`, 'ruff', [
      'format',
      '--check',
      '--force-exclude',
      ...py,
    ]);
    run(`${label} Python lint check`, 'ruff', [
      'check',
      '--force-exclude',
      ...py,
    ]);
  } else if (has('uvx')) {
    run(`${label} Python format check`, 'uvx', [
      'ruff',
      'format',
      '--check',
      '--force-exclude',
      ...py,
    ]);
    run(`${label} Python lint check`, 'uvx', [
      'ruff',
      'check',
      '--force-exclude',
      ...py,
    ]);
  } else {
    warn(`ruff/uvx not found; skipped Python check: ${py.join(' ')}`);
  }
}

// Rust format + lint check, workspace-scoped whenever any crates/ file is in
// the given list: the workspace is a few small crates, cargo fmt reads the
// edition from Cargo.toml, and clippy compiles whole targets by nature — so
// per-file scoping buys nothing, and running the exact two commands shifu CI
// runs (fmt --all --check, clippy -D warnings) means the local gate cannot
// drift from CI. Read-only: fixes live in fix.mjs. A missing cargo warns and
// skips — rustc is deliberately outside shifu's bootstrap scope (doctor
// reports it as optional), and CI backstops crates/ edits made without a
// local Rust toolchain.
function checkRustFiles(label, files, { force = false } = {}) {
  const rust = files.filter((file) => file.startsWith('crates/'));
  if (!force && !rust.length) {
    log(`[check] no ${label} crates/ files`);
    return;
  }
  if (!has('cargo')) {
    warn(
      `cargo not found; skipped Rust check${rust.length ? `: ${rust.join(' ')}` : ''}`,
    );
    return;
  }
  const crates = path.join(ROOT, 'crates');
  run(`${label} Rust format check`, 'cargo', ['fmt', '--all', '--check'], {
    cwd: crates,
  });
  run(
    `${label} Rust lint check`,
    'cargo',
    ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings'],
    { cwd: crates },
  );
}

function checkNoBashStaged() {
  const hits = scanStaged(ROOT);
  if (!hits.length) return;
  throw new Error(
    `bash scripts must be Node (.mjs) so gates run on Windows too:\n${hits
      .map((hit) => `  ${hit}`)
      .join('\n')}`,
  );
}

function checkNoBashTree() {
  const hits = scanTree(ROOT);
  if (!hits.length) return;
  throw new Error(
    `bash scripts must be Node (.mjs) so gates run on Windows too:\n${hits
      .map((hit) => `  ${hit}`)
      .join('\n')}`,
  );
}

function checkShifuVersionSync() {
  run('shifu version sync gate', 'node', [
    path.join('scripts', 'sync-shifu-version.mjs'),
    '--check',
  ]);
}

function checkShifuEntryContract() {
  run('Shifu entry contract gate', 'node', [
    path.join('scripts', 'check-shifu-entry-contract.mjs'),
  ]);
}

function testShifuEntryContract() {
  run('Shifu entry contract tests', 'node', [
    '--test',
    path.join('scripts', 'check-shifu-entry-contract.test.mjs'),
  ]);
}

function checkLayerQualification() {
  run('ADR-0049 layer qualification harness tests', 'node', [
    '--test',
    path.join('tests', 'qualification', 'layers', 'run.test.mjs'),
    path.join('tests', 'qualification', 'layers', 'surfaces', 'run.test.mjs'),
    path.join('product', 'scripts', 'compatibility.test.mjs'),
    path.join('product', 'scripts', 'dist.test.mjs'),
  ]);
  run('ADR-0049 layer qualification harness', 'node', [
    path.join('tests', 'qualification', 'layers', 'run.mjs'),
  ]);
  run('ADR-0049 surface source contract', 'node', [
    path.join('tests', 'qualification', 'layers', 'surfaces', 'run.mjs'),
    '--validate-only',
  ]);
}

function checkCarrierActionEnvelope(scopeArgs = []) {
  run('carrier/action-envelope gate', 'node', [
    path.join('scripts', 'check-carrier-action-envelope.mjs'),
    ...scopeArgs,
  ]);
}

function checkRuntimeGreenfield(scopeArgs = []) {
  run('runtime greenfield gate', 'node', [
    path.join('scripts', 'check-runtime-greenfield.mjs'),
    ...scopeArgs,
  ]);
}

function checkSchemaAuthority() {
  run('schema authority gate', 'node', [
    path.join('scripts', 'check-schema-authority.mjs'),
  ]);
}

function testSchemaAuthority() {
  run('schema authority negative fixtures', 'node', [
    '--test',
    path.join('scripts', 'check-schema-authority.test.mjs'),
  ]);
}

function touchesBuildchainKfdEvidence(files) {
  return files.some(
    (file) =>
      file === '.buildchain/kfd/kfd-3/surfaces.json' ||
      file.startsWith('.buildchain/kfd/kfd-1/') ||
      file.startsWith('.buildchain/kfd/kfd-2/') ||
      file.startsWith('.buildchain/kfd/kfd-3/') ||
      file.startsWith('.buildchain/kfd/kfd-1/') ||
      file.startsWith('.buildchain/kfd/kfd-2/') ||
      file.startsWith('developer/sdk/kfd/kfd-1/') ||
      file.startsWith('developer/sdk/kfd/kfd-2/') ||
      file === 'developer/sdk/kfd/kfd-3-surfaces.json' ||
      file === 'developer/sdk/kfd/upstream-aggregate.json' ||
      file === 'developer/sdk/src/sdk.js' ||
      file === 'scripts/buildchain-kfd-evidence.mjs' ||
      file === '.buildchain/kfd/kfd-2/registry.json' ||
      file.startsWith('framework/core/src/python/kungfu/agent/') ||
      file.startsWith('.github/workflows/') ||
      file.startsWith('docs/kfd-'),
  );
}

function checkBuildchainKfdEvidence(files = [], { force = false } = {}) {
  if (!force && !touchesBuildchainKfdEvidence(files)) {
    log('[check] no Buildchain KFD evidence inputs changed');
    return;
  }
  run('Buildchain KFD evidence check', 'node', [
    path.join('scripts', 'buildchain-kfd-evidence.mjs'),
    '--check',
  ]);
}

function checkStaged() {
  checkNoBashStaged();
  checkShifuVersionSync();
  checkShifuEntryContract();
  checkCarrierActionEnvelope(['--staged']);
  checkRuntimeGreenfield(['--staged']);
  checkSchemaAuthority();
  const files = stagedFiles();
  if (!files.length) {
    log('[check] no staged source files');
    return;
  }

  const cpp = files.filter((file) => /\.(h|hpp|hxx|cpp|c|cc|cxx)$/.test(file));

  if (cpp.length) {
    if (has('uvx')) {
      run('C++ format check', 'uvx', [
        'clang-format@20.1.8',
        '-style=file',
        '--dry-run',
        '-Werror',
        ...cpp,
      ]);
    } else if (has('clang-format')) {
      warn('using system clang-format; may differ from pinned 20.1.8');
      run('C++ format check', 'clang-format', [
        '-style=file',
        '--dry-run',
        '-Werror',
        ...cpp,
      ]);
    } else {
      warn(
        `clang-format/uvx not found; skipped C++ format check: ${cpp.join(' ')}`,
      );
    }
  }

  checkPythonFiles('staged', files);

  checkBiomeFiles('staged', files);
  checkRustFiles('staged', files);
  checkBuildchainKfdEvidence(files);

  log('\n[check] staged gate passed');
}

function checkShared() {
  testShifuEntryContract();
  testSchemaAuthority();
  checkLayerQualification();
  run('tooling type check', 'pnpm', ['run', 'check:types']);
  run('SDK unit tests', 'pnpm', [
    '--filter',
    '@kungfu-tech/sdk',
    'run',
    'build',
  ]);
  run('core tooling tests', 'pnpm', [
    '--filter',
    '@kungfu-tech/core',
    'run',
    'test:tooling',
  ]);
}

function checkChanged() {
  checkNoBashTree();
  checkShifuVersionSync();
  checkShifuEntryContract();
  checkCarrierActionEnvelope();
  checkRuntimeGreenfield();
  checkSchemaAuthority();
  const files = changedFiles();
  checkPythonFiles('changed', files);
  checkBiomeFiles('changed', files);
  checkRustFiles('changed', files);
  checkBuildchainKfdEvidence(files);
  checkShared();
  log('\n[check] changed-scope gate passed');
}

function checkAll() {
  checkNoBashTree();
  checkShifuVersionSync();
  checkShifuEntryContract();
  checkCarrierActionEnvelope(['--all']);
  checkRuntimeGreenfield(['--all']);
  checkSchemaAuthority();
  run('repo lint + format check', 'pnpm', ['run', 'lint']);
  checkRustFiles('all', [], { force: true });
  checkBuildchainKfdEvidence([], { force: true });
  checkShared();
  log('\n[check] whole-tree gate passed');
}

try {
  if (stagedOnly) checkStaged();
  else if (allFiles) checkAll();
  else checkChanged();
} catch (error) {
  console.error(
    `[check] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
