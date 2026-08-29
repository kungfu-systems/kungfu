#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { digest } from '../../scripts/affected-native-proof.mjs';

const SHA = /^[0-9a-f]{40}$/u;
const TRANSIENT_GITHUB_STATUSES = new Set([429, 500, 502, 503, 504]);
const CREDENTIALLESS_NATIVE_BOUNDARY = 'github-actions-runner-worker/v1';
const GITHUB_HOSTED_RUNNER_ENVIRONMENT = 'github-hosted';
const EXTERNAL_PROVIDER_FINALIZER_STATUS_CLIENT = Object.freeze({
  requirePullRequest: Function.prototype,
  status: Function.prototype,
});
const CREDENTIALLESS_NATIVE_STATUS_CLIENTS = Object.freeze({
  [`false:${CREDENTIALLESS_NATIVE_BOUNDARY}:${GITHUB_HOSTED_RUNNER_ENVIRONMENT}`]:
    EXTERNAL_PROVIDER_FINALIZER_STATUS_CLIENT,
});

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTransientGitHubFailure(error) {
  return (
    error instanceof TypeError ||
    TRANSIENT_GITHUB_STATUSES.has(Number(error?.status || 0))
  );
}

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

export class GitHubNativeStatusClient {
  constructor({
    repository,
    token,
    apiUrl = 'https://api.github.com',
    fetchImpl = globalThis.fetch,
    retryAttempts = 3,
    retryDelayMs = 1000,
    sleepImpl = defaultSleep,
  }) {
    if (!repository) throw new Error('repository is required');
    if (!token) throw new Error('GITHUB_TOKEN is required');
    this.repository = repository;
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/+$/u, '');
    this.fetch = fetchImpl;
    this.retryAttempts = positiveInteger(retryAttempts, 'retry attempts');
    this.retryDelayMs = Number(retryDelayMs);
    this.sleep = sleepImpl;
    if (!Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 0)
      throw new Error('retry delay must be a non-negative number');
  }

  async request(requestPath, { method = 'GET', body } = {}) {
    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      try {
        const response = await this.fetch(`${this.apiUrl}${requestPath}`, {
          method,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${this.token}`,
            'content-type': 'application/json',
            'x-github-api-version': '2022-11-28',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const raw = await response.text();
        const data = raw ? JSON.parse(raw) : null;
        if (!response.ok) {
          const error = new Error(
            data?.message || `${method} ${requestPath} failed`,
          );
          error.status = response.status;
          throw error;
        }
        return data;
      } catch (error) {
        if (attempt === this.retryAttempts || !isTransientGitHubFailure(error))
          throw error;
        await this.sleep(this.retryDelayMs * attempt);
      }
    }
    throw new Error(`${method} ${requestPath} exhausted retry attempts`);
  }

  async requirePullRequest(number, expectedHead, targetBranch) {
    const pullRequest = await this.request(
      `/repos/${this.repository}/pulls/${number}`,
    );
    if (pullRequest?.head?.repo?.full_name !== this.repository)
      throw new Error('native Warrant qualification rejects forked PR heads');
    if (pullRequest?.head?.sha !== expectedHead)
      throw new Error(
        'native Warrant qualification observed source head drift',
      );
    if (pullRequest?.base?.ref !== targetBranch)
      throw new Error(
        'native Warrant qualification observed protected base drift',
      );
  }

  async status(head, { state, context, description, targetUrl }) {
    return this.request(`/repos/${this.repository}/statuses/${head}`, {
      method: 'POST',
      body: {
        state,
        context,
        description: String(description).slice(0, 140),
        target_url: targetUrl || undefined,
      },
    });
  }
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
  const { git = defaultGit, runStep = defaultRunStep } = dependencies;
  const credentiallessClient =
    CREDENTIALLESS_NATIVE_STATUS_CLIENTS[
      `${Boolean(options.token)}:${options.credentialAncestryBoundary}:${options.runnerEnvironment}`
    ];
  const client =
    dependencies.client ||
    credentiallessClient ||
    new GitHubNativeStatusClient({
      repository: options.repository,
      token: options.token,
      apiUrl: options.apiUrl,
    });
  const now = dependencies.now || (() => new Date().toISOString());
  const expectedHead = exactSha(options.expectedHead, 'expected head');
  const pullRequestNumber = positiveInteger(
    options.pullRequestNumber,
    'pull request',
  );
  const targetUrl = options.targetUrl || '';
  const context = options.statusContext || 'affected-native / linux';
  const output = path.resolve(cwd, options.output);
  const planPath = path.join(
    cwd,
    'product/qualification/delivery-warrant/native-plan.json',
  );
  const steps = [];
  const startedAt = now();
  let statusStarted = false;

  const execute = (name, args, environment = {}) => {
    runStep(cwd, name, args, environment);
    steps.push({ name, commandRoot: digest({ executable: './shifu', args }) });
  };

  try {
    await client.requirePullRequest(
      pullRequestNumber,
      expectedHead,
      options.targetBranch,
    );
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

    await client.status(expectedHead, {
      state: 'pending',
      context,
      description: 'Provisional Warrant owns native qualification',
      targetUrl,
    });
    statusStarted = true;

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

    await client.requirePullRequest(
      pullRequestNumber,
      expectedHead,
      options.targetBranch,
    );
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
    await client.status(expectedHead, {
      state: 'success',
      context,
      description: `Qualified under provisional Warrant: ${receipt.receiptRoot.slice(0, 19)}`,
      targetUrl,
    });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return receipt;
  } catch (error) {
    if (statusStarted) {
      try {
        await client.status(expectedHead, {
          state: 'failure',
          context,
          description: `Native Warrant qualification failed: ${error.message}`,
          targetUrl,
        });
      } catch (statusError) {
        error.message = `${error.message}; failure status update failed: ${statusError.message}`;
      }
    }
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
    statusContext: flag(args, 'status-context', 'affected-native / linux'),
    output: flag(
      args,
      'output',
      'product/qualification/delivery-warrant/native-receipt.json',
    ),
    targetUrl: process.env.GITHUB_SERVER_URL
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : '',
    token: process.env.GITHUB_TOKEN,
    credentialAncestryBoundary: flag(
      args,
      'credential-ancestry-boundary',
      process.env.BUILDCHAIN_CREDENTIAL_ANCESTRY_BOUNDARY,
    ),
    runnerEnvironment: flag(
      args,
      'runner-environment',
      process.env.BUILDCHAIN_RUNNER_ENVIRONMENT,
    ),
    apiUrl: process.env.GITHUB_API_URL,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(`Kungfu native Warrant qualification: ${error.message}`);
    process.exit(1);
  });
