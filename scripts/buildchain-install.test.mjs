// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  installPlan,
  productToolchainBindings,
  sourceToolBindings,
} from './buildchain-install.mjs';

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
