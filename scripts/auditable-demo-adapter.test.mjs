// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const ADAPTER = path.join(ROOT, 'scripts', 'auditable-demo-adapter.py');
const SOURCE_SHA = '1'.repeat(40);
const DIGEST = `sha256:${'2'.repeat(64)}`;
const SOURCE_TREE = '4'.repeat(40);

function json(pathname, value) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`);
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

function sealEvidence(evidence) {
  return {
    ...evidence,
    evidence_digest: `sha256:${createHash('sha256')
      .update(JSON.stringify(sortValue(evidence)))
      .digest('hex')}`,
  };
}

function episodeEvidence(source, coordinateSource, overrides = {}) {
  const gateEvidence = `ci=${coordinateSource} expected=${source} ci_tree=${SOURCE_TREE} expected_tree=${SOURCE_TREE} mode=tree-equivalent-pull-merge`;
  return sealEvidence({
    schema: 'kungfu.episode.release-evidence/v1',
    verdict: 'qualified',
    source: {
      repository: 'kungfu-systems/kungfu',
      revision: source,
      tree: SOURCE_TREE,
      dirty: false,
    },
    ci: {
      provider: 'github-actions',
      ref: 'refs/pull/1448/merge',
      sha: coordinateSource,
      source_sha: coordinateSource,
      source_tree_sha: SOURCE_TREE,
      ...overrides.ci,
    },
    qualification: {
      hard_gates: [
        { id: 'harness_exit', passed: true, evidence: 'exit=0' },
        {
          id: 'ci_source_revision',
          passed: true,
          evidence: gateEvidence,
        },
      ],
    },
    trust_report: { source_revision: source, source_dirty: false },
  });
}

function report(source, schema, extra = {}) {
  return {
    schema,
    source: { revision: source, dirty: false },
    verdict: 'passed',
    ...extra,
  };
}

function fixture(
  root,
  {
    source = SOURCE_SHA,
    coordinateSource = source,
    sourceEvidence = null,
    unsafeArchive = false,
    stdoutLineCount = 0,
  } = {},
) {
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
  if (sourceEvidence) {
    json(
      path.join(qualification, 'episode-release-evidence.json'),
      sourceEvidence,
    );
  }
  const coordinate = path.join(root, 'coordinate.json');
  json(coordinate, {
    schema: 'buildchain.github-artifact-coordinate/v1',
    repository: 'kungfu-systems/kungfu',
    runId: '123',
    runAttempt: '1',
    sourceSha: coordinateSource,
    id: '456',
    nodeId: 'A_kwDOFixture',
    name: `kungfu-linux-x64-${coordinateSource}`,
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
  const launcherBody =
    stdoutLineCount > 0
      ? [
          '#!/bin/sh',
          'index=1',
          `while [ "$index" -le ${stdoutLineCount} ]; do`,
          '  printf "brief-line-%03d\\n" "$index"',
          '  index=$((index + 1))',
          'done',
          '',
        ].join('\n')
      : '#!/bin/sh\nprintf "Kungfu agent brief fixture\\nFacts before trust.\\n"\n';
  fs.writeFileSync(launcher, launcherBody);
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

test('adapter accepts a resealed pull merge only through qualified tree-equivalence evidence', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auditable-demo-adapter-'),
  );
  try {
    const coordinateSource = '3'.repeat(40);
    const sourceEvidence = episodeEvidence(SOURCE_SHA, coordinateSource);
    const { result } = run(root, { coordinateSource, sourceEvidence });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('adapter rejects pull-merge evidence whose workflow SHA is not the artifact coordinate', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auditable-demo-adapter-'),
  );
  try {
    const coordinateSource = '3'.repeat(40);
    const sourceEvidence = episodeEvidence(SOURCE_SHA, coordinateSource, {
      ci: { sha: SOURCE_SHA },
    });
    const { result } = run(root, { coordinateSource, sourceEvidence });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not prove a qualified pull-merge/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('adapter rejects tree-equivalence evidence outside a pull merge ref', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auditable-demo-adapter-'),
  );
  try {
    const coordinateSource = '3'.repeat(40);
    const sourceEvidence = episodeEvidence(SOURCE_SHA, coordinateSource, {
      ci: { ref: 'refs/heads/dev/v4/v4.0' },
    });
    const { result } = run(root, { coordinateSource, sourceEvidence });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not prove a qualified pull-merge/);
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

test('adapter bounds each visual cue while retaining a complete long transcript', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auditable-demo-adapter-'),
  );
  try {
    const { result, output } = run(root, { stdoutLineCount: 181 });
    assert.equal(result.status, 0, result.stderr);
    const transcript = fs.readFileSync(
      path.join(output, 'complete-transcript.txt'),
      'utf8',
    );
    assert.match(transcript, /brief-line-001/u);
    assert.match(transcript, /brief-line-181/u);
    const projection = JSON.parse(
      fs.readFileSync(path.join(output, 'public-projection.json'), 'utf8'),
    );
    assert.equal(projection.cues[1].transcriptLines.length, 80);
    assert.equal(projection.cues[2].transcriptLines.length, 80);
    assert.equal(projection.cues[1].transcriptLines[0], 13);
    assert.equal(projection.cues[2].transcriptLines.at(-1), 193);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
