// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { parse } from 'yaml';

const ROOT = process.cwd();
const BUILD_WORKFLOW = path.join(ROOT, '.github', 'workflows', 'build.yml');
const ARM_WORKFLOW = path.join(
  ROOT,
  '.github',
  'workflows',
  'linux-arm64-alpha-qualification.yml',
);

test('Linux ARM64 qualification is isolated from the common build matrix', () => {
  const common = fs.readFileSync(BUILD_WORKFLOW, 'utf8');
  const arm = parse(fs.readFileSync(ARM_WORKFLOW, 'utf8'));

  assert.doesNotMatch(common, /ubuntu-24\.04-arm/u);
  assert.doesNotMatch(common, /hub-cli-linux-arm64/u);
  assert.deepEqual(Object.keys(arm.jobs), ['preflight', 'artifact']);
  assert.equal(arm.jobs.artifact.needs, 'preflight');
  assert.match(
    arm.jobs.artifact.uses,
    /^kungfu-systems\/buildchain\/\.github\/workflows\/\.build\.yml@[0-9a-f]{40}$/u,
  );
});

test('Linux ARM64 runs artifact qualification with an independent budget', () => {
  const arm = parse(fs.readFileSync(ARM_WORKFLOW, 'utf8'));
  const inputs = arm.jobs.artifact.with;

  assert.equal(inputs['runner-preset'], 'custom');
  assert.match(inputs['platforms-json'], /ubuntu-24\.04-arm/u);
  assert.equal(inputs['require-install'], true);
  assert.equal(inputs['require-build'], true);
  assert.equal(
    inputs['build-command'],
    'node scripts/run-shifu-lifecycle.mjs cache-apply dist:cli',
  );
  assert.equal(inputs['require-verify'], false);
  assert.equal(inputs['lifecycle-timeout-minutes'], 240);
  assert.doesNotMatch(
    fs.readFileSync(ARM_WORKFLOW, 'utf8'),
    /run-release-qualification/u,
  );
});
