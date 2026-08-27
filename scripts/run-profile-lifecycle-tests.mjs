#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

if (process.argv.includes('--qualify-command-contract')) {
  qualifyCommandContract();
  process.exit(0);
}

const buildDir = path.join(process.cwd(), 'framework', 'core', 'build');
const coreDir = path.join(process.cwd(), 'framework', 'core');
const pythonEnvironment =
  process.env.UV_PROJECT_ENVIRONMENT || path.join(coreDir, '.venv');
const python =
  process.platform === 'win32'
    ? path.join(pythonEnvironment, 'Scripts', 'python.exe')
    : path.join(pythonEnvironment, 'bin', 'python');
const ninjaName = process.platform === 'win32' ? 'ninja.exe' : 'ninja';
const managedNinja = process.env.UV_PROJECT_ENVIRONMENT
  ? path.join(
      process.env.UV_PROJECT_ENVIRONMENT,
      process.platform === 'win32' ? 'Scripts' : 'bin',
      ninjaName,
    )
  : path.join(
      coreDir,
      '.venv',
      process.platform === 'win32' ? 'Scripts' : 'bin',
      ninjaName,
    );
const configure = spawnSync(
  'cmake',
  [
    '-S',
    coreDir,
    '-B',
    buildDir,
    `-DCMAKE_MAKE_PROGRAM=${managedNinja}`,
    `-DPYTHON_EXECUTABLE=${python}`,
  ],
  { cwd: process.cwd(), stdio: 'inherit' },
);
if (configure.error || configure.status !== 0) {
  if (configure.error)
    console.error(
      `[profile-lifecycle-test] configure: ${configure.error.message}`,
    );
  console.error(
    '[profile-lifecycle-test] failed to rebind the configured tree to the current Shifu toolchain',
  );
  process.exit(configure.status ?? 2);
}
// shifu-entry-contract: this task builds the exact native target before use.
const build = spawnSync(
  'cmake',
  [
    '--build',
    buildDir,
    '--config',
    'Release',
    '--target',
    'kungfu_profile_lifecycle_tests',
  ],
  { cwd: process.cwd(), stdio: 'inherit' },
);
if (build.error || build.status !== 0) {
  if (build.error)
    console.error(`[profile-lifecycle-test] build: ${build.error.message}`);
  console.error(
    '[profile-lifecycle-test] target build failed; run ./shifu build:core to configure the core tree',
  );
  process.exit(build.status ?? 2);
}

const executable =
  process.platform === 'win32'
    ? 'kungfu_profile_lifecycle_tests.exe'
    : 'kungfu_profile_lifecycle_tests';
const candidates = [
  path.join(process.cwd(), 'framework', 'core', 'build', 'Release', executable),
  path.join(process.cwd(), 'framework', 'core', 'build', executable),
];
const testBinary = candidates.find((candidate) => fs.existsSync(candidate));
if (!testBinary) {
  console.error('[profile-lifecycle-test] binary not found after target build');
  process.exit(2);
}

const sources = [
  'framework/core/src/libkungfu/include/kungfu/runtime/profile/profile_lifecycle.h',
  'framework/core/src/libkungfu/src/runtime/profile/profile_lifecycle.cpp',
  'framework/core/src/libkungfu/schemas/profile_lifecycle_event.fbs',
  'framework/core/src/libkungfu/tests/profile_lifecycle_tests.cpp',
].map((source) => path.join(process.cwd(), source));
const binaryMtime = fs.statSync(testBinary).mtimeMs;
const newerSource = sources.find(
  (source) => fs.statSync(source).mtimeMs > binaryMtime,
);
if (newerSource) {
  console.error(
    `[profile-lifecycle-test] refusing stale binary; newer source: ${path.relative(process.cwd(), newerSource)}`,
  );
  process.exit(2);
}

console.log(`[profile-lifecycle-test] running ${testBinary}`);
const result = spawnSync(testBinary, [], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
if (result.error || result.status !== 0) {
  if (result.error)
    console.error(`[profile-lifecycle-test] ${result.error.message}`);
  process.exit(result.status ?? 1);
}

const pythonPath = [
  path.join(process.cwd(), 'framework', 'core', 'build', 'Release'),
  path.join(process.cwd(), 'framework', 'core', 'src', 'python'),
  process.env.PYTHONPATH,
]
  .filter(Boolean)
  .join(path.delimiter);
console.log(
  '[profile-lifecycle-test] checking Python service and CLI surfaces',
);
const pythonResult = spawnSync(
  python,
  [
    '-m',
    'pytest',
    path.join(
      process.cwd(),
      'framework',
      'core',
      'tests',
      'python',
      'test_profile_lifecycle_cli.py',
    ),
    path.join(
      process.cwd(),
      'framework',
      'core',
      'tests',
      'python',
      'test_profile_lifecycle_command_contract.py',
    ),
    '-q',
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      KUNGFU_ALLOW_FOREIGN_RUNTIME: '1',
      PYTHONPATH: pythonPath,
    },
    stdio: 'inherit',
  },
);
if (pythonResult.error || pythonResult.status !== 0) {
  if (pythonResult.error)
    console.error(
      `[profile-lifecycle-test] Python: ${pythonResult.error.message}`,
    );
  process.exit(pythonResult.status ?? 1);
}

