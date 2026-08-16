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
import { devMergeBaseCandidates } from './candidate-timeline-events.cjs';
import { commandArgumentBatches } from './command-argument-batches.mjs';
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
  const candidates = [...devMergeBaseCandidates(), upstream].filter(Boolean);
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
  const batches = commandArgumentBatches(
    web,
    isWin ? 6000 : Number.POSITIVE_INFINITY,
  );
  for (const [index, batch] of batches.entries()) {
    const suffix =
      batches.length > 1 ? ` (${index + 1}/${batches.length})` : '';
    run(`${label} lint + format check${suffix}`, 'pnpm', [
      'exec',
      'biome',
      'check',
      '--no-errors-on-unmatched',
      ...batch,
    ]);
  }
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
      '--config',
      'framework/core/pyproject.toml',
      '--check',
      '--force-exclude',
      ...py,
    ]);
    run(`${label} Python lint check`, 'ruff', [
      'check',
      '--config',
      'framework/core/pyproject.toml',
      '--force-exclude',
      ...py,
    ]);
  } else if (has('uvx')) {
    run(`${label} Python format check`, 'uvx', [
      'ruff',
      'format',
      '--config',
      'framework/core/pyproject.toml',
      '--check',
      '--force-exclude',
      ...py,
    ]);
    run(`${label} Python lint check`, 'uvx', [
      'ruff',
      'check',
      '--config',
      'framework/core/pyproject.toml',
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
// per-file scoping buys nothing. Formatting, clippy, and workspace unit tests
// keep source shape, lint, and launcher dispatch behavior in one gate.
// Read-only: fixes live in fix.mjs. A missing cargo warns and skips — rustc is
// deliberately outside shifu's bootstrap scope (doctor reports it as
// optional), and CI backstops crates/ edits made without a local toolchain.
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
  run(`${label} Rust unit tests`, 'cargo', ['test', '--workspace'], {
    cwd: crates,
  });
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

function checkPlatformMacros() {
  const files = splitLines(git(['ls-files', 'framework/core'])).filter((file) =>
    /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(file),
  );
  const findings = [];
  for (const file of files) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (/\b_WINDOWS\b/.test(lines[index])) {
        findings.push(
          `${file}:${index + 1}: use the compiler-standard _WIN32 macro`,
        );
      }
    }
  }
  if (findings.length) {
    throw new Error(
      `non-standard Windows platform macros:\n${findings.join('\n')}`,
    );
  }
  log('[check] Windows platform macros use _WIN32');
}

function checkNativeComponentVersionSync() {
  run('native component version sync gate', 'node', [
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

function checkShifuCacheContract() {
  run('Shifu cache contract gate', 'node', [
    path.join('scripts', 'check-shifu-cache-contract.mjs'),
  ]);
}

function testShifuCacheContract() {
  run('Shifu cache contract tests', 'node', [
    '--test',
    path.join('scripts', 'check-shifu-cache-contract.test.mjs'),
    path.join('scripts', 'shifu-cache-runtime.test.mjs'),
    path.join('scripts', 'shifu-conan-publish.test.mjs'),
    path.join('scripts', 'shifu-conan-hit-evidence.test.mjs'),
    path.join('scripts', 'shifu-conan-legacy.test.mjs'),
    path.join('scripts', 'shifu-uv-cache-adapter.test.mjs'),
  ]);
}

function checkShifuProductionGraphContract() {
  run('Shifu Production Graph contract gate', 'node', [
    path.join('framework', 'production-graph', 'check.mjs'),
  ]);
}

function testShifuProductionGraphContract() {
  run('Shifu Production Graph contract tests', 'node', [
    '--test',
    path.join('framework', 'production-graph', 'check.test.mjs'),
  ]);
}

function checkShifuDocumentationContract() {
  run('Shifu Documentation Protocol gate', 'node', [
    path.join('scripts', 'check-shifu-documentation-contract.mjs'),
  ]);
}

function testShifuDocumentationContract() {
  run('Shifu Documentation Protocol tests', 'node', [
    '--test',
    path.join('scripts', 'shifu-documentation-runtime.test.mjs'),
    path.join('scripts', 'shifu-documentation-surfaces.test.mjs'),
    path.join('scripts', 'shifu-documentation-consumers.test.mjs'),
    path.join('scripts', 'kungfu-xinfa-consumer.test.mjs'),
    path.join('scripts', 'buildchain-documentation-witness.test.mjs'),
    path.join('scripts', 'backfill-legacy-atlas-roots.test.mjs'),
  ]);
  run('Shifu Documentation material lane', 'node', [
    path.join('scripts', 'run-documentation-material-tests.mjs'),
  ]);
}

function checkRouteTopologyContract() {
  run('Route topology contract gate', 'node', [
    path.join('scripts', 'route-topology-contract.mjs'),
  ]);
}

function checkXinfaBoundary() {
  run('Xinfa standalone boundary gate', 'node', [
    path.join('crates', 'xinfa', 'tooling', 'check-boundary.mjs'),
  ]);
}

function testXinfaBoundary() {
  run('Xinfa standalone boundary tests', 'node', [
    '--test',
    path.join('crates', 'xinfa', 'tooling', 'check-boundary.test.mjs'),
  ]);
}

function checkShifuGateContract() {
  run('Shifu Gate contract gate', 'node', [
    path.join('scripts', 'check-shifu-gate-contract.mjs'),
  ]);
}

function testShifuGateContract() {
  run('Shifu Gate contract tests', 'node', [
    '--test',
    path.join('scripts', 'shifu-gate-runtime.test.mjs'),
    path.join('scripts', 'shifu-gate-executor.test.mjs'),
  ]);
}

function testDevGateLatencyContract() {
  run('dev required Gate latency contract tests', 'node', [
    '--test',
    path.join('scripts', 'affected-native-cache-payload.test.mjs'),
    path.join('scripts', 'cancel-dequeued-merge-group-runs.test.mjs'),
    path.join('scripts', 'dev-gate-latency-artifacts.test.mjs'),
    path.join('scripts', 'dev-gate-latency-patrol.test.mjs'),
    path.join('scripts', 'dev-gate-latency-patrol-workflow.test.mjs'),
    path.join('scripts', 'measure-dev-required-latency.test.mjs'),
    path.join('scripts', 'write-affected-native-cache-manifests.test.mjs'),
  ]);
}

function checkTestManifest() {
  run('tracked test manifest gate', 'node', [
    path.join('scripts', 'check-test-manifest.mjs'),
  ]);
}

function testTestManifest() {
  run('tracked test manifest tests', 'node', [
    '--test',
    path.join('scripts', 'check-test-manifest.test.mjs'),
  ]);
  run('previously unregistered script tests', 'node', [
    '--test',
    path.join('scripts', 'collect-layer-publication.test.mjs'),
    path.join('scripts', 'preflight-layer-publication.test.mjs'),
    path.join('scripts', 'prepare-gate-measurement-history.test.mjs'),
    path.join('scripts', 'gate-measurement-environment.test.mjs'),
    path.join('scripts', 'command-argument-batches.test.mjs'),
    path.join('scripts', 'qualify-embedding-membranes.test.mjs'),
    path.join('scripts', 'durability-powercut-platform.test.mjs'),
    path.join(
      'framework',
      'gui',
      'scripts',
      'electron-builder-config.test.mjs',
    ),
    path.join('framework', 'gui', 'scripts', 'run-electron-builder.test.mjs'),
    path.join('scripts', 'candidate-timeline-events.test.mjs'),
    path.join('scripts', 'qualify-xinfa-context-quality.test.mjs'),
    path.join('scripts', 'recover-focused-gate-receipt.test.mjs'),
    path.join('scripts', 'run-focused-gate-measurement.test.mjs'),
    path.join('scripts', 'run-layer-artifact-gate.test.mjs'),
    path.join('scripts', 'run-zero-burden-product-qualification.test.mjs'),
    path.join('scripts', 'shifu-gate-evidence.test.mjs'),
    path.join('product', 'scripts', 'product.test.mjs'),
    path.join(
      'framework',
      'core',
      'tests',
      'qualification',
      'live-peer-continuity',
      'run.test.mjs',
    ),
  ]);
}

function checkKungfuGateCatalog() {
  run('Kungfu Gate catalog gate', 'node', [
    path.join('scripts', 'check-kungfu-gate-catalog.mjs'),
  ]);
}

function checkLayerQualification() {
  run('portable format authority bundle', 'pnpm', [
    '--filter',
    '@kungfu-tech/spec',
    'run',
    'build',
  ]);
  run(
    'KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff layer qualification harness tests',
    'node',
    [
      '--test',
      path.join('scripts', 'run-release-qualification.test.mjs'),
      path.join('scripts', 'platform-command.test.mjs'),
      path.join('tests', 'qualification', 'layers', 'run.test.mjs'),
      path.join('tests', 'qualification', 'layers', 'surfaces', 'run.test.mjs'),
      path.join(
        'tests',
        'qualification',
        'layers',
        'surfaces',
        'installer.test.mjs',
      ),
      path.join('tests', 'qualification', 'layers', 'release', 'run.test.mjs'),
      path.join('tests', 'qualification', 'layers', 'process-metrics.test.mjs'),
      path.join('framework', 'spec', 'index.test.js'),
      path.join('framework', 'gui', 'scripts', 'before-pack.test.cjs'),
      path.join('framework', 'gui', 'scripts', 'bundle-core-audit.test.cjs'),
      path.join('product', 'scripts', 'compatibility.test.mjs'),
      path.join('product', 'scripts', 'dist.test.mjs'),
      path.join('product', 'scripts', 'dist-cli-executable-layout.test.mjs'),
    ],
  );
  run(
    'KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff layer qualification harness',
    'node',
    [path.join('tests', 'qualification', 'layers', 'run.mjs')],
  );
  run(
    'KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff surface source contract',
    'node',
    [
      path.join('tests', 'qualification', 'layers', 'surfaces', 'run.mjs'),
      '--validate-only',
    ],
  );
}

function checkDurabilityQualification() {
  run(
    'KF-ADR-019f86da-4f90-7ec5-a83c-99cfaee56aca durability qualification harness tests',
    'node',
    [
      '--test',
      path.join(
        'framework',
        'core',
        'tests',
        'qualification',
        'durability',
        'run.test.mjs',
      ),
      path.join('scripts', 'run-durability-slo.test.mjs'),
      path.join('scripts', 'run-durability-offhost-restore.test.mjs'),
      path.join('scripts', 'run-durability-clean-host-restart.test.mjs'),
      path.join(
        'framework',
        'core',
        'tests',
        'qualification',
        'durability',
        'slo_evidence.test.mjs',
      ),
      path.join(
        'framework',
        'core',
        'tests',
        'qualification',
        'durability',
        'offhost_evidence.test.mjs',
      ),
      path.join(
        'framework',
        'core',
        'tests',
        'qualification',
        'durability',
        'clean_restart_evidence.test.mjs',
      ),
      path.join(
        'framework',
        'core',
        'tests',
        'qualification',
        'durability',
        'production_candidate_admission.test.mjs',
      ),
    ],
  );
  run(
    'KF-ADR-019f86da-4f90-7ec5-a83c-99cfaee56aca production-candidate admission',
    'node',
    [path.join('scripts', 'check-durability-production-candidate.mjs')],
  );
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

function checkKfd7LibraryBoundary() {
  run('KFD-7 library boundary contract', 'node', [
    path.join('scripts', 'check-kfd7-library-boundary.test.mjs'),
  ]);
  run('KFD Agent Runtime public boundary', 'node', [
    path.join('scripts', 'check-kfd-agent-runtime-boundary.mjs'),
  ]);
}

function checkJournalAuthorityBoundary() {
  run('journal authority boundary gate', 'node', [
    path.join('scripts', 'check-journal-authority-boundary.mjs'),
  ]);
}

function checkLiveRuntimeTerminology() {
  run('live runtime terminology gate', 'node', [
    path.join('scripts', 'check-live-runtime-terminology.mjs'),
  ]);
}

function checkUpgradeContract() {
  run('runtime upgrade contract gate', 'node', [
    path.join('scripts', 'check-upgrade-contract.mjs'),
  ]);
}

function checkUpgradeQualification() {
  run('product upgrade qualification gate', 'node', [
    path.join('scripts', 'check-upgrade-qualification.mjs'),
  ]);
}

function testUpgradeControlPlane() {
  run('runtime upgrade contract tests', 'node', [
    '--test',
    path.join('scripts', 'check-upgrade-contract.test.mjs'),
  ]);
  run('runtime upgrade control-plane tests', 'node', [
    path.join('scripts', 'run-runtime-upgrade-tests.mjs'),
  ]);
  run('product upgrade qualification tests', 'node', [
    '--test',
    path.join('scripts', 'check-upgrade-qualification.test.mjs'),
  ]);
}

function checkDocs() {
  run('Markdown documentation gate', 'node', [
    path.join('scripts', 'run-docs-check.mjs'),
  ]);
}

function checkAdrIdentities() {
  const adrDir = path.join(ROOT, 'docs', 'adr');
  const files = fs
    .readdirSync(adrDir)
    .filter((file) => /^(?:SHIFU-)?ADR-\d{4}-.+\.md$/.test(file))
    .sort();
  /** @type {Map<string, string[]>} */
  const byId = new Map();
  /** @type {string[]} */
  const errors = [];
  for (const file of files) {
    const id = /^(?:SHIFU-)?ADR-\d{4}/.exec(file)?.[0] || '';
    const siblings = byId.get(id) || [];
    siblings.push(file);
    byId.set(id, siblings);
    const text = fs.readFileSync(path.join(adrDir, file), 'utf8');
    if (!text.includes(`# ${id}:`)) {
      errors.push(`${file} heading does not match ${id}`);
    }
  }
  for (const [id, siblings] of byId) {
    if (siblings.length > 1) {
      errors.push(`${id} is duplicated: ${siblings.join(', ')}`);
    }
  }
  if (errors.length) {
    throw new Error(`ADR identity violations:\n${errors.join('\n')}`);
  }
  log('[check] ADR identities unique and filename/heading pairs match');
}

function touchesBuildchainKfdEvidence(files) {
  return files.some(
    (file) =>
      file === '.buildchain/kfd/kfd-3/surfaces.json' ||
      file === '.buildchain/kfd/support-matrix.json' ||
      file.startsWith('.buildchain/kfd/kfd-1/') ||
      file.startsWith('.buildchain/kfd/kfd-2/') ||
      file.startsWith('.buildchain/kfd/kfd-3/') ||
      file.startsWith('.buildchain/kfd/kfd-1/') ||
      file.startsWith('.buildchain/kfd/kfd-2/') ||
      file.startsWith('developer/sdk/kfd/kfd-1/') ||
      file.startsWith('developer/sdk/kfd/kfd-2/') ||
      file === 'developer/sdk/kfd/kfd-3-surfaces.json' ||
      file === 'developer/sdk/kfd/upstream-aggregate.json' ||
      file === 'developer/sdk/kfd/support-matrix.json' ||
      file === 'developer/sdk/src/sdk.js' ||
      file === 'scripts/buildchain-kfd-evidence.mjs' ||
      file === 'framework/core/tests/qualification/kfd4-perspective.mjs' ||
      file === 'scripts/kfd4-perspective-qualification.test.mjs' ||
      file === 'scripts/kfd-support-matrix.mjs' ||
      file === 'scripts/kfd-support-matrix.test.mjs' ||
      file === '.buildchain/kfd/kfd-2/registry.json' ||
      file.startsWith('framework/core/src/python/kungfu/agent/') ||
      file === 'framework/core/src/python/kungfu/rewind/perspective.py' ||
      file === 'framework/core/tests/python/test_kfd4_perspective.py' ||
      file.startsWith('.github/workflows/') ||
      file.startsWith('docs/qualification/evidence/kfd-4-perspective/') ||
      file.startsWith('docs/kfd-') ||
      file === 'docs/qualification/kfd-support-matrix.md',
  );
}

function checkBuildchainKfdEvidence(files = [], { force = false } = {}) {
  // The committed source binding depends on Git ancestry as well as file
  // content. A rebase or merge can stale it without placing any KFD path in
  // the changed-file set, so keep this fast check unconditional.
  run('Buildchain KFD evidence check', 'node', [
    path.join('scripts', 'buildchain-kfd-evidence.mjs'),
    '--check',
  ]);
  if (!force && !touchesBuildchainKfdEvidence(files)) {
    log('[check] no additional Buildchain KFD evidence inputs changed');
    return;
  }
  run('KFD-4 perspective qualification', 'node', [
    path.join(
      'framework',
      'core',
      'tests',
      'qualification',
      'kfd4-perspective.mjs',
    ),
  ]);
  run('KFD-4 perspective qualification negative fixtures', 'node', [
    '--test',
    path.join('scripts', 'kfd4-perspective-qualification.test.mjs'),
  ]);
  run('KFD support matrix check', 'node', [
    path.join('scripts', 'kfd-support-matrix.mjs'),
    '--check',
  ]);
  run('KFD support matrix negative fixtures', 'node', [
    '--test',
    path.join('scripts', 'kfd-support-matrix.test.mjs'),
  ]);
}

function checkLibwasmCargoCache(files = [], { force = false } = {}) {
  const touched = files.some(
    (file) =>
      file === 'framework/core/.cmake/libwasm-cargo-cache.cmake' ||
      file === 'scripts/libwasm-cargo-cache.test.mjs' ||
      file === 'scripts/qualify-libwasm-cargo-cache.mjs' ||
      file.endsWith('/libwasm/CMakeLists.txt') ||
      file.includes('/libwasm-shared-membrane/'),
  );
  if (!force && !touched) return;
  run('libwasm Cargo cache contract tests', 'node', [
    '--test',
    path.join('scripts', 'libwasm-cargo-cache.test.mjs'),
  ]);
}

function checkXinfaCrate(files = [], { force = false } = {}) {
  if (!force && !files.some((file) => file.startsWith('crates/xinfa/'))) return;
  run('Xinfa standalone crate', 'node', [
    path.join('crates', 'xinfa', 'tooling', 'task.mjs'),
    'check',
  ]);
}

function checkInvariantSystem() {
  run('Kungfu invariant system tests', 'node', [
    '--test',
    path.join('scripts', 'kungfu-invariant.test.mjs'),
  ]);
}

function checkKfxAuthoringKit(files = [], { force = false } = {}) {
  const touched = files.some(
    (file) =>
      file === 'framework/api/package.json' ||
      file === 'framework/kfx/package.json' ||
      file === 'framework/api/src/capability/service-authz.ts' ||
      file === 'scripts/generate-kfx-authoring-kit.mjs' ||
      file.startsWith('framework/core/src/python/kungfu/kfx_authoring_assets/'),
  );
  if (!force && !touched) return;
  run('installed KFX authoring kit generated-root check', 'node', [
    path.join('scripts', 'generate-kfx-authoring-kit.mjs'),
    '--check',
  ]);
}

function checkStaged() {
  checkNoBashStaged();
  checkTestManifest();
  checkPlatformMacros();
  checkNativeComponentVersionSync();
  checkShifuEntryContract();
  checkShifuCacheContract();
  checkShifuProductionGraphContract();
  checkShifuDocumentationContract();
  checkRouteTopologyContract();
  checkXinfaBoundary();
  checkShifuGateContract();
  testDevGateLatencyContract();
  checkKungfuGateCatalog();
  checkCarrierActionEnvelope(['--staged']);
  checkRuntimeGreenfield(['--staged']);
  checkSchemaAuthority();
  checkKfd7LibraryBoundary();
  checkJournalAuthorityBoundary();
  checkLiveRuntimeTerminology();
  checkUpgradeContract();
  checkUpgradeQualification();
  checkInvariantSystem();
  checkAdrIdentities();
  checkDocs();
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
  checkKfxAuthoringKit(files);
  checkLibwasmCargoCache(files);
  checkXinfaCrate(files);

  log('\n[check] staged gate passed');
}

function checkShared() {
  checkTestManifest();
  testTestManifest();
  testShifuEntryContract();
  testShifuCacheContract();
  testShifuProductionGraphContract();
  testShifuDocumentationContract();
  testXinfaBoundary();
  testShifuGateContract();
  testDevGateLatencyContract();
  checkKungfuGateCatalog();
  testSchemaAuthority();
  checkKfd7LibraryBoundary();
  checkJournalAuthorityBoundary();
  checkLiveRuntimeTerminology();
  testUpgradeControlPlane();
  checkInvariantSystem();
  checkAdrIdentities();
  checkDocs();
  run('journal manager type check', 'pnpm', [
    '--filter',
    '@kungfu-tech/kfx-view-journal-manager',
    'run',
    'check',
  ]);
  run('KFX Profile Suite contract tests', 'pnpm', [
    'run',
    'test:kfx-profile-suite',
  ]);
  checkLayerQualification();
  checkDurabilityQualification();
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
  checkPlatformMacros();
  checkNativeComponentVersionSync();
  checkShifuEntryContract();
  checkXinfaBoundary();
  checkCarrierActionEnvelope();
  checkRuntimeGreenfield();
  checkSchemaAuthority();
  checkKfd7LibraryBoundary();
  checkJournalAuthorityBoundary();
  checkLiveRuntimeTerminology();
  checkUpgradeContract();
  checkUpgradeQualification();
  const files = changedFiles();
  checkPythonFiles('changed', files);
  checkBiomeFiles('changed', files);
  checkRustFiles('changed', files);
  checkBuildchainKfdEvidence(files);
  checkKfxAuthoringKit(files);
  checkLibwasmCargoCache(files);
  checkXinfaCrate(files);
  checkShared();
  log('\n[check] changed-scope gate passed');
}

function checkAll() {
  checkNoBashTree();
  checkPlatformMacros();
  checkNativeComponentVersionSync();
  checkShifuEntryContract();
  checkXinfaBoundary();
  checkCarrierActionEnvelope(['--all']);
  checkRuntimeGreenfield(['--all']);
  checkSchemaAuthority();
  checkKfd7LibraryBoundary();
  checkJournalAuthorityBoundary();
  checkLiveRuntimeTerminology();
  checkUpgradeContract();
  checkUpgradeQualification();
  run('repo lint + format check', 'pnpm', ['run', 'lint']);
  checkRustFiles('all', [], { force: true });
  checkBuildchainKfdEvidence([], { force: true });
  checkKfxAuthoringKit([], { force: true });
  checkLibwasmCargoCache([], { force: true });
  checkXinfaCrate([], { force: true });
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
