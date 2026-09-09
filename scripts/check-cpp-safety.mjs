#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'framework', 'core');
const POLICY_PATH = 'developer/maintainability/cpp-safety-policy.json';

const SANITIZER_TARGETS = Object.freeze([
  'yijinjing_mmap_tests',
  'yijinjing_writer_memory_safety_tests',
  'yijinjing_fact_ledger_tests',
  'kungfu_node_boundary_contract_tests',
  'kungfu_fact_authority_contract_tests',
  'kungfu_native_kfx_contract_tests',
]);

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  return value;
}

function digest(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(JSON.stringify(ordered(value)));
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function relativePath(value) {
  const resolved = path.resolve(value);
  const relative = path.relative(ROOT, resolved).split(path.sep).join('/');
  return relative.startsWith('../')
    ? resolved.split(path.sep).join('/')
    : relative;
}

function loadPolicy() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, POLICY_PATH), 'utf8'));
}

function listFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function codeOnly(line) {
  let output = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      output += ' ';
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && line[index + 1] === '/') break;
    if (character === '"' || character === "'") {
      quote = character;
      output += ' ';
      continue;
    }
    output += character;
  }
  return output;
}

function inventoryBoundarySites(policy) {
  const extensions = new Set(policy.lifetimeInventory.extensions);
  const files = new Set();
  for (const root of policy.scopeRoots) {
    const absolute = path.join(ROOT, root);
    if (!fs.existsSync(absolute)) continue;
    for (const file of listFiles(absolute)) {
      if (extensions.has(path.extname(file))) files.add(file);
    }
  }
  const patterns = [
    ['reinterpret-cast', /\breinterpret_cast\s*</gu],
    ['manual-new', /\bnew\s+/gu],
    ['manual-delete', /\bdelete(?:\s*\[\s*\])?\s+/gu],
  ];
  const sites = [];
  for (const file of [...files].sort()) {
    const filePath = relativePath(file);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const code = codeOnly(lines[lineIndex]);
      for (const [kind, pattern] of patterns) {
        pattern.lastIndex = 0;
        for (const match of code.matchAll(pattern)) {
          const rule = policy.lifetimeInventory.classifications.find(
            (item) =>
              filePath.startsWith(item.pathPrefix) && item.kinds.includes(kind),
          );
          sites.push({
            path: filePath,
            line: lineIndex + 1,
            column: match.index + 1,
            kind,
            classification: rule?.classification || null,
            invariant: rule?.invariant || null,
          });
        }
      }
    }
  }
  const unclassified = sites.filter((site) => !site.classification);
  return { sites, unclassified, root: digest(sites) };
}

function findTool(policy, environment = process.env) {
  const override = environment[policy.tool.environmentOverride];
  const candidates = [override, ...policy.tool.candidates].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0) continue;
    const versionText = `${probe.stdout || ''}${probe.stderr || ''}`.trim();
    const match =
      /(?:LLVM|clang) version\s+(\d+)(?:\.(\d+))?(?:\.(\d+))?/iu.exec(
        versionText,
      );
    if (!match) continue;
    return {
      command: candidate,
      major: Number(match[1]),
      version: [match[1], match[2] || '0', match[3] || '0'].join('.'),
      versionRoot: digest(versionText),
    };
  }
  return null;
}

function selectTranslationUnits(database, policy) {
  const selected = new Set();
  for (const entry of database) {
    const file = relativePath(entry.file);
    if (!/\.(?:cc|cpp|cxx)$/u.test(file)) continue;
    if (!policy.scopeRoots.some((root) => file.startsWith(root))) continue;
    selected.add(file);
  }
  return [...selected].sort();
}

function parseDiagnostics(output) {
  const diagnostics = [];
  const pattern = /^(.*?):(\d+):(\d+): (warning|error): (.*?) \[([^\]]+)\]$/u;
  for (const line of output.split(/\r?\n/u)) {
    const match = pattern.exec(line);
    if (!match) continue;
    diagnostics.push({
      path: relativePath(match[1]),
      line: Number(match[2]),
      column: Number(match[3]),
      severity: match[4],
      message: match[5],
      check: match[6],
    });
  }
  return diagnostics;
}

function runTool(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', (error) => resolve({ status: 2, output: error.message }));
    child.on('close', (status) => resolve({ status: status ?? 2, output }));
  });
}

