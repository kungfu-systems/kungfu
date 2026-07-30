#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIFECYCLE_DISPATCHER = path.join(
  ROOT,
  'scripts',
  'run-shifu-lifecycle.mjs',
);
const CODEBUILD_QUALIFICATION_CONTRACT =
  'kungfu-aws-codebuild-linux-qualification/v1';
const FORBIDDEN_CODEBUILD_CREDENTIAL_ENV = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'NOTARYTOOL_PASSWORD',
];

/** @typedef {{command: string, args: string[], cwd?: string}} Command */

/** @param {NodeJS.ProcessEnv} env */
export function installPlan(env = process.env) {
  if (env.BUILDCHAIN_CHECK_MODE !== 'source') {
    const installArgs = [
      LIFECYCLE_DISPATCHER,
      'cache-apply',
      'install',
      '--frozen-lockfile',
    ];
    if (!(env.CODEBUILD_BUILD_ID && env.RUNNER_OS === 'Linux')) {
      installArgs.push('--no-optional');
    }
    return [
      {
        command: process.execPath,
        args: [LIFECYCLE_DISPATCHER, 'cache-apply', 'doctor'],
      },
      {
        command: process.execPath,
        args: installArgs,
      },
    ];
  }

  if (
    env.CI === 'true' &&
    (env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.RUNNER_OS !== 'Linux')
  ) {
    throw new Error(
      'source acceptance is restricted to GitHub-hosted Linux runners',
    );
  }

  const tools = path.join(
    env.RUNNER_TEMP || os.tmpdir(),
    'kungfu-source-acceptance-tools',
  );
  const python = path.join(tools, 'bin', 'python');
  return [
    {
      command: 'corepack',
      args: ['pnpm@11.7.0', 'install', '--frozen-lockfile', '--ignore-scripts'],
    },
    { command: 'python3', args: ['-m', 'venv', tools] },
    {
      command: python,
      args: [
        '-m',
        'pip',
        'install',
        '--disable-pip-version-check',
        '--only-binary=:all:',
        'ruff==0.15.20',
        'mypy==1.20.2',
        'clang-format==20.1.8',
        'pytest==9.1.1',
        'click==8.1.8',
        'jsonschema==4.25.1',
        'flatbuffers==25.12.19',
        'psutil==6.1.1',
        'tabulate==0.9.0',
      ],
    },
  ];
}

/** @param {Command[]} plan */
export function sourceToolBindings(plan) {
  const tools = path.dirname(plan.at(-1)?.command || '');
  if (!tools) throw new Error('source tool plan has no executable directory');
  return {
    pathEntry: tools,
    pytest: path.join(tools, 'pytest'),
  };
}

/** @param {NodeJS.ProcessEnv} env */
export function productToolchainBindings(env = process.env) {
  if (
    env.BUILDCHAIN_CHECK_MODE === 'source' ||
    env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    env.RUNNER_OS !== 'Linux'
  ) {
    return {};
  }
  return {
    CC: env.CC || 'gcc-14',
    CXX: env.CXX || 'g++-14',
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

function codeBuildFileEvidence(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.statSync(absolutePath).isFile())
    throw new Error(`${relativePath} is not a regular file`);
  return {
    path: relativePath,
    bytes: fs.statSync(absolutePath).size,
    sha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(absolutePath))
      .digest('hex'),
  };
}

function requiredCodeBuildFiles(root) {
  const release = path.join(root, 'framework/core/build/Release');
  const library = fs
    .readdirSync(release)
    .find(
      (entry) => entry === 'libkungfu.so' || /^libkungfu\.so\./u.test(entry),
    );
  if (!library)
    throw new Error('Linux core build did not produce libkungfu.so');
  return [
    'framework/core/build/Release/kungfubuildinfo.json',
    `framework/core/build/Release/${library}`,
  ];
}

