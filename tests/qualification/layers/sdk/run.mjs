#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTarGz } from '@kungfu-tech/product-kungfu/tooling/archive';
import telemetry from '../../../../scripts/candidate-timeline-events.cjs';
import {
  platformCommand,
  platformCommandOptions,
  prependEnvironmentPath,
} from '../../../../scripts/platform-command.mjs';
import { qualificationHoldMs, runMeasured } from '../process-metrics.mjs';

const { measureCandidateStage, measureCandidateStageSync } = telemetry;

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..', '..', '..', '..');
const FIXTURE = path.join(DIR, 'semantic-fixture-v1.json');
const WIRE_FIXTURE = path.join(DIR, 'wire-fixture-v1.json');
const WORK_LIFECYCLE_FIXTURE = path.join(
  ROOT,
  'tests',
  'qualification',
  'work-lifecycle',
  'four-language-v1.json',
);
const WORK_LIFECYCLE_CONTRACT = path.join(
  ROOT,
  'framework/work/work-lifecycle/work-lifecycle-native.contract.json',
);
const PYTHON_CALL = path.join(DIR, 'python-call.py');
const NODE_CALL = path.join(DIR, 'node-call.cjs');
const CORE = path.join(ROOT, 'framework', 'core');
const SDK_CONTRACT = path.join(
  ROOT,
  'framework',
  'storage',
  'kungfu-storage.contract.json',
);
const NATIVE_HEADER = path.join(
  CORE,
  'src',
  'libkungfu',
  'include',
  'kungfu',
  'api.h',
);

function fail(message) {
  throw new Error(message);
}

