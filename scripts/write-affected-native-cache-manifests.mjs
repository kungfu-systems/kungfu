#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IDENTITY_FILES = [
  '.buildchain-version',
  '.node-version',
  'pnpm-lock.yaml',
  'framework/core/conanfile.py',
  'framework/core/package.json',
  'framework/core/pyproject.toml',
  'framework/core/uv.lock',
];

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(ordered(value)))
    .digest('hex')}`;
}

function fileIdentity(root) {
  return IDENTITY_FILES.map((relative) => ({
    path: relative,
    digest: digest(fs.readFileSync(path.join(root, relative))),
  }));
}

function tool(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false });
  return {
    command,
    status: result.status ?? 1,
    version:
      `${result.stdout || ''}${result.stderr || ''}`.split('\n')[0].trim() ||
      'unavailable',
  };
}

export function createAffectedNativeCacheManifests({
  root = ROOT,
  plan,
  env = process.env,
  toolFacts = null,
}) {
  if (plan?.schema !== 'kungfu.core-affected-native-plan/v1') {
    throw new Error('unsupported affected-native plan schema');
  }
  if (!plan.profile || !plan.closureComponents?.length) {
    throw new Error('portable cache manifests require a native plan');
  }
  const files = fileIdentity(root);
  const tools = toolFacts || [
    tool(env.CXX || 'c++'),
    tool('cmake'),
    tool('ccache'),
    tool('node'),
  ];
  const identity = {
    platform: (env.RUNNER_OS || process.platform).toLowerCase(),
    arch: (env.RUNNER_ARCH || process.arch).toLowerCase(),
    runnerImage: env.ImageOS || env.RUNNER_IMAGE || 'ubuntu-24.04',
    toolchainDigest: digest({ tools, node: process.version }),
    dependencyLockDigest: digest(files),
    profileDigest: digest({
      profile: plan.profile,
      authority: plan.authority,
      platformTier: plan.platformTier,
    }),
    sourceSha: plan.head,
    planDigest: plan.planDigest,
  };
  const manifest = (layer, roots) => ({
    schema: 'buildchain.portable-dev-cache-manifest/v1',
    layer,
    roots,
    identity,
  });
  return {
    dependency: manifest('dependency', [
      { id: 'conan-packages', path: '~/.conan2/p' },
    ]),
    compiler: manifest('compiler', [{ id: 'ccache', path: '~/.cache/ccache' }]),
  };
}

function parseArgs(argv) {
  const options = { plan: '', outputDir: '' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--plan') options.plan = argv[++index];
    else if (argv[index] === '--output-dir') options.outputDir = argv[++index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!options.plan || !options.outputDir) {
    throw new Error('--plan and --output-dir are required');
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = JSON.parse(
    fs.readFileSync(path.resolve(ROOT, options.plan), 'utf8'),
  );
  const manifests = createAffectedNativeCacheManifests({ plan });
  const output = path.resolve(ROOT, options.outputDir);
  fs.mkdirSync(output, { recursive: true });
  for (const [layer, manifest] of Object.entries(manifests)) {
    fs.writeFileSync(
      path.join(output, `${layer}.manifest.json`),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
  console.log(
    `[affected-native-cache] manifests=${path.relative(ROOT, output)}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(`[affected-native-cache] ${error.message}`);
    process.exitCode = 1;
  }
}
