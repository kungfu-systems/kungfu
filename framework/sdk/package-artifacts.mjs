// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  platformCommand,
  platformCommandOptions,
} from '../../scripts/platform-command.mjs';

const SDK = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SDK, '..', '..');
const CORE = path.join(ROOT, 'framework', 'core');
const NATIVE = path.join(CORE, 'dist', 'kungfu');
const STAGE = path.join(CORE, 'build', 'stage', 'sdk');
const RELEASE = path.join(
  ROOT,
  'product',
  'release',
  'sdk',
  `${process.platform}-${process.arch}`,
);
const VERSION = JSON.parse(
  fs.readFileSync(path.join(SDK, 'package.json')),
).version;
const CONTRACT = path.join(SDK, 'kungfu-storage.contract.json');
const NATIVE_HEADER = path.join(
  CORE,
  'src',
  'libkungfu',
  'include',
  'kungfu',
  'api.h',
);
const SEMANTIC_FIXTURE = path.join(
  ROOT,
  'tests',
  'qualification',
  'layers',
  'sdk',
  'semantic-fixture-v1.json',
);
const PLATFORMS = [
  { key: 'darwin-arm64', os: ['darwin'], cpu: ['arm64'] },
  { key: 'linux-x64', os: ['linux'], cpu: ['x64'] },
  { key: 'win32-x64', os: ['win32'], cpu: ['x64'] },
];

function fail(message) {
  throw new Error(message);
}

function run(command, args, cwd) {
  const result = spawnSync(platformCommand(command), args, {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
    ...platformCommandOptions(command),
  });
  if (result.error || result.status !== 0)
    fail(`${command} ${args.join(' ')} failed (status=${result.status})`);
}

function currentPlatform() {
  const key = `${process.platform}-${process.arch}`;
  const descriptor = PLATFORMS.find((item) => item.key === key);
  if (!descriptor) fail(`unsupported SDK package target: ${key}`);
  return descriptor;
}

function nativeLibraryNames() {
  if (process.platform === 'win32') return ['kungfu.dll'];
  if (process.platform === 'darwin')
    return ['libkungfu.dylib', 'libkungfu_runtime.dylib'];
  return ['libkungfu.so', 'libkungfu_runtime.so'];
}

function nativeLibraries() {
  return nativeLibraryNames().map((name) => path.join(NATIVE, name));
}

function copyNativeLibraries(destination) {
  for (const library of nativeLibraries()) {
    requireFile(library);
    fs.copyFileSync(library, path.join(destination, path.basename(library)));
  }
}

