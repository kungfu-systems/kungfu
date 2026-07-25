// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const ADAPTER = path.join(ROOT, 'scripts', 'auditable-demo-adapter.py');
const SOURCE_SHA = '1'.repeat(40);
const DIGEST = `sha256:${'2'.repeat(64)}`;

function json(pathname, value) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`);
}

function report(source, schema, extra = {}) {
  return {
    schema,
    source: { revision: source, dirty: false },
    verdict: 'passed',
    ...extra,
  };
}

function fixture(root, { source = SOURCE_SHA, unsafeArchive = false } = {}) {
  const artifact = path.join(root, 'artifact', 'product', 'release');
  const qualification = path.join(artifact, 'qualification');
  json(path.join(qualification, 'layer-qualification-summary.json'), {
    schema: 'kungfu.layer-qualification-summary/v1',
    status: 'passed',
    reuse: { tuple: { sourceRevision: source } },
  });
  json(
    path.join(qualification, 'live-peer-continuity', 'report.json'),
    report(source, 'kungfu.runtime.live-peer-continuity-qualification/v1'),
  );
  json(
    path.join(qualification, 'runtime-activation', 'report.json'),
    report(source, 'kungfu.runtime-activation.qualification-report/v1'),
  );
  json(
    path.join(qualification, 'zero-burden-desktop', 'report.json'),
    report(source, 'kungfu.zero-burden-desktop.qualification/v1'),
  );
  json(path.join(qualification, 'invariant-run.json'), {
    schema: 'kungfu.invariant-run/v1',
    source: { revision: source },
    summary: { verdict: 'verified' },
  });
  const coordinate = path.join(root, 'coordinate.json');
  json(coordinate, {
    schema: 'buildchain.github-artifact-coordinate/v1',
    repository: 'kungfu-systems/kungfu',
    runId: '123',
    runAttempt: '1',
    sourceSha: source,
    id: '456',
    nodeId: 'A_kwDOFixture',
    name: `kungfu-linux-x64-${source}`,
    digest: DIGEST,
    sizeInBytes: 1024,
    createdAt: '2026-07-25T00:00:00Z',
    expiresAt: '2026-08-08T00:00:00Z',
  });

  const staging = path.join(root, 'staging');
  const productRoot = path.join(staging, 'kungfu-episodes-cli-linux-x64');
  fs.mkdirSync(path.join(productRoot, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(productRoot, 'upgrade'), { recursive: true });
  const launcher = path.join(productRoot, 'kungfu');
  fs.writeFileSync(
    launcher,
    '#!/bin/sh\nprintf "Kungfu agent brief fixture\\nFacts before trust.\\n"\n',
  );
  fs.chmodSync(launcher, 0o755);
  json(path.join(productRoot, 'product.json'), {
    schema: 'kungfu.product.cli/v1',
    product: 'cli',
    platform: 'linux-x64',
    archive: 'kungfu-episodes-cli-linux-x64.tar.gz',
    entries: {
      kungfu: 'kungfu',
      compatibility: 'runtime/product-compatibility.json',
      upgradeManifest: 'upgrade/kungfu-release-manifest.json',
    },
  });
  json(path.join(productRoot, 'runtime', 'product-compatibility.json'), {
    schema: 'kungfu.product.compatibility/v1',
    source_commit: source,
    platform: 'linux-x64',
    versions: { product: '4.0.0-alpha.0' },
  });
  json(path.join(productRoot, 'upgrade', 'kungfu-release-manifest.json'), {
    schema: 'kungfu.product-upgrade.manifest/v1',
    sourceCommit: source,
    productVersion: '4.0.0-alpha.0',
    platform: 'linux',
    architecture: 'x64',
  });
  if (unsafeArchive) {
    fs.symlinkSync('/tmp', path.join(productRoot, 'escape'));
  }
  const archive = path.join(
    artifact,
    'cli',
    'kungfu-episodes-cli-linux-x64.tar.gz',
  );
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  const tar = spawnSync(
    'tar',
    ['-czf', archive, '-C', staging, 'kungfu-episodes-cli-linux-x64'],
    {
      encoding: 'utf8',
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    },
  );
  assert.equal(tar.status, 0, tar.stderr);
  return { artifact: path.join(root, 'artifact'), coordinate };
}

function run(root, options = {}) {
  const { artifact, coordinate } = fixture(root, options);
  const output = path.join(root, 'output');
  const result = spawnSync(
    'python3',
    [
      ADAPTER,
      '--artifact-root',
      artifact,
      '--output',
      output,
      '--source-coordinate',
      coordinate,
    ],
    { encoding: 'utf8' },
  );
  return { result, output };
}

test('adapter executes only the exact installed archive and emits three declared files', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auditable-demo-adapter-'),
  );
  try {
    const { result, output } = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(output).sort(), [
      'complete-transcript.txt',
      'public-projection.json',
      'scene.json',
    ]);
    const transcript = fs.readFileSync(
      path.join(output, 'complete-transcript.txt'),
      'utf8',
    );
    assert.match(transcript, /Kungfu agent brief fixture/);
    assert.match(transcript, /exit\.status=0/);
    assert.doesNotMatch(transcript, new RegExp(root));
    const projection = JSON.parse(
      fs.readFileSync(path.join(output, 'public-projection.json'), 'utf8'),
    );
    assert.equal(
      projection.evidenceClass,
      'exact-installed-artifact-agent-brief/v1',
    );
    assert.match(projection.claimBoundary, /does not prove continuity/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('adapter fails closed on source mismatch', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auditable-demo-adapter-'),
  );
  try {
    const { artifact, coordinate } = fixture(root);
    const layer = path.join(
      artifact,
      'product',
      'release',
      'qualification',
      'layer-qualification-summary.json',
    );
    const value = JSON.parse(fs.readFileSync(layer, 'utf8'));
    value.reuse.tuple.sourceRevision = '3'.repeat(40);
    json(layer, value);
    const result = spawnSync(
      'python3',
      [
        ADAPTER,
        '--artifact-root',
        artifact,
        '--output',
        path.join(root, 'output'),
        '--source-coordinate',
        coordinate,
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('adapter rejects symlink members before extraction', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auditable-demo-adapter-'),
  );
  try {
    const { result } = run(root, { unsafeArchive: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported CLI archive member type/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
