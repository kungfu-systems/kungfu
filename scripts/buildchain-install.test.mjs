// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createCodeBuildQualification,
  installPlan,
  productToolchainBindings,
  sourceToolBindings,
  verifyCodeBuildQualification,
} from './buildchain-install.mjs';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('source install provisions only build-free tools from wheels', () => {
  const plan = installPlan({
    BUILDCHAIN_CHECK_MODE: 'source',
    CI: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux',
    RUNNER_TEMP: '/tmp',
  });
  const text = JSON.stringify(plan);
  assert.match(text, /--ignore-scripts/);
  assert.match(text, /--only-binary=:all:/);
  assert.match(text, /ruff==0\.15\.20/);
  assert.match(text, /mypy==1\.20\.2/);
  assert.match(text, /clang-format==20\.1\.8/);
  assert.match(text, /pytest==9\.1\.1/);
  assert.match(text, /click==8\.1\.8/);
  assert.match(text, /jsonschema==4\.25\.1/);
  assert.match(text, /flatbuffers==25\.12\.19/);
  assert.match(text, /psutil==6\.1\.1/);
  assert.match(text, /tabulate==0\.9\.0/);
  assert.doesNotMatch(text, /cargo|cmake|conan|ninja|dist|verify|build\b/i);
  assert.deepEqual(sourceToolBindings(plan), {
    pathEntry: '/tmp/kungfu-source-acceptance-tools/bin',
    pytest: '/tmp/kungfu-source-acceptance-tools/bin/pytest',
  });
});

test('source install fails closed off GitHub-hosted Linux in CI', () => {
  assert.throws(
    () =>
      installPlan({
        BUILDCHAIN_CHECK_MODE: 'source',
        CI: 'true',
        RUNNER_ENVIRONMENT: 'self-hosted',
        RUNNER_OS: 'Linux',
      }),
    /GitHub-hosted Linux/,
  );
});

test('verify install preserves the existing Shifu lifecycle', () => {
  const plan = installPlan({ BUILDCHAIN_CHECK_MODE: 'verify' });
  const text = JSON.stringify(plan);
  assert.match(text, /cache-apply[^}]*doctor/);
  assert.match(
    text,
    /cache-apply[^}]*install[^}]*--frozen-lockfile[^}]*--no-optional/,
  );
  for (const step of plan) {
    assert.notEqual(step.command.split(/[\\/]/).at(-1), 'bash');
    assert.ok(!step.args.includes('-c'));
  }
});

test('AWS CodeBuild installs the matching platform optional packages', () => {
  const plan = installPlan({
    BUILDCHAIN_CHECK_MODE: 'verify',
    CODEBUILD_BUILD_ID: 'kungfu-buildchain-linux-burst-poc:build-id',
    RUNNER_OS: 'Linux',
  });
  const text = JSON.stringify(plan);
  assert.match(text, /cache-apply[^}]*install[^}]*--frozen-lockfile/);
  assert.doesNotMatch(text, /--no-optional/);
});

test('GitHub-hosted Linux product qualification binds the admitted GCC toolchain', () => {
  assert.deepEqual(
    productToolchainBindings({
      BUILDCHAIN_CHECK_MODE: 'verify',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_OS: 'Linux',
    }),
    {
      CC: 'gcc-14',
      CXX: 'g++-14',
    },
  );
  assert.deepEqual(
    productToolchainBindings({
      BUILDCHAIN_CHECK_MODE: 'verify',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_OS: 'Linux',
      CC: 'custom-cc',
      CXX: 'custom-cxx',
    }),
    {
      CC: 'custom-cc',
      CXX: 'custom-cxx',
    },
  );
  assert.deepEqual(
    productToolchainBindings({
      BUILDCHAIN_CHECK_MODE: 'source',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_OS: 'Linux',
    }),
    {},
  );
  assert.deepEqual(
    productToolchainBindings({
      BUILDCHAIN_CHECK_MODE: 'verify',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_OS: 'macOS',
    }),
    {},
  );
});

function codeBuildFixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-codebuild-qualification-'),
  );
  const release = path.join(root, 'framework/core/build/Release');
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(path.join(release, 'kungfubuildinfo.json'), '{}\n');
  fs.writeFileSync(path.join(release, 'libkungfu.so'), 'binary');
  return root;
}