function requireFile(file) {
  if (!fs.existsSync(file))
    fail(`required SDK package input is missing: ${file}`);
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function packNpm(packageRoot, destination) {
  run('npm', ['pack', '--pack-destination', destination], packageRoot);
}

function packNode() {
  const descriptor = currentPlatform();
  const npmStage = path.join(STAGE, 'npm');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-node-sdk-pack-'));
  const addon = path.join(NATIVE, 'kungfu_node.node');
  const libraries = nativeLibraries();
  requireFile(addon);
  for (const library of libraries) requireFile(library);
  fs.mkdirSync(npmStage, { recursive: true });
  try {
    const platformRoot = path.join(work, 'platform');
    fs.mkdirSync(path.join(platformRoot, 'dist'), { recursive: true });
    fs.copyFileSync(addon, path.join(platformRoot, 'dist', 'kungfu_node.node'));
    copyNativeLibraries(path.join(platformRoot, 'dist'));
    fs.copyFileSync(
      CONTRACT,
      path.join(platformRoot, 'kungfu-storage.contract.json'),
    );
    fs.copyFileSync(
      path.join(ROOT, 'LICENSE'),
      path.join(platformRoot, 'LICENSE'),
    );
    fs.writeFileSync(
      path.join(platformRoot, 'index.js'),
      "exports.bindingDir = require('node:path').join(__dirname, 'dist');\n",
    );
    writeJson(path.join(platformRoot, 'package.json'), {
      name: `@kungfu-tech/storage-${descriptor.key}`,
      version: VERSION,
      description: `Kungfu SDK native adapter for ${descriptor.key}`,
      license: 'Apache-2.0',
      main: 'index.js',
      files: ['index.js', 'dist/', 'LICENSE', 'kungfu-storage.contract.json'],
      os: descriptor.os,
      cpu: descriptor.cpu,
      publishConfig: {
        registry: 'https://registry.npmjs.org/',
        access: 'public',
      },
    });
    packNpm(platformRoot, npmStage);

    const mainRoot = path.join(work, 'main');
    fs.mkdirSync(mainRoot, { recursive: true });
    fs.copyFileSync(
      path.join(SDK, 'index.js'),
      path.join(mainRoot, 'index.js'),
    );
    fs.copyFileSync(
      path.join(SDK, 'README.md'),
      path.join(mainRoot, 'README.md'),
    );
    fs.copyFileSync(
      CONTRACT,
      path.join(mainRoot, 'kungfu-storage.contract.json'),
    );
    fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(mainRoot, 'LICENSE'));
    const source = JSON.parse(fs.readFileSync(path.join(SDK, 'package.json')));
    writeJson(path.join(mainRoot, 'package.json'), {
      ...source,
      scripts: undefined,
      optionalDependencies: Object.fromEntries(
        PLATFORMS.map((item) => [`@kungfu-tech/storage-${item.key}`, VERSION]),
      ),
    });
    packNpm(mainRoot, npmStage);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function packPython() {
  const source = path.join(SDK, 'python');
  const pythonStage = path.join(STAGE, 'python');
  const work = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-python-sdk-pack-'),
  );
  for (const library of nativeLibraries()) requireFile(library);
  fs.mkdirSync(pythonStage, { recursive: true });
  try {
    fs.cpSync(source, work, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(work, 'LICENSE'));
    copyNativeLibraries(path.join(work, 'kungfu_sdk'));
    fs.copyFileSync(
      CONTRACT,
      path.join(work, 'kungfu_sdk', 'kungfu-storage.contract.json'),
    );
    run(
      'uv',
      [
        'run',
        '--project',
        CORE,
        '--frozen',
        'python',
        'setup.py',
        'bdist_wheel',
        '--dist-dir',
        pythonStage,
      ],
      work,
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function packCargo() {
  const cargoStage = path.join(STAGE, 'cargo');
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-cargo-pack-'));
  fs.mkdirSync(cargoStage, { recursive: true });
  try {
    run(
      'cargo',
      [
        'package',
        '--manifest-path',
        path.join(ROOT, 'crates', 'kungfu-sdk', 'Cargo.toml'),
        '--allow-dirty',
        '--target-dir',
        target,
      ],
      ROOT,
    );
    const crate = fs
      .readdirSync(path.join(target, 'package'))
      .find((name) => name.endsWith('.crate'));
    if (!crate) fail('Cargo package did not produce a .crate artifact');
    fs.copyFileSync(
      path.join(target, 'package', crate),
      path.join(cargoStage, crate),
    );
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function stageReleaseArtifacts() {
  fs.rmSync(RELEASE, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(RELEASE), { recursive: true });
  fs.cpSync(STAGE, RELEASE, { recursive: true });
}

function validate() {
  requireFile(path.join(SDK, 'index.js'));
  requireFile(path.join(SDK, 'python', 'kungfu_sdk', 'native.py'));
  const contract = JSON.parse(fs.readFileSync(CONTRACT));
  if (contract.native_abi?.sha256 !== sha256(NATIVE_HEADER))
    fail('SDK contract native header hash is stale');
  if (contract.semantic_fixture?.sha256 !== sha256(SEMANTIC_FIXTURE))
    fail('SDK contract semantic fixture hash is stale');
  console.log('[sdk:pack] source contract valid');
}

try {
  validate();
  if (!process.argv.includes('--validate')) {
    fs.rmSync(STAGE, { recursive: true, force: true });
    packNode();
    packPython();
    packCargo();
    stageReleaseArtifacts();
    console.log(
      `[sdk:pack] staged exact artifacts under ${path.relative(ROOT, STAGE)} and ${path.relative(ROOT, RELEASE)}`,
    );
  }
} catch (error) {
  console.error(
    `[sdk:pack] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
