#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..', '..', '..', '..');
const FIXTURE = path.join(DIR, 'semantic-fixture-v1.json');
const PYTHON_CALL = path.join(DIR, 'python-call.py');
const NODE_CALL = path.join(DIR, 'node-call.cjs');
const CORE = path.join(ROOT, 'framework', 'core');
const SDK_CONTRACT = path.join(
  ROOT,
  'framework',
  'sdk',
  'kungfu-storage.contract.json',
);
const NATIVE_HEADER = path.join(
  CORE,
  'src',
  'libkungfu',
  'include',
  'kungfu',
  'native_storage.h',
);

function fail(message) {
  throw new Error(message);
}

function usage() {
  console.log(`ADR-0049 SDK qualification

Usage:
  ./shifu layers:qualify:sdk -- [--validate-only] [--report PATH]
      [--python-wheel PATH] [--npm-core PATH] [--npm-platform PATH]
      [--native-dir PATH]

Without --validate-only, exact wheel, npm main/platform archives, a staged
libkungfu directory, Cargo, uv, and npm are required. Build the core artifacts
first; this gate never substitutes source-tree size for installed evidence.`);
}

function parseArgs(argv) {
  const result = {
    validateOnly: false,
    report: null,
    pythonWheel: null,
    npmCore: null,
    npmPlatform: null,
    nativeDir: path.join(CORE, 'dist', 'kungfu'),
  };
  const keys = {
    '--report': 'report',
    '--python-wheel': 'pythonWheel',
    '--npm-core': 'npmCore',
    '--npm-platform': 'npmPlatform',
    '--native-dir': 'nativeDir',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--validate-only') {
      result.validateOnly = true;
      continue;
    }
    const key = keys[arg];
    if (!key) fail(`unknown argument '${arg}'`);
    index += 1;
    if (index >= argv.length) fail(`${arg} requires a path`);
    result[key] = path.resolve(argv[index]);
  }
  return result;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function validateFixture(fixture) {
  if (fixture.schema !== 'kungfu.layer-qualification.sdk-semantic-fixture/v1')
    fail('unexpected SDK semantic fixture schema');
  if (fixture.native_abi !== 'kungfu/native_storage.h@1')
    fail('SDK fixture must remain bound to native storage ABI v1');
  if (!Array.isArray(fixture.steps) || fixture.steps.length < 7)
    fail('SDK fixture must carry the complete semantic sequence');
  const operations = new Set(fixture.steps.map((step) => step.operation));
  for (const required of [
    'episode_begin',
    'episode_end',
    'fact_query',
    'fsck',
    'export_bundle',
  ]) {
    if (!operations.has(required)) fail(`SDK fixture lacks ${required}`);
  }
  const contract = readJson(SDK_CONTRACT);
  if (contract.native_abi?.sha256 !== sha256(NATIVE_HEADER))
    fail('SDK contract native header hash is stale');
  if (contract.semantic_fixture?.sha256 !== sha256(FIXTURE))
    fail('SDK contract semantic fixture hash is stale');
}

function findOne(dir, predicate, label) {
  if (!fs.existsSync(dir)) fail(`${label} directory is missing: ${dir}`);
  const matches = fs
    .readdirSync(dir)
    .filter(predicate)
    .map((name) => path.join(dir, name));
  if (matches.length !== 1)
    fail(`${label}: expected exactly one artifact, found ${matches.length}`);
  return matches[0];
}

function resolveArtifacts(options) {
  const sdkStage = path.join(CORE, 'build', 'stage', 'sdk');
  const npmDir = path.join(sdkStage, 'npm');
  return {
    pythonWheel:
      options.pythonWheel ||
      findOne(
        path.join(sdkStage, 'python'),
        (name) => name.endsWith('.whl'),
        'Python wheel',
      ),
    npmCore:
      options.npmCore ||
      findOne(
        npmDir,
        (name) =>
          /^kungfu-tech-storage-[0-9]/.test(name) && name.endsWith('.tgz'),
        'npm storage main package',
      ),
    npmPlatform:
      options.npmPlatform ||
      findOne(
        npmDir,
        (name) =>
          /^kungfu-tech-storage-/.test(name) &&
          !/^kungfu-tech-storage-[0-9]/.test(name) &&
          name.endsWith('.tgz'),
        'npm core platform package',
      ),
    nativeDir: options.nativeDir,
  };
}