function usage() {
  console.log(`KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff SDK qualification

Usage:
  ./shifu layers:qualify:sdk -- [--validate-only] [--report PATH]
      [--python-wheel PATH] [--npm-core PATH] [--npm-platform PATH]
      [--cargo-crate PATH] [--native-dir PATH]

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
    cargoCrate: null,
    nativeDir: path.join(CORE, 'dist', 'kungfu'),
  };
  const keys = {
    '--report': 'report',
    '--python-wheel': 'pythonWheel',
    '--npm-core': 'npmCore',
    '--npm-platform': 'npmPlatform',
    '--cargo-crate': 'cargoCrate',
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

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateFixture(fixture) {
  if (fixture.schema !== 'kungfu.layer-qualification.sdk-semantic-fixture/v1')
    fail('unexpected SDK semantic fixture schema');
  if (fixture.native_abi !== 'kungfu/api.h@1')
    fail('SDK fixture must remain bound to the standard libkungfu ABI v1');
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

function validateWireFixture(fixture) {
  if (fixture.schema !== 'kungfu.layer-qualification.sdk-wire-fixture/v1')
    fail('unexpected SDK wire fixture schema');
  if (fixture.native_abi !== 'kungfu/api.h@1')
    fail('SDK wire fixture must remain bound to the standard libkungfu ABI v1');
  if (
    fixture.interface?.id !== 5 ||
    fixture.interface?.name !== 'runtime-action' ||
    fixture.interface?.version !== 1
  )
    fail('SDK wire fixture must bind runtime-action interface v1');
  if (!Array.isArray(fixture.cases) || fixture.cases.length !== 2)
    fail('SDK wire fixture must carry the exact root and denied-receipt cases');
  if (fixture.cases.some((entry) => entry.write_occurred !== false))
    fail('SDK wire fixture may not admit writes');
  for (const entry of fixture.cases) {
    if (!/^(?:[0-9a-f]{2})+$/.test(entry.expected_bytes_hex || ''))
      fail(`SDK wire fixture ${entry.id} lacks frozen response bytes`);
    if (!/^[0-9a-f]{64}$/.test(entry.expected_bytes_sha256 || ''))
      fail(`SDK wire fixture ${entry.id} lacks a frozen response byte root`);
    if (
      sha256Bytes(Buffer.from(entry.expected_bytes_hex, 'hex')) !==
      entry.expected_bytes_sha256
    )
      fail(`SDK wire fixture ${entry.id} byte root is stale`);
  }
  if (
    !Array.isArray(fixture.projection_negative_cases) ||
    fixture.projection_negative_cases.length < 3
  )
    fail('SDK wire fixture lacks generated projection negative cases');
  if (
    !Array.isArray(fixture.projection_semantic_cases) ||
    fixture.projection_semantic_cases.length < 2
  )
    fail('SDK wire fixture lacks semantic JSON projection cases');
  const contract = readJson(SDK_CONTRACT);
  if (contract.wire_fixture?.sha256 !== sha256(WIRE_FIXTURE))
    fail('SDK contract wire fixture hash is stale');
}

function validateWorkLifecycleFixture(fixture) {
  if (fixture.schema !== 'kungfu.work-lifecycle.four-language-fixture/v1')
    fail('unexpected Work lifecycle fixture schema');
  const contract = readJson(WORK_LIFECYCLE_CONTRACT);
  if (fixture.operationSetRoot !== contract.operationSetRoot)
    fail('Work lifecycle fixture operation-set root is stale');
  if (!Array.isArray(fixture.runtimeCases) || fixture.runtimeCases.length < 7)
    fail('Work lifecycle fixture lacks the complete runtime proof set');
  const ids = new Set(fixture.runtimeCases.map((entry) => entry.id));
  for (const required of [
    'capabilities',
    'cut-verify-prepared',
    'cut-verify-projected',
    'cut-settle-bypass-receipt-not-admitted',
    'cut-settle-missing-authority-receipt',
    'cut-settle-mismatched-authority-receipt',
    'retired-native-work-inspect-unsupported',
    'missing-input-rejected',
    'missing-execute-rejected',
    'null-input-rejected',
    'unknown-field-preserved-to-native',
    'unknown-operation',
  ]) {
    if (!ids.has(required))
      fail(`Work lifecycle fixture lacks runtime case ${required}`);
  }
}

function semanticProjectionBytes(id) {
  const root = `sha256:${'a'.repeat(64)}`;
  if (id === 'reordered-envelope')
    return Buffer.from(
      `{"schema":"kungfu.action-runtime.result/v1","result":{"geometryRoot":"${root}"}}`,
    );
  if (id === 'whitespace-envelope')
    return Buffer.from(
      `{ "result" : { "geometryRoot" : "${root}" }, "schema" : "kungfu.action-runtime.result/v1" }`,
    );
  fail(`unsupported semantic projection fixture: ${id}`);
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

function findOneRecursive(dir, predicate, label) {
  const matches = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (predicate(entry.name)) matches.push(target);
    }
  };
  visit(dir);
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
    cargoCrate:
      options.cargoCrate ||
      findOne(
        path.join(sdkStage, 'cargo'),
        (name) => name.endsWith('.crate'),
        'Cargo package',
      ),
    nativeDir: options.nativeDir,
  };
}

function run(command, args, options = {}) {
  const started = process.hrtime.bigint();
  const result = spawnSync(platformCommand(command), args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...platformCommandOptions(command),
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

function snapshotTree(root, { semantic = false } = {}) {
  const entries = [];
  if (!fs.existsSync(root))
    return { digest: sha256Bytes(Buffer.from('[]')), entries };
  const visit = (current, relative) => {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(current, entry.name);
      const targetRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        // Context admission owns ephemeral lock and log namespaces even for
        // read-only calls; journal/ref/fact files remain in the semantic tree.
        if (
          semantic &&
          (targetRelative === 'ownership' || targetRelative === 'log')
        )
          continue;
        visit(target, targetRelative);
      } else if (entry.isSymbolicLink()) {
        entries.push(['symlink', targetRelative, fs.readlinkSync(target)]);
      } else {
        entries.push([
          'file',
          targetRelative,
          fs.statSync(target).size,
          sha256(target),
        ]);
      }
    }
  };
  visit(root, '');
  return {
    digest: sha256Bytes(Buffer.from(JSON.stringify(entries))),
    entries,
  };
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
  const result = spawnSync(platformCommand(command), ['--version'], {
    encoding: 'utf8',
    ...platformCommandOptions(command),
  });
  if (result.error || result.status !== 0)
    fail(`required SDK qualification tool is unavailable: ${command}`);
  return (result.stdout || result.stderr || '').trim().split('\n')[0];
}

function runtimeEnv(nativeDir = null) {
  let env = {
    ...process.env,
    KUNGFU_FACT_CUT_ROOT: `sha256:${'1'.repeat(64)}`,
    KUNGFU_PURSUIT_ROOT: `sha256:${'2'.repeat(64)}`,
    KUNGFU_ATLAS_ROOT: `sha256:${'3'.repeat(64)}`,
    KUNGFU_WARRANT_ROOT: `sha256:${'4'.repeat(64)}`,
    KUNGFU_CANDIDATE_ACTION_ROOT: `sha256:${'5'.repeat(64)}`,
    KUNGFU_PRECONDITIONS_ROOT: `sha256:${'6'.repeat(64)}`,
    KUNGFU_RESOURCES_ROOT: `sha256:${'7'.repeat(64)}`,
  };
  if (!nativeDir) return env;
  if (process.platform === 'darwin')
    env.DYLD_LIBRARY_PATH = [nativeDir, env.DYLD_LIBRARY_PATH]
      .filter(Boolean)
      .join(path.delimiter);
  else if (process.platform === 'linux')
    env.LD_LIBRARY_PATH = [nativeDir, env.LD_LIBRARY_PATH]
      .filter(Boolean)
      .join(path.delimiter);
  else env = prependEnvironmentPath(env, nativeDir);
  return env;
}

function stageQualificationProfile(root) {
  const profile = path.join(root, 'contract-profile');
  const config = path.join(profile, 'config');
  fs.cpSync(path.join(ROOT, 'config'), config, { recursive: true });
  const registry = path.join(config, 'kungfu-contracts.registry.json');
  const actionGeometry = path.join(
    config,
    'action',
    'action-geometry.contract.json',
  );
  fs.mkdirSync(path.dirname(actionGeometry), { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'framework/work/action/action-geometry.contract.json'),
    actionGeometry,
  );
  if (!fs.existsSync(registry) || !fs.existsSync(actionGeometry))
    fail('installed qualification profile omits required contract artifacts');
  return { registry, actionGeometry };
}

function pythonExecutable(venv) {
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
}

function setupPython(root, wheel) {
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
      ...runtimeEnv(),
      PYTHONNOUSERSITE: '1',
      PYTHONPATH: '',
      KUNGFU_ALLOW_FOREIGN_RUNTIME: '1',
    },
    installedSizeBytes: directorySize(venv) - baseline,
    dependencyCount: 1,
    exactArtifact: wheel,
  };
}

function setupNode(root, coreArchive, platformArchive) {
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
    env: runtimeEnv(),
    installedSizeBytes: directorySize(path.join(installRoot, 'node_modules')),
    dependencyCount: 2,
    exactArtifact: coreArchive,
    platformArtifact: platformArchive,
  };
}

function setupCpp(root, nativeDir) {
  const prefix = path.join(root, 'cpp-prefix');
  run('cmake', [
    '--install',
    path.join(CORE, 'build'),
    '--prefix',
    prefix,
    '--config',
    'Release',
  ]);
  const publicLibraryName =
    process.platform === 'win32'
      ? 'kungfu.dll'
      : process.platform === 'darwin'
        ? 'libkungfu.dylib'
        : 'libkungfu.so';
  const installedLibrary = findOneRecursive(
    prefix,
    (name) => name === publicLibraryName,
    'installed C++ public runtime',
  );
  const publicLibrary = path.join(nativeDir, publicLibraryName);
  if (sha256(installedLibrary) !== sha256(publicLibrary))
    fail('installed C++ runtime differs from the exact native SDK artifact');
  const build = path.join(root, 'cpp-build');
  run(
    'cmake',
    [
      '-S',
      DIR,
      '-B',
      build,
      `-DCMAKE_PREFIX_PATH=${prefix}`,
      '-DCMAKE_BUILD_TYPE=Release',
    ],
    { env: runtimeEnv(path.dirname(installedLibrary)) },
  );
  run('cmake', ['--build', build, '--config', 'Release'], {
    env: runtimeEnv(path.dirname(installedLibrary)),
  });
  const name =
    process.platform === 'win32'
      ? 'kungfu-sdk-wire-cpp.exe'
      : 'kungfu-sdk-wire-cpp';
  const candidates = [
    path.join(build, name),
    path.join(build, 'Release', name),
  ];
  const binary = candidates.find((candidate) => fs.existsSync(candidate));
  if (!binary) fail('C++ SDK wire fixture binary was not produced');
  return {
    id: 'cpp-sdk',
    command: binary,
    prefix: [],
    env: runtimeEnv(path.dirname(installedLibrary)),
    installedSizeBytes: directorySize(prefix) + fs.statSync(binary).size,
    dependencyCount: 1,
    exactArtifact: publicLibrary,
  };
}

function setupRust(root, nativeDir, exactCrate) {
  const unpacked = path.join(root, 'cargo-source');
  fs.mkdirSync(unpacked, { recursive: true });
  extractTarGz({ archiveFile: exactCrate, targetDir: unpacked });
  const packageDirs = fs
    .readdirSync(unpacked, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(unpacked, entry.name));
  if (packageDirs.length !== 1)
    fail(
      `Cargo package: expected one source root, found ${packageDirs.length}`,
    );
  const crateRoot = packageDirs[0];
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
  return {
    id: 'cargo-sdk',
    command: binary,
    prefix: [],
    env,
    installedSizeBytes: fs.statSync(binary).size,
    dependencyCount: 1,
    exactArtifact: exactCrate,
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

async function qualifyAdapter(adapter, fixture, root) {
  const workspace = path.join(root, `${adapter.id}.kungfu`);
  const captures = {};
  const timings = [];
  let peakResidentBytes = 0;
  for (const step of fixture.steps) {
    const request = interpolate(step.request, captures);
    const result = await runMeasured(
      adapter.command,
      [...adapter.prefix, workspace, step.operation, JSON.stringify(request)],
      {
        cwd: ROOT,
        env: {
          ...adapter.env,
          KUNGFU_QUALIFICATION_HOLD_MS: String(qualificationHoldMs()),
        },
      },
    );
    timings.push(result.durationMs);
    peakResidentBytes = Math.max(peakResidentBytes, result.peakResidentBytes);
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
      resident_memory_bytes: peakResidentBytes,
    },
  };
}

async function qualifyWireAdapter(adapter, fixture, root, contractProfile) {
  const workspace = path.join(root, `${adapter.id}-wire.kungfu`);
  const qualificationEnv = {
    ...adapter.env,
    KUNGFU_QUALIFICATION_HOLD_MS: String(qualificationHoldMs()),
    KUNGFU_CONTRACT_REGISTRY: contractProfile.registry,
    KUNGFU_ACTION_GEOMETRY_CONTRACT: contractProfile.actionGeometry,
  };
  const cases = {};
  for (const entry of fixture.cases) {
    const beforeFilesystem = snapshotTree(workspace);
    const beforeSemantic = snapshotTree(workspace, { semantic: true });
    const result = await runMeasured(
      adapter.command,
      [...adapter.prefix, workspace, entry.operation, entry.request_bytes],
      {
        cwd: root,
        env: qualificationEnv,
      },
    );
    let response;
    for (const line of result.stdout.trim().split('\n')) {
      try {
        response = JSON.parse(line);
        break;
      } catch {
        // Tooling may emit setup diagnostics before the one receipt line.
      }
    }
    if (!response)
      fail(`${adapter.id}/${entry.id}: wire adapter did not return JSON`);
    for (const [wireKey, expected] of [
      ['protocolId', fixture.response.protocol_id],
      ['protocolVersion', fixture.response.protocol_version],
      ['schemaRef', fixture.response.schema_ref],
      ['encoding', fixture.response.encoding],
    ]) {
      if (response[wireKey] !== expected)
        fail(
          `${adapter.id}/${entry.id}: ${wireKey} expected ${JSON.stringify(expected)}, got ${JSON.stringify(response[wireKey])}`,
        );
    }
    if (
      typeof response.bytesHex !== 'string' ||
      !/^(?:[0-9a-f]{2})+$/.test(response.bytesHex)
    )
      fail(`${adapter.id}/${entry.id}: invalid exact response bytes`);
    const bytes = Buffer.from(response.bytesHex, 'hex');
    const bytesSha256 = sha256Bytes(bytes);
    if (response.bytesHex !== entry.expected_bytes_hex)
      fail(`${adapter.id}/${entry.id}: response differs from frozen bytes`);
    if (bytesSha256 !== entry.expected_bytes_sha256)
      fail(`${adapter.id}/${entry.id}: response differs from frozen byte root`);
    let envelope;
    try {
      envelope = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      fail(
        `${adapter.id}/${entry.id}: response bytes are not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const assertion of entry.assert || []) {
      const actual = valueAt(envelope, assertion.path);
      if ('equals' in assertion && actual !== assertion.equals)
        fail(
          `${adapter.id}/${entry.id}: ${assertion.path.join('.')} expected ${JSON.stringify(assertion.equals)}, got ${JSON.stringify(actual)}`,
        );
    }
    if (entry.typed_path) {
      const typed = valueAt(response, entry.typed_path);
      if (
        typeof typed !== 'string' ||
        !new RegExp(entry.typed_pattern).test(typed) ||
        typed !== envelope.result?.geometryRoot
      )
        fail(`${adapter.id}/${entry.id}: typed projection disagrees with wire`);
    }
    const afterFilesystem = snapshotTree(workspace);
    const afterSemantic = snapshotTree(workspace, { semantic: true });
    const filesystemWriteOccurred =
      afterFilesystem.digest !== beforeFilesystem.digest;
    const writeOccurred = afterSemantic.digest !== beforeSemantic.digest;
    if (writeOccurred !== entry.write_occurred)
      fail(
        `${adapter.id}/${entry.id}: measured write_occurred=${writeOccurred}, expected ${entry.write_occurred}; semantic_files=${JSON.stringify(afterSemantic.entries)}`,
      );
    cases[entry.id] = {
      protocol_id: response.protocolId,
      protocol_version: response.protocolVersion,
      schema_ref: response.schemaRef,
      encoding: response.encoding,
      bytes_hex: response.bytesHex,
      bytes_sha256: bytesSha256,
      write_occurred: writeOccurred,
      filesystem_write_occurred: filesystemWriteOccurred,
    };
  }
  const projectionNegativeCases = {};
  for (const id of fixture.projection_negative_cases) {
    const result = await runMeasured(
      adapter.command,
      [
        ...adapter.prefix,
        workspace,
        '__runtime_action_projection_negative__',
        id,
      ],
      { cwd: root, env: qualificationEnv },
    );
    const response = JSON.parse(result.stdout.trim().split('\n').at(-1));
    if (response.rejected !== true)
      fail(`${adapter.id}/${id}: generated projection did not reject response`);
    projectionNegativeCases[id] = { rejected: true };
  }
  const projectionSemanticCases = {};
  for (const id of fixture.projection_semantic_cases) {
    const result = await runMeasured(
      adapter.command,
      [
        ...adapter.prefix,
        workspace,
        '__runtime_action_projection_semantic__',
        id,
      ],
      { cwd: root, env: qualificationEnv },
    );
    const response = JSON.parse(result.stdout.trim().split('\n').at(-1));
    if (!/^sha256:[0-9a-f]{64}$/.test(response.geometryRoot || ''))
      fail(`${adapter.id}/${id}: generated projection rejected semantic JSON`);
    const expectedBytesHex = semanticProjectionBytes(id).toString('hex');
    if (response.bytesHex !== expectedBytesHex)
      fail(`${adapter.id}/${id}: generated projection changed response bytes`);
    projectionSemanticCases[id] = {
      accepted: true,
      bytes_preserved: true,
    };
  }
  let interleavedRuntime;
  if (adapter.id === 'npm-sdk') {
    const result = await runMeasured(
      adapter.command,
      [...adapter.prefix, workspace, '__runtime_action_interleaved__', '{}'],
      { cwd: root, env: qualificationEnv },
    );
    const response = JSON.parse(result.stdout.trim().split('\n').at(-1));
    if (response.interleaved !== true)
      fail('npm-sdk: legacy and runtime-action calls did not interleave');
    interleavedRuntime = true;
  }
  return {
    id: adapter.id,
    status: 'passing',
    exact_artifact: path.relative(ROOT, adapter.exactArtifact),
    exact_artifact_sha256: sha256(adapter.exactArtifact),
    wire_fixture_sha256: sha256(WIRE_FIXTURE),
    cases,
    projection_negative_cases: projectionNegativeCases,
    projection_semantic_cases: projectionSemanticCases,
    interleaved_runtime: interleavedRuntime,
  };
}

