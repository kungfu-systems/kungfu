#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { digest } from '../../scripts/affected-native-proof.mjs';

const SHA = /^[0-9a-f]{40}$/u;

function flag(args, name, fallback = '') {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || '';
}

function exactSha(value, label) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!SHA.test(normalized))
    throw new Error(`${label} must be an exact Git SHA`);
  return normalized;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function defaultGit(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function defaultRunStep(cwd, name, args, environment) {
  process.stdout.write(`::group::${name}\n`);
  try {
    execFileSync('./shifu', args, {
      cwd,
      env: { ...process.env, ...environment },
      stdio: 'inherit',
    });
  } finally {
    process.stdout.write('::endgroup::\n');
  }
}

function currentBase(cwd, targetBranch, git) {
  try {
    return exactSha(git(cwd, ['rev-parse', 'MERGE_HEAD']), 'composed base');
  } catch {
    return exactSha(
      git(cwd, ['merge-base', 'HEAD', `origin/${targetBranch}`]),
      'ancestor base',
    );
  }
}

function sdkPath(cwd) {
  const store = path.join(cwd, 'node_modules', '.pnpm');
  if (!fs.existsSync(store)) return '';
  const packageName = fs
    .readdirSync(store)
    .sort()
    .find((entry) => entry.startsWith('cmake-js@'));
  if (!packageName) return '';
  return path.join(store, packageName, 'node_modules', 'cmake-js', 'bin');
}

export async function runNativeUnderWarrant(options, dependencies = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const git = dependencies.git || defaultGit;
  const runStep = dependencies.runStep || defaultRunStep;
  const now = dependencies.now || (() => new Date().toISOString());
  const expectedHead = exactSha(options.expectedHead, 'expected head');
  const pullRequestNumber = positiveInteger(
    options.pullRequestNumber,
    'pull request',
  );
  const output = path.resolve(cwd, options.output);
  const planPath = path.join(
    cwd,
    'product/qualification/delivery-warrant/native-plan.json',
  );
  const steps = [];
  const startedAt = now();

  const execute = (name, args, environment = {}) => {
    runStep(cwd, name, args, environment);
    steps.push({ name, commandRoot: digest({ executable: './shifu', args }) });
  };

  try {
    const checkoutHead = exactSha(
      git(cwd, ['rev-parse', 'HEAD']),
      'candidate checkout head',
    );
    if (checkoutHead !== expectedHead)
      throw new Error('composed candidate is not rooted at the exact PR head');
    const qualifiedBase = currentBase(cwd, options.targetBranch, git);
    if (git(cwd, ['ls-files', '-u']))
      throw new Error('composed candidate contains unresolved conflicts');
    git(cwd, ['diff', '--check'], { stdio: 'pipe' });

    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    execute(
      'Plan current affected closure',
      ['core:affected', '--', '--plan-out', planPath, '--json'],
      { GITHUB_BASE_SHA: qualifiedBase, GITHUB_HEAD_SHA: expectedHead },
    );
    const plan = dependencies.readPlan
      ? dependencies.readPlan(planPath)
      : JSON.parse(fs.readFileSync(planPath, 'utf8'));
    if (plan?.schema !== 'kungfu.core-affected-native-plan/v1')
      throw new Error('native Warrant requires an exact affected-native plan');

    const nativeRequired = (plan.closureComponents || []).length > 0;
    const sdkRequired = plan.sdkQualification?.required === true;
    const shifuRequired =
      plan.devQueueQualification?.shifuWorkspace?.required === true;
    const kfdRequired =
      plan.devQueueQualification?.kfdVerifier?.required === true;
    const anyRequired =
      nativeRequired || sdkRequired || shifuRequired || kfdRequired;
    if (anyRequired)
      execute('Install frozen workspace', ['install', '--frozen-lockfile']);

    const toolchainEnvironment = { CC: 'gcc-14', CXX: 'g++-14' };
    if (sdkRequired) {
      const cmakeJs = sdkPath(cwd);
      const sdkEnvironment = {
        ...toolchainEnvironment,
        KUNGFU_BUILDCHAIN_SOURCE_BUILD: '1',
        PATH: cmakeJs ? `${cmakeJs}:${process.env.PATH}` : process.env.PATH,
      };
      execute('Build Core SDK artifacts', ['build:core:sdk'], sdkEnvironment);
      execute('Pack four-language SDK artifacts', ['pack:sdk'], sdkEnvironment);
      execute(
        'Qualify installed SDK wire contract',
        [
          'layers:qualify:sdk',
          '--',
          '--report',
          'product/qualification/delivery-warrant/layered-sdk-report.json',
        ],
        sdkEnvironment,
      );
    }
    if (nativeRequired) {
      for (const partition of ['0', '1']) {
        execute(
          `Run affected native partition ${partition} of 2`,
          [
            'gate',
            'run',
            'source.changed-scope',
            '--omit-dependency',
            'source.acceptance',
            '--capability',
            'native-toolchain',
          ],
          {
            ...toolchainEnvironment,
            GITHUB_BASE_SHA: qualifiedBase,
            GITHUB_HEAD_SHA: expectedHead,
            KUNGFU_BUILDCHAIN_SOURCE_BUILD: '1',
            KUNGFU_AFFECTED_NATIVE_PLAN: planPath,
            KUNGFU_AFFECTED_NATIVE_PARTITION_COUNT: '2',
            KUNGFU_AFFECTED_NATIVE_PARTITION_INDEX: partition,
          },
        );
      }
    }
    if (shifuRequired)
      execute('Run Shifu workspace Gate', [
        'gate',
        'run',
        'shifu.workspace',
        '--capability',
        'rust',
      ]);
    if (kfdRequired)
      execute('Verify product-owned KFD fixtures', [
        'kfd:verify-owned-fixtures',
      ]);

    const receiptBody = {
      schema: 'kungfu.dev-delivery-native-under-warrant/v1',
      outcome: 'succeeded',
      repository: options.repository,
      targetBranch: options.targetBranch,
      pullRequestNumber,
      sourceHead: expectedHead,
      qualifiedBase,
      candidateTree: exactSha(
        git(cwd, ['write-tree']),
        'qualified candidate tree',
      ),
      planRoot: digest(plan),
      steps,
      startedAt,
      completedAt: now(),
    };
    const receipt = { ...receiptBody, receiptRoot: digest(receiptBody) };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return receipt;
  } catch (error) {
    error.message = `credentialless native qualification failed: ${error.message}`;
    throw error;
  }
}

async function main() {
  const args = process.argv.slice(2);
  await runNativeUnderWarrant({
    repository: flag(args, 'repository', process.env.GITHUB_REPOSITORY),
    targetBranch: flag(args, 'target-branch', process.env.GITHUB_BASE_REF),
    pullRequestNumber: flag(args, 'pull-request'),
    expectedHead: flag(args, 'expected-head'),
    output: flag(
      args,
      'output',
      'product/qualification/delivery-warrant/native-receipt.json',
    ),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(`Kungfu native Warrant qualification: ${error.message}`);
    process.exit(1);
  });