console.log('[profile-lifecycle-test] checking Node binding surface');
const bindingDir = [
  path.join(process.cwd(), 'framework', 'core', 'dist', 'kungfu'),
  path.join(buildDir, 'Release'),
  buildDir,
].find((candidate) => fs.existsSync(path.join(candidate, 'kungfu_node.node')));
if (!bindingDir) {
  console.error('[profile-lifecycle-test] Node binding not found');
  process.exit(2);
}
process.env.KUNGFU_DIR = bindingDir;
const require = createRequire(import.meta.url);
const binding = require('../framework/core/lib/kungfu.js')();
const nodeRuntime = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kungfu-profile-node-'),
);
try {
  const contract = binding.runStorageServiceOperation(
    'profile_lifecycle',
    nodeRuntime,
    { action: 'contract' },
  );
  if (contract.schema !== 'kungfu.profile-lifecycle/v1') {
    throw new Error('Node binding returned another Profile lifecycle contract');
  }
} finally {
  fs.rmSync(nodeRuntime, { recursive: true, force: true });
}

function qualifyCommandContract() {
  const root = process.cwd();
  const wheelDir = path.join(
    root,
    'framework',
    'core',
    'build',
    'python',
    'dist',
  );
  const qualificationRoot = path.join(
    root,
    'framework',
    'core',
    'build',
    'qualification',
    'profile-lifecycle-command-contract',
  );

  function fail(message) {
    console.error(`[profile-command-contract] ${message}`);
    process.exit(1);
  }

  function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      ...options,
    });
    if (result.error || result.status !== 0) {
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      fail(
        result.error
          ? `${command} failed: ${result.error.message}`
          : `${command} exited ${result.status}`,
      );
    }
    return result.stdout;
  }

  function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function semanticRoot(value) {
    return `sha256:${crypto.createHash('sha256').update(canonical(value)).digest('hex')}`;
  }

  const shifu = path.join(
    root,
    process.platform === 'win32' ? 'shifu.cmd' : 'shifu',
  );
  run(shifu, ['build:core']);
  if (!fs.existsSync(wheelDir))
    fail('built wheel directory is unavailable; run ./shifu build:core');
  const wheels = fs
    .readdirSync(wheelDir)
    .filter((name) => /^kungfu-.*\.whl$/u.test(name))
    .sort();
  if (wheels.length !== 1)
    fail(`expected one built Kungfu wheel, found ${wheels.length}`);

  fs.mkdirSync(qualificationRoot, { recursive: true });
  const environment = fs.mkdtempSync(
    path.join(qualificationRoot, 'installed-'),
  );
  const python = path.join(
    environment,
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python',
  );
  const binary = path.join(
    environment,
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'kungfu.cmd' : 'kungfu',
  );
  const wheel = path.join(wheelDir, wheels[0]);
  run('uv', ['venv', environment, '--python', '3.13']);
  run('uv', ['pip', 'install', '--python', python, wheel]);
  if (process.platform === 'win32') {
    fs.writeFileSync(
      binary,
      `@echo off\r\n"${python}" -m kungfu %*\r\n`,
      'utf8',
    );
  } else {
    fs.writeFileSync(
      binary,
      `#!/bin/sh\nexec ${JSON.stringify(python)} -m kungfu "$@"\n`,
      { encoding: 'utf8', mode: 0o755 },
    );
  }

  const runtimeEntry = run(python, [
    '-c',
    'from kungfu.cli.commands.work_design import _preflight_entry; print(_preflight_entry())',
  ]).trim();
  const workDesignQualification = JSON.parse(
    run(process.execPath, [
      path.join(root, 'scripts', 'qualify-installed-work-design.mjs'),
      '--binary',
      binary,
      '--runtime-root',
      path.resolve(path.dirname(runtimeEntry), '..', '..', '..'),
      '--surface',
      'wheel',
    ]),
  );

  const home = path.join(environment, 'home');
  const capabilities = JSON.parse(
    run(binary, ['--home', home, 'profile', 'capabilities', '--json']),
  );
  const manager = JSON.parse(
    run(binary, ['--home', home, 'profile', 'manager', '--json']),
  );
  const workControlSource = path.join(root, 'extensions', 'work-control');
  const workValidation = JSON.parse(
    run(binary, [
      '--home',
      home,
      'profile',
      'validate',
      workControlSource,
      '--json',
    ]),
  );
  const workQualification = JSON.parse(
    run(binary, [
      '--home',
      home,
      'profile',
      'qualify',
      workControlSource,
      '--json',
    ]),
  );
  if (workValidation.workConformance?.verdict !== 'compatible')
    fail('installed wheel cannot validate the Work conformance declaration');
  if (
    workValidation.workConformance.conformanceRoot !==
    workQualification.workConformance?.conformanceRoot
  )
    fail(
      'installed validate and qualify project different Work conformance roots',
    );
  const lifecycleReceipts = [];
  for (const [index, action] of ['install', 'qualify', 'activate'].entries()) {
    const planPath = path.join(environment, `${index + 1}-${action}-plan.json`);
    const answerPath = path.join(
      environment,
      `${index + 1}-${action}-answer.json`,
    );
    const planArgs = [
      '--home',
      home,
      'profile',
      'plan',
      action,
      workControlSource,
    ];
    if (action === 'activate') planArgs.push('--grant', 'storage');
    planArgs.push('--out', planPath, '--json');
    const agentPlan = JSON.parse(run(binary, planArgs));
    const answer = JSON.parse(
      run(binary, [
        '--home',
        home,
        'profile',
        'decide',
        planPath,
        '--choice',
        'approve',
        '--authorized-by',
        'profile-lifecycle-command-contract-gate',
        '--out',
        answerPath,
        '--json',
      ]),
    );
    const receipt = JSON.parse(
      run(binary, [
        '--home',
        home,
        'profile',
        'apply',
        planPath,
        '--authorization-file',
        answerPath,
        '--json',
      ]),
    );
    if (!agentPlan.corePlan?.plan_id || !answer.authorizationId)
      fail(`installed ${action} lifecycle artifacts are not content-bound`);
    lifecycleReceipts.push({
      action,
      planId: agentPlan.corePlan.plan_id,
      authorizationId: answer.authorizationId,
      receiptRoot: receipt.receipt_root,
    });
  }
  const activated = JSON.parse(
    run(binary, [
      '--home',
      home,
      'profile',
      'inspect',
      'kungfu.work-control',
      '--json',
    ]),
  );
  if (activated.state !== 'activated')
    fail('installed public lifecycle did not activate the Work Profile');
  const contract = capabilities.lifecycleCommandContract;
  if (contract?.schema !== 'kungfu.profile-lifecycle-command-contract/v1')
    fail('installed capabilities omit the lifecycle command contract');
  if (canonical(manager.lifecycleCommandContract) !== canonical(contract))
    fail(
      'installed capabilities and manager project different command contracts',
    );
  const { contractRoot: recordedRoot, ...body } = contract;
  if (recordedRoot !== semanticRoot(body))
    fail('installed command contract root mismatch');

  const commands = new Map(contract.commands.map((row) => [row.id, row]));
  for (const id of [
    'profile.capabilities',
    'profile.inspect',
    'profile.list',
    'profile.manager',
    'profile.plan.upgrade',
  ]) {
    if (commands.get(id)?.mutation !== false)
      fail(`reader/plan command is not mutation-free: ${id}`);
  }
  for (const id of ['profile.apply', 'profile.authorize-upgrade']) {
    if (commands.get(id)?.mutation !== true)
      fail(`mutating command is not fenced: ${id}`);
  }

  console.log(
    JSON.stringify(
      {
        schema: 'kungfu.profile-lifecycle-command-contract-qualification/v1',
        status: 'qualified',
        wheel,
        binary,
        contractRoot: recordedRoot,
        commandCount: contract.commands.length,
        readerPlanCount: contract.commands.filter(
          (row) => row.mutation === false,
        ).length,
        mutationCount: contract.commands.filter((row) => row.mutation === true)
          .length,
        home,
        workConformanceRoot: workValidation.workConformance.conformanceRoot,
        lifecycleReceipts,
        activatedProfileRoot: activated.profile_suite_root,
        workDesignQualification,
      },
      null,
      2,
    ),
  );
}