export function createCodeBuildQualification({
  root = ROOT,
  env = process.env,
  observedAt = new Date().toISOString(),
} = {}) {
  if (process.platform !== 'linux' && env.BUILDCHAIN_TEST_PLATFORM !== 'linux')
    throw new Error('AWS CodeBuild qualification must execute on Linux');
  const exposedCredentials = FORBIDDEN_CODEBUILD_CREDENTIAL_ENV.filter((name) =>
    String(env[name] || '').trim(),
  );
  if (exposedCredentials.length)
    throw new Error(
      `forbidden credential environment is exposed: ${exposedCredentials.join(', ')}`,
    );
  const sourceSha = String(env.BUILDCHAIN_SOURCE_SHA || env.GITHUB_SHA || '')
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(sourceSha))
    throw new Error('BUILDCHAIN_SOURCE_SHA must be an exact Git commit');
  const buildId = String(env.CODEBUILD_BUILD_ID || '').trim();
  const buildArn = String(env.CODEBUILD_BUILD_ARN || '').trim();
  if (!buildId || !buildArn)
    throw new Error('CodeBuild build id and ARN are required');
  const payload = {
    schemaVersion: 1,
    contract: CODEBUILD_QUALIFICATION_CONTRACT,
    status: 'passed',
    provider: 'aws-codebuild',
    phase: 'linux-codebuild-poc-under-usd-50',
    source: {
      repository: String(env.GITHUB_REPOSITORY || '').trim(),
      sha: sourceSha,
      ref: String(env.BUILDCHAIN_SOURCE_REF || env.GITHUB_REF || '').trim(),
    },
    github: {
      runId: String(env.GITHUB_RUN_ID || '').trim(),
      runAttempt: String(env.GITHUB_RUN_ATTEMPT || '').trim(),
      workflow: String(env.GITHUB_WORKFLOW || '').trim(),
      job: String(env.GITHUB_JOB || '').trim(),
    },
    aws: {
      region: String(env.AWS_REGION || env.AWS_DEFAULT_REGION || '').trim(),
      project: buildId.split(':')[0],
      buildId,
      buildArn,
      initiator: String(env.CODEBUILD_INITIATOR || '').trim(),
    },
    isolation: {
      ephemeralSingleJob: true,
      forbiddenCredentialEnvironment: exposedCredentials,
      signing: false,
      notarization: false,
      publication: false,
      deployment: false,
    },
    files: requiredCodeBuildFiles(root).map((file) =>
      codeBuildFileEvidence(root, file),
    ),
    observedAt: new Date(observedAt).toISOString(),
  };
  return { ...payload, digest: digest(payload) };
}

export function verifyCodeBuildQualification({ root = ROOT, report } = {}) {
  if (
    !report ||
    report.contract !== CODEBUILD_QUALIFICATION_CONTRACT ||
    report.status !== 'passed'
  )
    throw new Error(
      `qualification report must be a passed ${CODEBUILD_QUALIFICATION_CONTRACT}`,
    );
  const { digest: declaredDigest, ...payload } = report;
  if (declaredDigest !== digest(payload))
    throw new Error('qualification report digest mismatch');
  for (const expected of report.files || []) {
    const actual = codeBuildFileEvidence(root, expected.path);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
      throw new Error(`qualification file drift: ${expected.path}`);
  }
  return report;
}

function runCodeBuildQualification(mode) {
  const output = path.resolve(
    process.env.KUNGFU_AWS_CODEBUILD_REPORT ||
      'product/release/qualification/aws-codebuild-linux.json',
  );
  if (mode === 'record') {
    const report = createCodeBuildQualification();
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  } else if (mode === 'verify') {
    verifyCodeBuildQualification({
      report: JSON.parse(fs.readFileSync(output, 'utf8')),
    });
  } else {
    throw new Error(`unsupported CodeBuild qualification mode: ${mode}`);
  }
  console.log(`[buildchain-install] CodeBuild qualification: ${output}`);
}

/** @param {Command} step */
function run(step) {
  console.log(`[buildchain-install] $ ${step.command} ${step.args.join(' ')}`);
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd || ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${step.command} failed: ${result.error?.message || result.status}`,
    );
  }
}

function main() {
  if (process.argv[2] === 'qualify-codebuild') {
    runCodeBuildQualification(process.argv[3] || 'record');
    return;
  }
  const productBindings = productToolchainBindings();
  if (Object.keys(productBindings).length > 0) {
    if (!process.env.GITHUB_ENV) {
      throw new Error(
        'GITHUB_ENV is required for GitHub-hosted Linux product qualification',
      );
    }
    for (const [name, value] of Object.entries(productBindings)) {
      process.env[name] = value;
      fs.appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
    }
    console.log(
      `[buildchain-install] Linux product toolchain ready: ${productBindings.CXX}`,
    );
  }
  const plan = installPlan();
  for (const step of plan) run(step);
  if (process.env.BUILDCHAIN_CHECK_MODE === 'source') {
    const bindings = sourceToolBindings(plan);
    if (!process.env.GITHUB_PATH) {
      throw new Error('GITHUB_PATH is required for source acceptance');
    }
    if (!process.env.GITHUB_ENV) {
      throw new Error('GITHUB_ENV is required for source acceptance');
    }
    fs.appendFileSync(process.env.GITHUB_PATH, `${bindings.pathEntry}\n`);
    fs.appendFileSync(
      process.env.GITHUB_ENV,
      `KUNGFU_READONLY_PYTEST=${bindings.pytest}\n`,
    );
    console.log(
      `[buildchain-install] source tools ready: ${bindings.pathEntry}`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(
      `[buildchain-install] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