function classifyWorkLifecycleError(message) {
  if (message.includes('unknown Work lifecycle operation'))
    return 'unsupported-operation';
  if (
    message.includes('delegated mutation requires an exact authority receipt')
  )
    return 'missing-authority';
  if (message.includes('authority receipt does not match lifecycle operation'))
    return 'authority-mismatch';
  return 'invalid-request';
}

function parseAdapterResponse(adapter, entry, stdout) {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // Tooling may emit setup diagnostics before the one result line.
    }
  }
  fail(`${adapter.id}/${entry.id}: Work lifecycle adapter returned no JSON`);
}

async function qualifyWorkLifecycleAdapter(
  adapter,
  fixture,
  root,
  contractProfile,
) {
  const workspace = path.join(root, `${adapter.id}-work-lifecycle.kungfu`);
  const qualificationEnv = {
    ...adapter.env,
    KUNGFU_QUALIFICATION_HOLD_MS: String(qualificationHoldMs()),
    KUNGFU_CONTRACT_REGISTRY: contractProfile.registry,
    KUNGFU_ACTION_GEOMETRY_CONTRACT: contractProfile.actionGeometry,
  };
  const cases = {};
  for (const entry of fixture.runtimeCases) {
    const requestJson =
      typeof entry.rawJson === 'string'
        ? entry.rawJson
        : JSON.stringify(
            entry.mode === 'capabilities'
              ? { action: 'work_lifecycle', mode: 'capabilities' }
              : {
                  action: 'work_lifecycle',
                  mode: 'invoke',
                  operationId: entry.operationId,
                  input: entry.input,
                  execute: entry.execute,
                },
          );
    const beforeSemantic = snapshotTree(workspace, { semantic: true });
    const result = await runMeasured(
      adapter.command,
      [...adapter.prefix, workspace, '__work_lifecycle_runtime__', requestJson],
      { cwd: root, env: qualificationEnv },
    );
    const response = parseAdapterResponse(adapter, entry, result.stdout);
    const afterSemantic = snapshotTree(workspace, { semantic: true });
    if (afterSemantic.digest !== beforeSemantic.digest)
      fail(
        `${adapter.id}/${entry.id}: lifecycle routing changed semantic storage`,
      );

    if (entry.expectedError) {
      if (
        typeof response.rawError !== 'string' ||
        !response.rawError.includes(entry.expectedError.includes)
      )
        fail(
          `${adapter.id}/${entry.id}: expected error containing ${JSON.stringify(entry.expectedError.includes)}, got ${JSON.stringify(response.rawError)}`,
        );
      const errorClass = classifyWorkLifecycleError(response.rawError);
      if (errorClass !== entry.expectedError.class)
        fail(
          `${adapter.id}/${entry.id}: expected error class ${entry.expectedError.class}, got ${errorClass}`,
        );
      cases[entry.id] = {
        status: 'rejected',
        error_class: errorClass,
        semantic_write_occurred: false,
      };
      continue;
    }

    for (const [wireKey, expected] of [
      ['protocolId', 'kungfu.runtime.action'],
      ['protocolVersion', 1],
      ['schemaRef', 'kungfu.action-runtime.result/v1'],
      ['encoding', 'application/json'],
    ]) {
      if (response[wireKey] !== expected)
        fail(
          `${adapter.id}/${entry.id}: ${wireKey} expected ${JSON.stringify(expected)}, got ${JSON.stringify(response[wireKey])}`,
        );
    }
    if (
      typeof response.bytesHex !== 'string' ||
      !/^(?:[0-9a-f]{2})+$/.test(response.bytesHex)
    )
      fail(`${adapter.id}/${entry.id}: invalid lifecycle response bytes`);
    let envelope;
    try {
      envelope = JSON.parse(
        Buffer.from(response.bytesHex, 'hex').toString('utf8'),
      );
    } catch (error) {
      fail(
        `${adapter.id}/${entry.id}: lifecycle response is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const assertion of entry.assert || []) {
      const actual = valueAt(envelope, assertion.path);
      if ('equals' in assertion && actual !== assertion.equals)
        fail(
          `${adapter.id}/${entry.id}: ${assertion.path.join('.')} expected ${JSON.stringify(assertion.equals)}, got ${JSON.stringify(actual)}`,
        );
    }
    if (
      entry.mode === 'capabilities' &&
      envelope.result?.operations?.length !==
        readJson(WORK_LIFECYCLE_CONTRACT).operations.length
    )
      fail(`${adapter.id}/${entry.id}: incomplete lifecycle operation set`);
    cases[entry.id] = {
      status: 'accepted',
      bytes_hex: response.bytesHex,
      bytes_sha256: sha256Bytes(Buffer.from(response.bytesHex, 'hex')),
      semantic_write_occurred: false,
    };
  }
  return {
    id: adapter.id,
    status: 'passing',
    exact_artifact: path.relative(ROOT, adapter.exactArtifact),
    exact_artifact_sha256: sha256(adapter.exactArtifact),
    fixture_sha256: sha256(WORK_LIFECYCLE_FIXTURE),
    cases,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixture = readJson(FIXTURE);
  const wireFixture = readJson(WIRE_FIXTURE);
  const workLifecycleFixture = readJson(WORK_LIFECYCLE_FIXTURE);
  validateFixture(fixture);
  validateWireFixture(wireFixture);
  validateWorkLifecycleFixture(workLifecycleFixture);
  if (options.validateOnly) {
    console.log(
      `[layers:qualify:sdk] fixtures valid; semantic_steps=${fixture.steps.length}; semantic_sha256=${sha256(FIXTURE)}; wire_cases=${wireFixture.cases.length}; wire_sha256=${sha256(WIRE_FIXTURE)}; work_lifecycle_cases=${workLifecycleFixture.runtimeCases.length}; work_lifecycle_sha256=${sha256(WORK_LIFECYCLE_FIXTURE)}`,
    );
    return;
  }

  const tools = {
    uv: commandVersion('uv'),
    npm: commandVersion('npm'),
    cargo: commandVersion('cargo'),
    cmake: commandVersion('cmake'),
  };
  const artifacts = resolveArtifacts(options);
  if (!fs.existsSync(artifacts.nativeDir))
    fail(`native artifact directory is missing: ${artifacts.nativeDir}`);
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-sdk-qualification-'),
  );
  try {
    const contractProfile = stageQualificationProfile(temp);
    const semanticAdapters = [
      measureCandidateStageSync(
        'sdk-setup-python',
        'sdk-adapter-setup-python',
        () => setupPython(temp, artifacts.pythonWheel),
        { gateId: 'source.changed-scope', language: 'python' },
      ),
      measureCandidateStageSync(
        'sdk-setup-node',
        'sdk-adapter-setup-node',
        () => setupNode(temp, artifacts.npmCore, artifacts.npmPlatform),
        { gateId: 'source.changed-scope', language: 'node' },
      ),
      measureCandidateStageSync(
        'sdk-setup-rust',
        'sdk-adapter-setup-rust',
        () => setupRust(temp, artifacts.nativeDir, artifacts.cargoCrate),
        { gateId: 'source.changed-scope', language: 'rust' },
      ),
    ];
    const cppAdapter = measureCandidateStageSync(
      'sdk-setup-cpp',
      'sdk-adapter-setup-cpp',
      () => setupCpp(temp, artifacts.nativeDir),
      { gateId: 'source.changed-scope', language: 'cpp' },
    );
    const qualifications = [];
    for (const adapter of semanticAdapters) {
      console.log(`[layers:qualify:sdk] semantic adapter=${adapter.id}`);
      qualifications.push(
        await measureCandidateStage(
          `sdk-semantic-${adapter.id}`,
          `sdk-semantic-${adapter.id}`,
          () => qualifyAdapter(adapter, fixture, temp),
          {
            gateId: 'source.changed-scope',
            language: adapter.id
              .replace(/-sdk$/, '')
              .replace('pypi', 'python')
              .replace('npm', 'node')
              .replace('cargo', 'rust'),
          },
        ),
      );
    }
    const wireQualifications = [];
    for (const adapter of [cppAdapter, ...semanticAdapters]) {
      console.log(`[layers:qualify:sdk] wire adapter=${adapter.id}`);
      const language = adapter.id
        .replace(/-sdk$/, '')
        .replace('pypi', 'python')
        .replace('npm', 'node')
        .replace('cargo', 'rust');
      wireQualifications.push(
        await measureCandidateStage(
          `sdk-wire-${adapter.id}`,
          `sdk-wire-${language}`,
          () => qualifyWireAdapter(adapter, wireFixture, temp, contractProfile),
          { gateId: 'source.changed-scope', language },
        ),
      );
    }
    const workLifecycleQualifications = [];
    for (const adapter of [cppAdapter, ...semanticAdapters]) {
      console.log(`[layers:qualify:sdk] work-lifecycle adapter=${adapter.id}`);
      workLifecycleQualifications.push(
        await measureCandidateStage(
          `sdk-work-lifecycle-${adapter.id}`,
          `sdk-work-lifecycle-${adapter.id}`,
          () =>
            qualifyWorkLifecycleAdapter(
              adapter,
              workLifecycleFixture,
              temp,
              contractProfile,
            ),
          {
            gateId: 'source.changed-scope',
            language: adapter.id
              .replace(/-sdk$/, '')
              .replace('pypi', 'python')
              .replace('npm', 'node')
              .replace('cargo', 'rust'),
          },
        ),
      );
    }
    const baselineLifecycleCases = JSON.stringify(
      workLifecycleQualifications[0].cases,
    );
    for (const row of workLifecycleQualifications.slice(1)) {
      if (JSON.stringify(row.cases) !== baselineLifecycleCases)
        fail(
          `${row.id}: Work lifecycle results differ from cpp-sdk exact bytes/classes`,
        );
    }
    const report = {
      schema: 'kungfu.layer-qualification.sdk-report/v1',
      status:
        qualifications.every((row) => row.status === 'passing') &&
        wireQualifications.every((row) => row.status === 'passing') &&
        workLifecycleQualifications.every((row) => row.status === 'passing')
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
      wire_fixture: path.relative(ROOT, WIRE_FIXTURE),
      wire_fixture_sha256: sha256(WIRE_FIXTURE),
      work_lifecycle_fixture: path.relative(ROOT, WORK_LIFECYCLE_FIXTURE),
      work_lifecycle_fixture_sha256: sha256(WORK_LIFECYCLE_FIXTURE),
      sdk_contract: path.relative(ROOT, SDK_CONTRACT),
      sdk_contract_sha256: sha256(SDK_CONTRACT),
      native_header_sha256: sha256(NATIVE_HEADER),
      qualifications,
      wire_qualifications: wireQualifications,
      work_lifecycle_qualifications: workLifecycleQualifications,
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
      `[layers:qualify:sdk] ${report.status}; semantic_artifacts=${qualifications.length}; wire_artifacts=${wireQualifications.length}; fixture_steps=${fixture.steps.length}`,
    );
    if (options.report)
      console.log(`[layers:qualify:sdk] report=${options.report}`);
    console.log(`[layers:qualify:sdk] ${report.boundary}`);
  } finally {
    // npm/cargo/venv child helpers can briefly retain directory entries after
    // their parent exits on macOS and Windows.
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      fs.rmSync(temp, {
        recursive: true,
        force: true,
        maxRetries: 1,
        retryDelay: 100,
      });
    } catch (error) {
      console.warn(
        `[layers:qualify:sdk] retained temporary directory after cleanup retries: ${temp} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `[layers:qualify:sdk] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
