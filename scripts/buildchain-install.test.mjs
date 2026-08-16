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
  const sourceToolsBin = path.join(
    '/tmp',
    'kungfu-source-acceptance-tools',
    'bin',
  );
  assert.deepEqual(sourceToolBindings(plan), {
    pathEntry: sourceToolsBin,
    pytest: path.join(sourceToolsBin, 'pytest'),
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

test('reactivated AWS burst workflows use reviewed bounded Buildchain sources', () => {
  const retirement = JSON.parse(
    fs.readFileSync(
      path.join(
        repositoryRoot,
        'docs/qualification/gates/aws-burst-retirement.json',
      ),
      'utf8',
    ),
  );
  assert.equal(retirement.status, 'reactivated-v3');
  assert.equal(retirement.owner, 'kungfu-ci');
  assert.equal(retirement.runtimeSafety.workflowShellReferencesV2, false);
  assert.equal(retirement.runtimeSafety.buildchainRefInputsV2, false);
  assert.equal(retirement.runtimeSafety.operatorSuppliedBuildchainRef, false);
  assert.equal(retirement.runtimeSafety.burstRunnerWorkflows, 3);
  assert.match(retirement.evidence.historicalBuildchainRef, /^train\/v2\//);
  const buildchainSource = retirement.evidence.reviewedBuildchainV3Source;
  assert.equal(buildchainSource, '376fb92fa014102366111b9aaef4856486c1e499');
  assert.equal(retirement.evidence.windowsJitRepairPullRequest, 2083);
  assert.equal(
    retirement.evidence.windowsJitRepairMergeCommit,
    buildchainSource,
  );
  const windowsBuildchainSource =
    retirement.evidence.windowsCampaignSourceBindingMergeCommit;
  assert.equal(retirement.evidence.windowsCampaignLedgerPullRequest, 2210);
  assert.equal(
    retirement.evidence.windowsCampaignLedgerMergeCommit,
    'ab147fa02d4e17937818c89c1269483fa450d986',
  );
  assert.equal(
    retirement.evidence.windowsCampaignSourceBindingPullRequest,
    2212,
  );
  assert.equal(
    windowsBuildchainSource,
    '447936a3aa36415a39c75e92fc9b26b0774aeb75',
  );
  assert.equal(retirement.evidence.windowsUsd80PhaseCapPullRequest, 2229);
  const windowsUsd80PhaseCapSource =
    retirement.evidence.windowsUsd80PhaseCapMergeCommit;
  assert.equal(
    windowsUsd80PhaseCapSource,
    'ae9bd5385cfb8060fb2574521121f1a798e83c6f',
  );
  assert.equal(retirement.evidence.macosBudgetGuardPullRequest, 2525);
  const macosBudgetGuardSource =
    retirement.evidence.macosBudgetGuardMergeCommit;
  assert.equal(
    macosBudgetGuardSource,
    '56aee4f72e3b6beb9eead71c8d596640313f6e7d',
  );
  assert.equal(
    retirement.evidence.macosAllocateHostsPreflightPullRequest,
    2526,
  );
  const macosAllocateHostsPreflightSource =
    retirement.evidence.macosAllocateHostsPreflightMergeCommit;
  assert.equal(
    macosAllocateHostsPreflightSource,
    'b27e567473b4faee97b920bbbccf08e8412620b6',
  );
  assert.equal(retirement.evidence.macosFailedSourceRebindPullRequest, 2587);
  const macosFailedSourceRebindSource =
    retirement.evidence.macosFailedSourceRebindMergeCommit;
  assert.equal(
    macosFailedSourceRebindSource,
    '028383e592a8e942396c1792761ec66a4b0d6020',
  );
  assert.equal(retirement.evidence.macosHistoricalRebindPullRequest, 2599);
  assert.equal(
    retirement.evidence.macosHistoricalRebindMergeCommit,
    '1724840a37b2b80c9cd0c5d91a42b43ff8d270e4',
  );
  assert.equal(retirement.evidence.macosValidationWorkflowShell, 'v3');
  assert.equal(
    retirement.evidence.macosValidationTrain,
    'train/v3/v3.0/aws-macos-burst-20260811',
  );
  assert.equal(
    retirement.evidence.macosValidationTrainHead,
    '6b39d6f72224a8b2fa93c1bb997ed72cbed6cdf4',
  );
  const promotion = JSON.parse(
    fs.readFileSync(
      path.join(
        repositoryRoot,
        'docs/release-promotion-rehearsal.contract.json',
      ),
      'utf8',
    ),
  );
  const macosImmutableBuildSource =
    promotion.buildchain.build_workflow_shell_resolved_sha;
  assert.match(macosImmutableBuildSource, /^[0-9a-f]{40}$/);
  assert.equal(
    promotion.buildchain.build_runtime_resolved_sha,
    macosImmutableBuildSource,
  );

  for (const name of [
    'aws-us-linux-burst-qualification.yml',
    'aws-us-windows-burst-qualification.yml',
    'aws-us-macos-burst-qualification.yml',
  ]) {
    const workflow = fs.readFileSync(
      path.join(repositoryRoot, '.github/workflows', name),
      'utf8',
    );
    const expectedWorkflowShell =
      name === 'aws-us-windows-burst-qualification.yml'
        ? windowsUsd80PhaseCapSource
        : name === 'aws-us-macos-burst-qualification.yml'
          ? macosImmutableBuildSource
          : buildchainSource;
    const expectedBuildchainSource =
      name === 'aws-us-macos-burst-qualification.yml'
        ? macosImmutableBuildSource
        : expectedWorkflowShell;
    assert.match(workflow, /workflow_dispatch:/);
    assert.doesNotMatch(workflow, /\n {2}pull_request:|\n {2}push:/);
    if (name === 'aws-us-windows-burst-qualification.yml') {
      assert.match(workflow, /jobs:\n {2}trust:/);
      assert.match(workflow, /runs-on: ubuntu-24\.04/);
      assert.match(workflow, /Require write-capable actor/);
      assert.match(workflow, /\$env:EXPECTED_LABEL -notin \$labels/);
      assert.doesNotMatch(workflow, /if \(\$EXPECTED_LABEL -notin \$labels\)/);
    }
    const shellPins =
      workflow.match(
        new RegExp(
          `uses: kungfu-systems/buildchain/\\.github/workflows/\\.build\\.yml@${expectedWorkflowShell}`,
          'g',
        ),
      ) || [];
    const runtimePins =
      workflow.match(
        new RegExp(`buildchain-ref: ${expectedBuildchainSource}`, 'g'),
      ) || [];
    assert.ok(shellPins.length >= 1);
    assert.equal(runtimePins.length, shellPins.length);
    assert.doesNotMatch(workflow, /train\/v2|buildchain-ref:\s*[\r\n]/);
    if (name !== 'aws-us-macos-burst-qualification.yml')
      assert.doesNotMatch(workflow, /train\/v3/);
    assert.doesNotMatch(
      workflow,
      /secrets:\s*inherit|notar|signing|npm-publish|release-new-version|deploy/,
    );
    if (name === 'aws-us-windows-burst-qualification.yml') {
      assert.doesNotMatch(
        workflow,
        /permissions:\n {2}actions: read\n {2}contents: read\n {2}issues: write\n {2}id-token: write/,
      );
      assert.equal(
        (
          workflow.match(
            /permissions:\n {6}actions: read\n {6}contents: read\n {6}issues: write\n {6}id-token: write/g,
          ) || []
        ).length,
        2,
      );
    } else if (name === 'aws-us-macos-burst-qualification.yml') {
      assert.equal(
        (
          workflow.match(
            /permissions:\n {6}actions: read\n {6}contents: read\n {6}issues: write\n {6}id-token: write/g,
          ) || []
        ).length,
        1,
      );
    } else {
      assert.doesNotMatch(workflow, /id-token:\s*write/);
    }
  }
});

test('AWS Linux burst workflow is a manual-only CodeBuild v3 caller', () => {
  const workflow = fs.readFileSync(
    path.join(
      repositoryRoot,
      '.github/workflows/aws-us-linux-burst-qualification.yml',
    ),
    'utf8',
  );
  assert.match(workflow, /name: AWS US Linux Burst Qualification/);
  assert.match(workflow, /permissions:\n {2}contents: read/);
  assert.match(workflow, /runner-preset: aws-us-codebuild-linux/);
  assert.match(workflow, /aws-codebuild-project:/);
  assert.doesNotMatch(workflow, /\n {2}pull_request:|\n {2}push:/);
});

test('AWS Windows burst workflow preserves bounded full and cleanup exercises', () => {
  const workflow = fs.readFileSync(
    path.join(
      repositoryRoot,
      '.github/workflows/aws-us-windows-burst-qualification.yml',
    ),
    'utf8',
  );
  assert.match(workflow, /name: AWS US Windows Burst Qualification/);
  assert.match(
    workflow,
    /run-name: AWS Windows JIT \$\{\{ inputs\.campaign-id \}\} \$\{\{ inputs\.qualification-id \}\}/,
  );
  assert.match(workflow, /campaign-id:\n {8}description:/);
  assert.match(
    workflow,
    /group: aws-us-windows-burst-\$\{\{ inputs\.campaign-id \}\}-\$\{\{ inputs\.qualification-id \}\}/,
  );
  assert.match(workflow, /permissions:\n {2}contents: read/);
  assert.equal(
    (
      workflow.match(
        /permissions:\n {6}actions: read\n {6}contents: read\n {6}issues: write\n {6}id-token: write/g,
      ) || []
    ).length,
    2,
  );
  assert.match(
    workflow,
    /\n {2}trust:[\s\S]*?\n {4}permissions:\n {6}contents: read\n/,
  );
  assert.match(
    workflow,
    /\n {2}cleanup-exercise:[\s\S]*?\n {4}permissions:\n {6}contents: read\n/,
  );
  assert.match(workflow, /runner-preset: aws-us-ec2-windows-jit/);
  assert.match(workflow, /win-full-0\[1-3\]:full/);
  assert.match(workflow, /win-cancel:cancellation/);
  assert.match(workflow, /win-timeout:timeout/);
  assert.match(
    workflow,
    /\[\[ "\$\{CAMPAIGN_ID\}" =~ \^win-\[a-z0-9\]\[a-z0-9-\]\{2,15\}\$ \]\]/,
  );
  assert.match(
    workflow,
    /aws-us-ec2-windows-jit-\$\{CAMPAIGN_ID\}-\$\{QUALIFICATION_ID\}/,
  );
  assert.match(workflow, /timeout-minutes:/);
  assert.match(workflow, /\n {2}smoke:\n/);
  assert.match(workflow, /\n {2}full:\n/);
  assert.match(workflow, /if: \$\{\{ inputs\.mode == 'smoke' \}\}/);
  assert.match(workflow, /if: \$\{\{ inputs\.mode == 'full' \}\}/);
  assert.match(
    workflow,
    /aws-ec2-windows-runner-label: \$\{\{ inputs\.runner-label \}\}/,
  );
  assert.match(workflow, /require-install: false/);
  assert.match(workflow, /require-install: true/);
  assert.doesNotMatch(workflow, /needs\.trust\.outputs|fromJSON\(/);
});

test('AWS macOS burst workflow requires three sequential one-job JIT slots', () => {
  const workflow = fs.readFileSync(
    path.join(
      repositoryRoot,
      '.github/workflows/aws-us-macos-burst-qualification.yml',
    ),
    'utf8',
  );
  assert.match(workflow, /runner-preset: aws-us-ec2-macos-jit/);
  assert.match(workflow, /inputs\.qualification-id == 'mac-smoke-01'/);
  assert.match(workflow, /inputs\.qualification-id == 'mac-smoke-02'/);
  assert.match(workflow, /inputs\.qualification-id == 'mac-full-01'/);
  assert.match(
    workflow,
    /inputs\.runner-label == format\('aws-us-ec2-macos-jit-\{0\}', inputs\.qualification-id\)/,
  );
  assert.match(workflow, /group: aws-us-macos-burst/);
  assert.match(
    workflow,
    /permissions:\n {6}actions: read\n {6}contents: read\n {6}issues: write\n {6}id-token: write/,
  );
  assert.match(workflow, /aws-ec2-macos-runner-label:/);
  assert.doesNotMatch(workflow, /\n {2}trust:/);
});