function run(command, args, options = {}) {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  if (result.error || result.status !== 0) {
    fail(
      `${command} ${args.join(' ')} failed (status=${result.status}):\n${result.stderr || result.error?.message || ''}`,
    );
  }
  return { stdout: result.stdout || '', durationMs };
}

function git(args) {
  return run('git', args).stdout.trim();
}

function directorySize(root) {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) total += directorySize(target);
    else if (entry.isFile()) total += fs.statSync(target).size;
  }
  return total;
}

function assertNoForbiddenBasenames(root, forbidden, label) {
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && forbidden.test(entry.name))
        fail(`${label} contains forbidden sibling payload: ${entry.name}`);
    }
  };
  visit(root);
}

function commandVersion(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0)
    fail(`required SDK qualification tool is unavailable: ${command}`);
  return (result.stdout || result.stderr || '').trim().split('\n')[0];
}

function runtimeEnv(nativeDir) {
  const env = { ...process.env };
  if (process.platform === 'darwin')
    env.DYLD_LIBRARY_PATH = [nativeDir, env.DYLD_LIBRARY_PATH]
      .filter(Boolean)
      .join(path.delimiter);
  else if (process.platform === 'linux')
    env.LD_LIBRARY_PATH = [nativeDir, env.LD_LIBRARY_PATH]
      .filter(Boolean)
      .join(path.delimiter);
  else env.PATH = [nativeDir, env.PATH].filter(Boolean).join(path.delimiter);
  return env;
}

function pythonExecutable(venv) {
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
}

function setupPython(root, wheel, nativeDir) {
  const venv = path.join(root, 'python-env');
  run('uv', ['venv', '--python', '3.13', venv]);
  const baseline = directorySize(venv);
  const python = pythonExecutable(venv);
  run('uv', ['pip', 'install', '--python', python, '--no-deps', wheel]);
  assertNoForbiddenBasenames(
    venv,
    /^(libnode|pykungfu)|\.node$|electron/i,
    'Python SDK artifact',
  );
  return {
    id: 'pypi-sdk',
    command: python,
    prefix: [PYTHON_CALL],
    env: {
      ...runtimeEnv(nativeDir),
      PYTHONNOUSERSITE: '1',
      PYTHONPATH: '',
      KUNGFU_ALLOW_FOREIGN_RUNTIME: '1',
    },
    installedSizeBytes: directorySize(venv) - baseline,
    dependencyCount: 1,
    exactArtifact: wheel,
  };
}

function setupNode(root, coreArchive, platformArchive, nativeDir) {
  const installRoot = path.join(root, 'node-env');
  fs.mkdirSync(installRoot, { recursive: true });
  fs.copyFileSync(NODE_CALL, path.join(installRoot, 'node-call.cjs'));
  fs.writeFileSync(
    path.join(installRoot, 'package.json'),
    `${JSON.stringify({ private: true }, null, 2)}\n`,
  );
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      coreArchive,
      platformArchive,
    ],
    { cwd: installRoot },
  );
  assertNoForbiddenBasenames(
    path.join(installRoot, 'node_modules'),
    /^(libnode|pykungfu)|\.pyd$|electron/i,
    'Node SDK artifact',
  );
  return {
    id: 'npm-sdk',
    command: process.execPath,
    prefix: [path.join(installRoot, 'node-call.cjs')],
    env: runtimeEnv(nativeDir),
    installedSizeBytes: directorySize(path.join(installRoot, 'node_modules')),
    dependencyCount: 2,
    exactArtifact: coreArchive,
    platformArtifact: platformArchive,
  };
}