async function analyze(policy, tool, files) {
  const checks = `-*,${policy.checks.join(',')}`;
  const headerFilter = `^${ROOT.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/framework/core/src/(?:bindings/node|libkungfu|libyijinjing)/`;
  const results = new Array(files.length);
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const index = cursor;
      cursor += 1;
      const args = [
        '-p',
        path.join(ROOT, path.dirname(policy.compileDatabase)),
        path.join(ROOT, files[index]),
        `--checks=${checks}`,
        `--header-filter=${headerFilter}`,
        '--quiet',
      ];
      results[index] = await runTool(tool.command, args);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(policy.parallelism, files.length)) },
      worker,
    ),
  );
  const failedFiles = [];
  const diagnostics = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status !== 0)
      failedFiles.push({
        path: files[index],
        exitCode: result.status,
        outputRoot: digest(result.output),
      });
    diagnostics.push(...parseDiagnostics(result.output));
  }
  const unique = new Map(
    diagnostics.map((item) => [JSON.stringify(ordered(item)), item]),
  );
  return {
    diagnostics: [...unique.values()].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    ),
    failedFiles,
  };
}

function summarizeDiagnostics(diagnostics) {
  const counts = {};
  for (const { check } of diagnostics) counts[check] = (counts[check] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort());
}

