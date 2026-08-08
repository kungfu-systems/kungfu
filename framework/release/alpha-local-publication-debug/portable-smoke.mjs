#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BUILDCHAIN_REHEARSAL_MERGE = 'fadcdfbf87a5e8f16b80df2ab39384dee0c8a601';
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function required(value, label) {
  const result = String(value || '').trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function existingAbsolute(value, label, kind) {
  const resolved = path.resolve(required(value, label));
  if (!path.isAbsolute(value) || !fs.existsSync(resolved))
    throw new Error(`${label} must be an existing absolute ${kind}`);
  const stats = fs.statSync(resolved);
  if (
    (kind === 'file' && !stats.isFile()) ||
    (kind === 'directory' && !stats.isDirectory())
  )
    throw new Error(`${label} must be an existing absolute ${kind}`);
  return fs.realpathSync(resolved);
}

function git(repo, args) {
  const result = childProcess.spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function parseArguments(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flag?.startsWith('--') || index + 1 >= args.length)
      throw new Error(`invalid option: ${flag || '<missing>'}`);
    const name = flag.slice(2);
    if (
      ![
        'capsule',
        'capsule-root',
        'buildchain-root',
        'expected-binding-root',
        'expected-transaction-root',
      ].includes(name)
    )
      throw new Error(`unknown option: ${flag}`);
    if (Object.hasOwn(options, name))
      throw new Error(`duplicate option: ${flag}`);
    options[name] = args[index + 1];
  }
  for (const name of [
    'capsule',
    'capsule-root',
    'buildchain-root',
    'expected-binding-root',
    'expected-transaction-root',
  ])
    required(options[name], `--${name}`);
  return options;
}

export async function runPortableSmoke(rawOptions) {
  const capsulePath = existingAbsolute(rawOptions.capsule, '--capsule', 'file');
  const capsuleRoot = existingAbsolute(
    rawOptions.capsuleRoot,
    '--capsule-root',
    'directory',
  );
  const buildchainRoot = existingAbsolute(
    rawOptions.buildchainRoot,
    '--buildchain-root',
    'directory',
  );
  const expectedBindingRoot = required(
    rawOptions.expectedBindingRoot,
    '--expected-binding-root',
  );
  const expectedTransactionRoot = required(
    rawOptions.expectedTransactionRoot,
    '--expected-transaction-root',
  );
  if (
    !ROOT_PATTERN.test(expectedBindingRoot) ||
    !ROOT_PATTERN.test(expectedTransactionRoot)
  )
    throw new Error('expected roots must be sha256 content roots');
  if (
    git(buildchainRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
  )
    throw new Error('--buildchain-root must be clean');
  childProcess.execFileSync(
    'git',
    [
      '-C',
      buildchainRoot,
      'merge-base',
      '--is-ancestor',
      BUILDCHAIN_REHEARSAL_MERGE,
      'HEAD',
    ],
    { stdio: 'ignore' },
  );
  const runtime = await import(
    pathToFileURL(
      path.join(
        buildchainRoot,
        'packages/core/publication-rehearsal-runtime.js',
      ),
    ).href
  );
  const capsule = JSON.parse(fs.readFileSync(capsulePath, 'utf8'));
  const result = await runtime.executePublicationRehearsal({
    capsule,
    capsuleRoot,
    mode: 'simulate',
    environment: {},
  });
  if (
    result.evidence.bindingRoot !== expectedBindingRoot ||
    result.transaction.transactionRoot !== expectedTransactionRoot
  )
    throw new Error(
      'portable deterministic roots differ from the admitted Mac run',
    );
  if (result.evidence.externalPublicationClaimed !== false)
    throw new Error('portable smoke claimed external publication');
  return {
    schema: 'kungfu.alpha-local-publication-portable-smoke/v1',
    status: 'passed',
    platform: process.platform,
    architecture: process.arch,
    mode: 'simulate',
    capsuleRoot: capsule.root,
    bindingRoot: result.evidence.bindingRoot,
    transactionRoot: result.transaction.transactionRoot,
    stateRoot: result.transaction.stateRoot,
    evidenceRoot: result.evidence.evidenceRoot,
    externalPublicationClaimed: false,
    buildchainSha: git(buildchainRoot, ['rev-parse', 'HEAD']),
    buildchainTree: git(buildchainRoot, ['rev-parse', 'HEAD^{tree}']),
    buildchainRequiredMerge: BUILDCHAIN_REHEARSAL_MERGE,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const report = await runPortableSmoke({
    capsule: options.capsule,
    capsuleRoot: options['capsule-root'],
    buildchainRoot: options['buildchain-root'],
    expectedBindingRoot: options['expected-binding-root'],
    expectedTransactionRoot: options['expected-transaction-root'],
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`alpha-local-publication-portable-smoke: ${error.message}`);
    process.exitCode = 1;
  });
}
