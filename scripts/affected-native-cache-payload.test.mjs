// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createPortableDevCachePlan,
  createPortableDevCacheReceipt,
} from '@kungfu-tech/buildchain/portable-dev-cache';

import {
  createAffectedNativeCachePromotion,
  sealAffectedNativeCachePayload,
} from './affected-native-cache-payload.mjs';
import { partitionAffectedNativePlan } from './run-core-affected-native.mjs';
import { affectedNativeCompilerPlanDigest } from './write-affected-native-cache-manifests.mjs';

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
    .update(JSON.stringify(ordered(value)))
    .digest('hex')}`;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createPlan() {
  const body = {
    schema: 'kungfu.core-affected-native-plan/v1',
    base: 'b'.repeat(40),
    head: 'a'.repeat(40),
    profile: 'embedded-sqlite',
    platformTier: 'github-hosted-linux-native-pr',
    closureComponents: ['storage-runtime'],
    targets: ['kungfu', 'test-a', 'yijinjing', 'test-b'],
    tests: ['test-a', 'test-b'],
    authority: {
      layers: `sha256:${'c'.repeat(64)}`,
      buildCapabilities: `sha256:${'d'.repeat(64)}`,
    },
  };
  return { ...body, planDigest: digest(body) };
}

function createCachePlan(layer, sourceSha, planDigest) {
  return createPortableDevCachePlan({
    schema: 'buildchain.portable-dev-cache-manifest/v1',
    layer,
    roots:
      layer === 'dependency'
        ? [{ id: 'conan-packages', path: '~/.conan2/p' }]
        : [{ id: 'ccache', path: '~/.cache/ccache' }],
    identity: {
      platform: 'linux',
      arch: 'x64',
      runnerImage: 'ubuntu24',
      toolchainDigest: `sha256:${'1'.repeat(64)}`,
      dependencyLockDigest: `sha256:${'2'.repeat(64)}`,
      profileDigest: `sha256:${'3'.repeat(64)}`,
      sourceSha,
      planDigest,
    },
  });
}

function createArchive(home, archive, layer, marker, unsafeSymlink = false) {
  const relative = layer === 'dependency' ? '.conan2/p' : '.cache/ccache';
  const root = path.join(home, relative);
  fs.mkdirSync(root, { recursive: true });
  if (unsafeSymlink) fs.symlinkSync('/etc/passwd', path.join(root, marker));
  else fs.writeFileSync(path.join(root, marker), marker);
  const result = spawnSync(
    'tar',
    ['--format=ustar', '-cf', archive, '-C', home, relative],
    {
      encoding: 'utf8',
      shell: false,
    },
  );
  assert.equal(result.status, 0, result.stderr);
}

function createPartitionArtifact({
  artifactsRoot,
  plan,
  partitionIndex,
  partitionCount,
  repository,
  runId,
  unsafeCompilerSymlink = false,
}) {
  const artifact = path.join(
    artifactsRoot,
    `core-affected-native-${plan.head}-partition-${partitionIndex}-of-${partitionCount}`,
  );
  const qualification = path.join(
    artifact,
    'product/qualification/affected-native',
  );
  const payloadRoot = path.join(qualification, 'cache/payload');
  fs.mkdirSync(payloadRoot, { recursive: true });
  writeJson(path.join(qualification, 'plan.json'), plan);
  const partition = partitionAffectedNativePlan(
    plan,
    partitionCount,
    partitionIndex,
  );
  const dependencyPlan = createCachePlan(
    'dependency',
    plan.head,
    plan.planDigest,
  );
  const compilerPlan = createCachePlan(
    'compiler',
    plan.head,
    affectedNativeCompilerPlanDigest(plan.planDigest, partition),
  );
  for (const [layer, cachePlan] of [
    ['dependency', dependencyPlan],
    ['compiler', compilerPlan],
  ]) {
    writeJson(path.join(qualification, `cache/${layer}.plan.json`), cachePlan);
    writeJson(
      path.join(qualification, `cache/${layer}.receipt.json`),
      createPortableDevCacheReceipt({
        plan: cachePlan,
        validationStatus: 'pass',
        coldFallbackStatus: 'passed',
      }),
    );
  }
  const home = path.join(artifact, 'home');
  const compilerArchive = path.join(payloadRoot, 'compiler.tar');
  createArchive(
    home,
    compilerArchive,
    'compiler',
    `object-${partitionIndex}`,
    unsafeCompilerSymlink,
  );
  let dependencyArchive = '';
  if (partitionIndex === 0) {
    dependencyArchive = path.join(payloadRoot, 'dependency.tar');
    createArchive(home, dependencyArchive, 'dependency', 'package');
  }
  sealAffectedNativeCachePayload({
    qualificationDir: qualification,
    output: path.join(payloadRoot, 'payload.manifest.json'),
    partitionIndex,
    partitionCount,
    repository,
    runId,
    event: 'merge_group',
    headSha: plan.head,
    compilerArchive,
    dependencyArchive,
  });
  return artifact;
}

test('qualified merge-group partitions form one default-branch cache promotion', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-cache-promotion-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = createPlan();
  const repository = 'kungfu-systems/kungfu';
  const runId = 12345;
  for (const partitionIndex of [0, 1]) {
    createPartitionArtifact({
      artifactsRoot: root,
      plan,
      partitionIndex,
      partitionCount: 2,
      repository,
      runId,
    });
  }
  const promotion = createAffectedNativeCachePromotion({
    artifactsDir: root,
    expectedHeadSha: plan.head,
    expectedRunId: runId,
    expectedRepository: repository,
  });
  assert.equal(promotion.sourceSha, plan.head);
  assert.equal(promotion.partitionCount, 2);
  assert.equal(promotion.dependency.partitionIndex, 0);
  assert.equal(promotion.compiler.archives.length, 2);
  assert.equal(
    promotion.compiler.compatibilityDigest,
    `sha256:${promotion.compiler.compatibilityDigest.slice(7)}`,
  );
});

test('cache promotion fails closed on an incomplete partition set', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-cache-promotion-incomplete-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = createPlan();
  createPartitionArtifact({
    artifactsRoot: root,
    plan,
    partitionIndex: 0,
    partitionCount: 2,
    repository: 'kungfu-systems/kungfu',
    runId: 12345,
  });
  assert.throws(
    () =>
      createAffectedNativeCachePromotion({
        artifactsDir: root,
        expectedHeadSha: plan.head,
        expectedRunId: 12345,
        expectedRepository: 'kungfu-systems/kungfu',
      }),
    /partition set is incomplete/,
  );
});

test('push promotion waits for the exact required Gate instead of whole-run completion', () => {
  const workflow = fs.readFileSync(
    '.github/workflows/affected-native-cache-promote.yml',
    'utf8',
  );
  assert.match(workflow, /head_sha="\$GITHUB_SHA"/u);
  assert.match(workflow, /actions\/runs\/\$\{run_id\}\/jobs/u);
  assert.match(workflow, /\.name == "affected-native \/ linux"/u);
  assert.match(workflow, /artifact_state.*complete/su);
  assert.match(workflow, /while \[ "\$attempt" -le 60 \]/u);
  assert.doesNotMatch(workflow, /status=completed/u);
});

test('cache payload sealing rejects symlinks before trusted extraction', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-cache-promotion-symlink-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () =>
      createPartitionArtifact({
        artifactsRoot: root,
        plan: createPlan(),
        partitionIndex: 0,
        partitionCount: 2,
        repository: 'kungfu-systems/kungfu',
        runId: 12345,
        unsafeCompilerSymlink: true,
      }),
    /non-file entry/,
  );
});