async function buildReport() {
  const policy = loadPolicy();
  const databasePath = path.join(ROOT, policy.compileDatabase);
  if (!fs.existsSync(databasePath))
    throw new Error(
      `compile database is absent; run ./shifu build:core first (${policy.compileDatabase})`,
    );
  const tool = findTool(policy);
  if (!tool)
    throw new Error(
      `${policy.tool.name} is unavailable; set ${policy.tool.environmentOverride} to the pinned executable`,
    );
  const database = JSON.parse(fs.readFileSync(databasePath, 'utf8'));
  const files = selectTranslationUnits(database, policy);
  if (!files.length) throw new Error('declared C++ safety scope is empty');
  const analysis = await analyze(policy, tool, files);
  const lifetimeInventory = inventoryBoundarySites(policy);
  const diagnosticsByCheck = summarizeDiagnostics(analysis.diagnostics);
  const observed = {
    toolMajor: tool.major,
    scopeFiles: files.length,
    scopeRoot: digest(files),
    diagnostics: analysis.diagnostics.length,
    diagnosticsByCheck,
    diagnosticsRoot: digest(analysis.diagnostics),
  };
  const drift = {
    tool: observed.toolMajor !== policy.baseline.toolMajor,
    scope:
      observed.scopeFiles !== policy.baseline.scopeFiles ||
      observed.scopeRoot !== policy.baseline.scopeRoot,
    diagnostics: observed.diagnosticsRoot !== policy.baseline.diagnosticsRoot,
  };
  const sourceRevision = spawnSync('git', ['rev-parse', 'HEAD^{commit}'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).stdout.trim();
  const baselineRevision = spawnSync(
    'git',
    ['rev-parse', `${policy.baselineRef}^{commit}`],
    { cwd: ROOT, encoding: 'utf8' },
  ).stdout.trim();
  const changedPaths = spawnSync(
    'git',
    ['status', '--short', '--untracked-files=all', '--', ...policy.scopeRoots],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .stdout.trim()
    .split(/\r?\n/u)
    .filter(Boolean);
  const body = {
    schema: 'kungfu.cpp-safety-analysis-report/v1',
    status: 'advisory',
    enforcement: 'tool-and-scope-drift-only',
    sourceRevision,
    sourceState: {
      baselineRevision,
      baselineMatchesPolicy: baselineRevision === policy.baselineRef,
      workingTree: changedPaths.length ? 'modified' : 'clean',
      changedPaths,
      changedPathsRoot: digest(changedPaths),
    },
    policyPath: POLICY_PATH,
    policyRoot: digest(policy),
    tool,
    scope: {
      roots: policy.scopeRoots,
      excludedClasses: policy.excludedClasses,
      files,
      root: observed.scopeRoot,
    },
    baseline: policy.baseline,
    observed,
    drift,
    analysisFailures: analysis.failedFiles,
    diagnostics: analysis.diagnostics,
    lifetimeInventory,
  };
  return { ...body, reportRoot: digest(body) };
}

function qualificationPlan(root = ROOT) {
  const buildRoot = path.join(
    root,
    'framework',
    'core',
    'build',
    'cpp-safety-address-undefined',
  );
  const expression = `^(${SANITIZER_TARGETS.join('|')})$`;
  return {
    sanitizer: 'address-undefined',
    buildRoot,
    targets: [...SANITIZER_TARGETS],
    tests: [...SANITIZER_TARGETS],
    configure: [
      'cmake',
      '-S',
      path.join(root, 'framework', 'core'),
      '-B',
      buildRoot,
      '-G',
      'Ninja',
      `-DCMAKE_TOOLCHAIN_FILE=${path.join(root, 'framework', 'core', 'build', 'conan_toolchain.cmake')}`,
      '-DCMAKE_BUILD_TYPE=Release',
      '-DCMAKE_CXX_SCAN_FOR_MODULES=OFF',
      '-DKUNGFU_BUILD_PROFILE=full',
      '-DKUNGFU_WITH_CORE_TESTS=ON',
      '-DKUNGFU_CORE_SANITIZER=address-undefined',
    ],
    build: [
      'cmake',
      '--build',
      buildRoot,
      '--target',
      ...SANITIZER_TARGETS,
      '--parallel',
      String(Math.min(os.availableParallelism(), 20)),
    ],
    ctest: [
      'ctest',
      '--test-dir',
      buildRoot,
      '-R',
      expression,
      '--output-on-failure',
    ],
    watcher: [
      process.execPath,
      '--test',
      path.join(
        root,
        'framework',
        'core',
        'tests',
        'watcher-runtime-boundary.test.js',
      ),
    ],
  };
}

function runQualificationStep(step, command, args, environment) {
  process.stdout.write(`cpp-safety qualification: ${step}\n`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${step} failed with exit ${result.status ?? 'unknown'}`);
}

function gitOutput(...args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function runQualification(argv) {
  const unknown = argv.filter((arg) => arg !== '--json');
  if (unknown.length) throw new Error(`unknown argument '${unknown[0]}'`);
  const plan = qualificationPlan();
  const toolchain = path.join(CORE, 'build', 'conan_toolchain.cmake');
  if (!fs.existsSync(toolchain))
    throw new Error(
      'Core Conan toolchain is absent; run ./shifu build:core first',
    );

  const environment = {
    ...process.env,
    KUNGFU_BUILD_SKIP_KUNGFU_NODE: 'on',
    KUNGFU_BUILD_SKIP_PYKUNGFU: 'on',
    ASAN_OPTIONS: `abort_on_error=1:detect_leaks=${process.platform === 'darwin' ? '0' : '1'}`,
    UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1',
  };
  runQualificationStep(
    'configure ASan/UBSan build',
    plan.configure[0],
    plan.configure.slice(1),
    environment,
  );
  runQualificationStep(
    'build representative native targets',
    plan.build[0],
    plan.build.slice(1),
    environment,
  );
  runQualificationStep(
    'run representative native targets',
    plan.ctest[0],
    plan.ctest.slice(1),
    environment,
  );

  // This is the supported TSAN-equivalent tier for the Node watcher: the real
  // addon runs concurrent process-isolated start/stop, coordinator down/up
  // reconnect, and environment-exit cleanup. It is independent of the
  // ASan/UBSan CTest build above and requires zero bridge failures.
  runQualificationStep(
    'run watcher lifecycle race equivalent',
    plan.watcher[0],
    plan.watcher.slice(1),
    process.env,
  );

  const workingTree = gitOutput(
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  );
  const body = {
    schema: 'kungfu.cpp-safety-qualification/v1',
    status: 'passed',
    sourceRevision: gitOutput('rev-parse', 'HEAD^{commit}'),
    sourceTree: workingTree ? null : gitOutput('rev-parse', 'HEAD^{tree}'),
    sourceState: workingTree ? 'modified' : 'clean',
    workingTreeRoot: digest(workingTree),
    sanitizer: {
      profile: plan.sanitizer,
      targets: plan.targets,
      environment: {
        asan: environment.ASAN_OPTIONS,
        ubsan: environment.UBSAN_OPTIONS,
      },
    },
    watcherRaceEquivalent: {
      status: 'passed',
      model: 'real-addon-process-isolated-concurrent-lifecycle-and-reconnect',
      covers: [
        'start-stop',
        'concurrent-exit',
        'coordinator-reconnect',
        'addon-environment-exit',
      ],
      invariant:
        'accepted bridge callbacks own their payload and all observed bridge failure counts remain zero',
    },
  };
  const report = { ...body, reportRoot: digest(body) };
  process.stdout.write(
    `${JSON.stringify(report, null, argv.includes('--json') ? 2 : 0)}\n`,
  );
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--qualify')) {
    runQualification(argv.filter((arg) => arg !== '--qualify'));
    return;
  }
  const json = argv.includes('--json');
  const unknown = argv.filter((arg) => !['--json', '--check'].includes(arg));
  if (unknown.length) throw new Error(`unknown argument '${unknown[0]}'`);
  const report = await buildReport();
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else
    process.stdout.write(
      `cpp-safety: ${report.observed.scopeFiles} translation units, ${report.observed.diagnostics} advisory diagnostics, root ${report.reportRoot}\n`,
    );
  if (
    report.tool.major !== report.baseline.toolMajor ||
    !report.sourceState.baselineMatchesPolicy ||
    report.drift.scope ||
    report.analysisFailures.length ||
    report.lifetimeInventory.unclassified.length
  )
    process.exitCode = 2;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `cpp-safety: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
}

export {
  SANITIZER_TARGETS,
  buildReport,
  digest,
  findTool,
  inventoryBoundarySites,
  parseDiagnostics,
  qualificationPlan,
  selectTranslationUnits,
  summarizeDiagnostics,
};