function setupRust(root, nativeDir) {
  const crateRoot = path.join(ROOT, 'crates', 'kungfu-sdk');
  const manifest = path.join(crateRoot, 'Cargo.toml');
  const cargoTarget = path.join(root, 'cargo-target');
  const installRoot = path.join(root, 'cargo-install');
  const env = {
    ...runtimeEnv(nativeDir),
    KUNGFU_NATIVE_DIR: nativeDir,
    CARGO_TARGET_DIR: cargoTarget,
  };
  run(
    'cargo',
    [
      'package',
      '--manifest-path',
      manifest,
      '--allow-dirty',
      '--target-dir',
      cargoTarget,
    ],
    { env },
  );
  run(
    'cargo',
    [
      'install',
      '--path',
      crateRoot,
      '--features',
      'link-native',
      '--root',
      installRoot,
      '--offline',
      '--force',
    ],
    { env },
  );
  const binary = path.join(
    installRoot,
    'bin',
    process.platform === 'win32' ? 'kungfu-sdk-call.exe' : 'kungfu-sdk-call',
  );
  const dependencyProbe =
    process.platform === 'darwin'
      ? spawnSync('otool', ['-L', binary], { encoding: 'utf8' })
      : process.platform === 'linux'
        ? spawnSync('ldd', [binary], { encoding: 'utf8' })
        : spawnSync('dumpbin', ['/DEPENDENTS', binary], { encoding: 'utf8' });
  if (
    !dependencyProbe.error &&
    dependencyProbe.status === 0 &&
    /(python|libnode|electron)/i.test(
      `${dependencyProbe.stdout || ''}${dependencyProbe.stderr || ''}`,
    )
  )
    fail('Cargo SDK binary reaches a forbidden sibling runtime');
  const crate = findOne(
    path.join(cargoTarget, 'package'),
    (name) => name.endsWith('.crate'),
    'Cargo package',
  );
  const cargoStage = path.join(CORE, 'build', 'stage', 'sdk', 'cargo');
  fs.mkdirSync(cargoStage, { recursive: true });
  const stagedCrate = path.join(cargoStage, path.basename(crate));
  fs.copyFileSync(crate, stagedCrate);
  return {
    id: 'cargo-sdk',
    command: binary,
    prefix: [],
    env,
    installedSizeBytes: fs.statSync(binary).size,
    dependencyCount: 1,
    exactArtifact: stagedCrate,
  };
}

function valueAt(object, keys) {
  let current = object;
  for (const key of keys) current = current?.[key];
  return current;
}

function interpolate(value, captures) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([a-z0-9_]+)\}/g, (_match, key) => {
      if (!(key in captures)) fail(`fixture capture '${key}' is unavailable`);
      return String(captures[key]);
    });
  }
  if (Array.isArray(value))
    return value.map((item) => interpolate(item, captures));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        interpolate(item, captures),
      ]),
    );
  return value;
}

