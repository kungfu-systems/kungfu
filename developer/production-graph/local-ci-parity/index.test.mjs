// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  compareParityArtifacts,
  runParityLane,
  verifyParityArtifacts,
} from './index.mjs';

const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname);

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function source() {
  return {
    repository: 'https://github.com/kungfu-systems/kungfu.git',
    revision: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'),
    dirty: false,
  };
}

function outputDir(t, label) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), `production-graph-${label}-`),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function success({ node }) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    stdout: `${JSON.stringify({ nodeId: node.id, status: 'succeeded' })}\n`,
    stderr: '',
    outputExceeded: false,
  };
}

test('one exact source produces exact local and protected-CI semantic roots', async (t) => {
  const protectedCiArtifactDir = outputDir(t, 'protected-ci');
  const localArtifactDir = outputDir(t, 'local');
  const reportFile = path.join(outputDir(t, 'report'), 'parity-report.json');
  const exactSource = source();
  await runParityLane({
    lane: 'protected-ci',
    outputDir: protectedCiArtifactDir,
    source: exactSource,
    delegate: success,
    observedEnvironment: {
      platform: 'linux',
      architecture: 'x64',
      nodeVersion: 'v24.13.0',
      classification: 'declared-environment-variance',
    },
  });
  await runParityLane({
    lane: 'local',
    outputDir: localArtifactDir,
    source: exactSource,
    delegate: success,
    observedEnvironment: {
      platform: 'darwin',
      architecture: 'arm64',
      nodeVersion: 'v24.13.0',
      classification: 'declared-environment-variance',
    },
  });
  const report = await compareParityArtifacts({
    protectedCiArtifactDir,
    localArtifactDir,
    outputFile: reportFile,
    source: exactSource,
  });
  assert.equal(report.status, 'parity');
  assert.equal(Object.keys(report.exactBindings).length, 15);
  assert.deepEqual(
    report.drift.map(({ dimension, classification }) => [
      dimension,
      classification,
    ]),
    [
      ['platform', 'declared-environment-variance'],
      ['architecture', 'declared-environment-variance'],
    ],
  );
  assert.deepEqual(readJson(reportFile), report);
});

test('retained artifacts fail closed when an exact output root is changed', async (t) => {
  const artifactDir = outputDir(t, 'tamper');
  const exactSource = source();
  await runParityLane({
    lane: 'protected-ci',
    outputDir: artifactDir,
    source: exactSource,
    delegate: success,
  });
  const lanePath = path.join(artifactDir, 'lane-receipt.json');
  const laneReceipt = readJson(lanePath);
  laneReceipt.bindings.outputSetRoot =
    'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  writeJson(lanePath, laneReceipt);
  await assert.rejects(
    verifyParityArtifacts(artifactDir, { source: exactSource }),
    /receiptRoot mismatch/u,
  );
});

test('valid but different execution output is classified and blocks parity', async (t) => {
  const protectedCiArtifactDir = outputDir(t, 'ci-output-drift');
  const localArtifactDir = outputDir(t, 'local-output-drift');
  const exactSource = source();
  await runParityLane({
    lane: 'protected-ci',
    outputDir: protectedCiArtifactDir,
    source: exactSource,
    delegate: success,
  });
  await runParityLane({
    lane: 'local',
    outputDir: localArtifactDir,
    source: exactSource,
    delegate: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      stdout: 'different but valid output\n',
      stderr: '',
      outputExceeded: false,
    }),
  });
  const report = await compareParityArtifacts({
    protectedCiArtifactDir,
    localArtifactDir,
    source: exactSource,
  });
  assert.equal(report.status, 'blocked-by-drift');
  const classifications = new Set(
    report.drift.map(({ classification }) => classification),
  );
  assert.equal(classifications.has('output-drift'), true);
  assert.equal(classifications.has('nondeterminism'), true);
});

test('post-merge advisory lane remains single-platform and authority-free', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/dev-post-merge-advisory.yml'),
    'utf8',
  );
  const job = workflow
    .slice(workflow.indexOf('  production_graph_parity:'))
    .split('\n  qualified_core_candidate:')[0];
  assert.match(job, /runs-on: ubuntu-24\.04/u);
  assert.match(workflow, /permissions:\n\s+actions: read\n\s+contents: read/u);
  assert.match(job, /node-version: "22"/u);
  assert.match(job, /ref: \$\{\{ needs\.prepare\.outputs\.target-sha \}\}/u);
  assert.doesNotMatch(job, /github\.event\.pull_request/u);
  assert.match(job, /production-graph:local-ci-parity run/u);
  assert.match(job, /production-graph:local-ci-parity verify/u);
  assert.doesNotMatch(job, /pull-requests: write|contents: write/u);
  assert.doesNotMatch(job, /gh pr (?:review|merge)|npm publish|release:/u);
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
