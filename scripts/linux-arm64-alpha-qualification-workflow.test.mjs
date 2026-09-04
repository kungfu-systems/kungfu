// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { parse } from 'yaml';
import { activeProjection } from '../product/version-line/version-line-authority.mjs';

const ROOT = process.cwd();
const BUILD_WORKFLOW = path.join(ROOT, '.github', 'workflows', 'build.yml');
const ARM_WORKFLOW = path.join(
  ROOT,
  '.github',
  'workflows',
  'linux-arm64-alpha-qualification.yml',
);
const ARM_CACHE_PROFILE = path.join(
  ROOT,
  'docs',
  'shifu',
  'linux-arm64-qualification-portable-off.cache-profile.json',
);

test('Linux ARM64 Hub qualification remains isolated from the authority-derived product matrix', () => {
  const common = fs.readFileSync(BUILD_WORKFLOW, 'utf8');
  const arm = parse(fs.readFileSync(ARM_WORKFLOW, 'utf8'));

  assert.match(
    common,
    new RegExp(
      JSON.stringify(
        activeProjection().projection.runnerRouting.matrices.native,
      ).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
      'u',
    ),
  );
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
  assert.match(
    inputs['install-command'],
    /apt-get install -y gcc-14 g\+\+-14/u,
  );
  assert.match(inputs['install-command'], /CC=gcc-14 CXX=g\+\+-14/u);
  assert.match(inputs['install-command'], /scripts\/buildchain-install\.mjs/u);
  assert.equal(inputs['require-build'], true);
  assert.equal(
    inputs['build-command'],
    'node scripts/run-shifu-lifecycle.mjs cache-apply dist:cli',
  );
  assert.equal(inputs['require-verify'], true);
  assert.equal(
    inputs['verify-command'],
    'node product/scripts/verify-cli-surface-qualification.mjs --qualification product/release/cli/kungfu-episodes-cli-linux-arm64.qualification.json --archive product/release/cli/kungfu-episodes-cli-linux-arm64.tar.gz --platform linux-arm64',
  );
  assert.equal(inputs['lifecycle-timeout-minutes'], 240);
  assert.equal(inputs['checkout-cache-mode'], 'off');
  assert.equal(inputs['cargo-registry-index'], undefined);
  assert.equal(
    inputs['shifu-cache-profile-ref'],
    'docs/shifu/linux-arm64-qualification-portable-off.cache-profile.json',
  );
  assert.equal(
    inputs['shifu-cache-profile-digest'],
    'sha256:92b19f65a4e75c16cf11f43f37a1778f6ab61db62a68fc849e51f7d3aaac65f5',
  );
  const profileBytes = fs.readFileSync(ARM_CACHE_PROFILE);
  const profile = JSON.parse(profileBytes.toString('utf8'));
  assert.deepEqual(profile.subject.platforms, ['linux-arm64']);
  assert.equal(profile.policy.mode, 'off');
  assert.equal(
    inputs['shifu-cache-profile-digest'],
    `sha256:${crypto.createHash('sha256').update(profileBytes).digest('hex')}`,
  );
  assert.doesNotMatch(
    fs.readFileSync(ARM_WORKFLOW, 'utf8'),
    /run-release-qualification/u,
  );
  assert.doesNotMatch(
    fs.readFileSync(ARM_WORKFLOW, 'utf8'),
    /BUILDCHAIN_CARGO_REGISTRY_INDEX/u,
  );
});