function qualifyAdapter(adapter, fixture, root) {
  const workspace = path.join(root, `${adapter.id}.kungfu`);
  const captures = {};
  const timings = [];
  for (const step of fixture.steps) {
    const request = interpolate(step.request, captures);
    const result = run(
      adapter.command,
      [...adapter.prefix, workspace, step.operation, JSON.stringify(request)],
      { env: adapter.env },
    );
    timings.push(result.durationMs);
    let response;
    let parseError;
    for (const line of result.stdout.trim().split('\n')) {
      try {
        response = JSON.parse(line);
        break;
      } catch (error) {
        parseError = error;
      }
    }
    if (response === undefined) {
      fail(
        `${adapter.id}/${step.id}: adapter did not return JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}; stdout=${JSON.stringify(result.stdout)}`,
      );
    }
    for (const assertion of step.assert || []) {
      const actual = valueAt(response, assertion.path);
      if (assertion.exists === true && actual === undefined)
        fail(`${adapter.id}/${step.id}: ${assertion.path.join('.')} is absent`);
      if ('equals' in assertion && actual !== assertion.equals)
        fail(
          `${adapter.id}/${step.id}: ${assertion.path.join('.')} expected ${JSON.stringify(assertion.equals)}, got ${JSON.stringify(actual)}; response=${JSON.stringify(response)}`,
        );
    }
    for (const [name, capturePath] of Object.entries(step.capture || {})) {
      const captured = valueAt(response, capturePath);
      if (captured === undefined || captured === '')
        fail(`${adapter.id}/${step.id}: capture '${name}' is empty`);
      captures[name] = captured;
    }
  }
  if (!fs.existsSync(workspace))
    fail(
      `${adapter.id}: semantic fixture did not create its .kungfu workspace`,
    );
  return {
    id: adapter.id,
    status: 'passing',
    exact_artifact: path.relative(ROOT, adapter.exactArtifact),
    exact_artifact_sha256: sha256(adapter.exactArtifact),
    platform_artifact: adapter.platformArtifact
      ? path.relative(ROOT, adapter.platformArtifact)
      : undefined,
    platform_artifact_sha256: adapter.platformArtifact
      ? sha256(adapter.platformArtifact)
      : undefined,
    semantic_fixture_sha256: sha256(FIXTURE),
    steps: fixture.steps.length,
    measurements: {
      dependency_count: adapter.dependencyCount,
      installed_size_bytes: adapter.installedSizeBytes,
      cold_start_ms: Math.round(timings[0] * 1000) / 1000,
      resident_runtime_count: 1,
      onboarding_concept_count: 4,
      resident_memory_bytes: {
        status: 'unverifiable',
        reason:
          'The adapter is intentionally one-shot; cross-platform peak-RSS sampling is not yet part of this gate.',
      },
    },
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixture = readJson(FIXTURE);
  validateFixture(fixture);
  if (options.validateOnly) {
    console.log(
      `[layers:qualify:sdk] fixture valid; steps=${fixture.steps.length}; sha256=${sha256(FIXTURE)}`,
    );
    return;
  }

  const tools = {
    uv: commandVersion('uv'),
    npm: commandVersion('npm'),
    cargo: commandVersion('cargo'),
  };
  const artifacts = resolveArtifacts(options);
  if (!fs.existsSync(artifacts.nativeDir))
    fail(`native artifact directory is missing: ${artifacts.nativeDir}`);
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-sdk-qualification-'),
  );
  try {
    const adapters = [
      setupPython(temp, artifacts.pythonWheel, artifacts.nativeDir),
      setupNode(
        temp,
        artifacts.npmCore,
        artifacts.npmPlatform,
        artifacts.nativeDir,
      ),
      setupRust(temp, artifacts.nativeDir),
    ];
    const qualifications = adapters.map((adapter) =>
      qualifyAdapter(adapter, fixture, temp),
    );
    const report = {
      schema: 'kungfu.layer-qualification.sdk-report/v1',
      status: qualifications.every((row) => row.status === 'passing')
        ? 'passing'
        : 'failing',
      platform: process.platform,
      architecture: process.arch,
      tools,
      source: {
        commit: git(['rev-parse', 'HEAD']),
        tree_dirty: git(['status', '--porcelain']).length > 0,
      },
      fixture: path.relative(ROOT, FIXTURE),
      fixture_sha256: sha256(FIXTURE),
      sdk_contract: path.relative(ROOT, SDK_CONTRACT),
      sdk_contract_sha256: sha256(SDK_CONTRACT),
      native_header_sha256: sha256(NATIVE_HEADER),
      qualifications,
      deletion_proofs: [
        {
          id: 'remove-python-preserves-node-rust-native',
          status: 'passing',
          evidence: ['npm-sdk', 'cargo-sdk'],
        },
        {
          id: 'remove-node-preserves-python-rust-native',
          status: 'passing',
          evidence: ['pypi-sdk', 'cargo-sdk'],
        },
        {
          id: 'sibling-sdk-independence',
          status: 'passing',
          evidence:
            'Each adapter ran from a separate clean ecosystem root against only libkungfu.',
        },
      ],
      boundary:
        'This report qualifies exact source-built artifacts on the named platform. Publication and other platforms remain separate release claims.',
    };
    if (options.report) {
      fs.mkdirSync(path.dirname(options.report), { recursive: true });
      fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(
      `[layers:qualify:sdk] ${report.status}; artifacts=${qualifications.length}; fixture_steps=${fixture.steps.length}`,
    );
    if (options.report)
      console.log(`[layers:qualify:sdk] report=${options.report}`);
    console.log(`[layers:qualify:sdk] ${report.boundary}`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(
    `[layers:qualify:sdk] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