function codeBuildEnvironment() {
  return {
    BUILDCHAIN_TEST_PLATFORM: 'linux',
    BUILDCHAIN_SOURCE_SHA: 'a'.repeat(40),
    BUILDCHAIN_SOURCE_REF: 'refs/heads/dev/v4/v4.0',
    GITHUB_REPOSITORY: 'kungfu-systems/kungfu',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKFLOW: 'AWS US Linux Burst Qualification',
    GITHUB_JOB: 'qualify',
    AWS_REGION: 'us-east-1',
    CODEBUILD_BUILD_ID: 'kungfu-buildchain-linux-burst-poc:build-id',
    CODEBUILD_BUILD_ARN:
      'arn:aws:codebuild:us-east-1:123:build/kungfu-buildchain-linux-burst-poc:build-id',
    CODEBUILD_INITIATOR: 'GitHub-Hookshot/abc',
  };
}

test('AWS CodeBuild qualification binds exact source and retained output', () => {
  const root = codeBuildFixture();
  const report = createCodeBuildQualification({
    root,
    env: codeBuildEnvironment(),
    observedAt: '2026-07-28T12:00:00Z',
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.files.length, 2);
  assert.equal(verifyCodeBuildQualification({ root, report }), report);
  fs.writeFileSync(
    path.join(root, 'framework/core/build/Release/libkungfu.so'),
    'changed',
  );
  assert.throws(
    () => verifyCodeBuildQualification({ root, report }),
    /qualification file drift/,
  );
});

test('AWS CodeBuild qualification rejects static and release credentials', () => {
  const root = codeBuildFixture();
  for (const credential of ['AWS_ACCESS_KEY_ID', 'NPM_TOKEN']) {
    assert.throws(
      () =>
        createCodeBuildQualification({
          root,
          env: { ...codeBuildEnvironment(), [credential]: 'forbidden' },
        }),
      /forbidden credential environment/,
    );
  }
});

test('retired AWS burst workflows fail closed before runner or cloud work', () => {
  const retirement = JSON.parse(
    fs.readFileSync(
      path.join(
        repositoryRoot,
        'docs/qualification/gates/aws-burst-retirement.json',
      ),
      'utf8',
    ),
  );
  assert.equal(retirement.status, 'retired');
  assert.equal(retirement.owner, 'kungfu-ci');
  assert.equal(retirement.runtimeSafety.workflowShellReferencesV2, false);
  assert.equal(retirement.runtimeSafety.buildchainRefInputsV2, false);
  assert.equal(retirement.runtimeSafety.burstRunnerJobs, 0);
  assert.equal(retirement.runtimeSafety.cloudJobs, 0);
  assert.match(retirement.evidence.historicalBuildchainRef, /^train\/v2\//);
  assert.match(
    retirement.evidence.reviewedBuildchainV3Source,
    /^[0-9a-f]{40}$/,
  );

  for (const name of [
    'aws-us-linux-burst-qualification.yml',
    'aws-us-windows-burst-qualification.yml',
  ]) {
    const workflow = fs.readFileSync(
      path.join(repositoryRoot, '.github/workflows', name),
      'utf8',
    );
    assert.match(workflow, /workflow_dispatch:/);
    assert.doesNotMatch(workflow, /\n {2}pull_request:|\n {2}push:/);
    assert.match(workflow, /jobs:\n {2}retired:/);
    assert.match(workflow, /runs-on: ubuntu-24\.04/);
    assert.match(
      workflow,
      /docs\/qualification\/gates\/aws-burst-retirement\.json/,
    );
    assert.match(workflow, /exit 1/);
    assert.doesNotMatch(
      workflow,
      /train\/v2|kungfu-systems\/buildchain|runner-preset|aws-codebuild-project|aws-ec2-windows-runner-label|issues:\s*write|id-token:\s*write/,
    );
  }
});

test('retired AWS Linux burst workflow preserves no runnable v2 caller', () => {
  const workflow = fs.readFileSync(
    path.join(
      repositoryRoot,
      '.github/workflows/aws-us-linux-burst-qualification.yml',
    ),
    'utf8',
  );
  assert.match(workflow, /AWS US Linux Burst Qualification \(Retired\)/);
  assert.match(workflow, /permissions:\n {2}contents: read/);
  assert.doesNotMatch(
    workflow,
    /uses:|secrets:|notar|signing|npm-publish|release-new-version|deploy/,
  );
});

test('retired AWS Windows burst workflow preserves no runnable v2 caller', () => {
  const workflow = fs.readFileSync(
    path.join(
      repositoryRoot,
      '.github/workflows/aws-us-windows-burst-qualification.yml',
    ),
    'utf8',
  );
  assert.match(workflow, /AWS US Windows Burst Qualification \(Retired\)/);
  assert.match(workflow, /permissions:\n {2}contents: read/);
  assert.doesNotMatch(
    workflow,
    /uses:|secrets:|notar|signing|npm-publish|release-new-version|deploy/,
  );
});
