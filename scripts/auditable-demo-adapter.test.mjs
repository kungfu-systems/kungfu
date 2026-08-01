// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadAuditableDemo } from '../framework/auditable-demo/catalog.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ADAPTER = path.join(ROOT, 'scripts', 'auditable-demo-adapter.py');
const CATALOG = path.join(ROOT, 'framework', 'auditable-demo', 'catalog.json');
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
    archiveSymlinkTarget = '',
    parentRelativeArchiveSymlink = false,
    safeArchiveLinks = false,
    unsupportedArchiveMember = false,
    stdoutLineCount = 0,
    completionStatus = 'qualified',
    omitSentinel = false,
    exitCode = 0,
    privateOutput = '',
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
  const outputLines =
    stdoutLineCount > 0
      ? [
          'index=1',
          `while [ "$index" -le ${stdoutLineCount} ]; do`,
          '  printf "brief-line-%03d\\r\\n" "$index"',
          '  index=$((index + 1))',
          'done',
        ]
      : [
          'printf "\\033[2J\\033[H\\033[1;36mKungfu Agent Work Lab fixture\\033[0m\\r\\n"',
          'printf "terminal-size="; stty size',
          'printf "\\033[38;2;103;232;165mFresh process continues from governed Work.\\033[0m\\r\\n"',
        ];
  const sentinel = omitSentinel
    ? []
    : [
        `printf 'KUNGFU_TUI_DEMO_COMPLETE {"schema":"kungfu.agent-work-lab.tui-autoplay/v1","status":"${completionStatus}","reportRoot":"sha256:${'a'.repeat(64)}","eventCount":4}\\r\\n'`,
      ];
  const launcherBody = [
    '#!/bin/sh',
    '[ "$1" = "agent-work-lab" ] && [ "$2" = "autoplay" ] || exit 7',
    '[ -t 0 ] && [ -t 1 ] || exit 8',
    '[ "${FORCE_COLOR:-}" = "3" ] || exit 9',
    '[ -z "${NO_COLOR+x}" ] || exit 10',
    '[ "${TERM:-}" = "xterm-256color" ] || exit 11',
    '[ "${COLORTERM:-}" = "truecolor" ] || exit 12',
    ...outputLines,
    ...(privateOutput ? [`printf '%s\\r\\n' '${privateOutput}'`] : []),
    ...sentinel,
    `exit ${exitCode}`,
    '',
  ].join('\n');
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
  if (archiveSymlinkTarget) {
    const pythonBin = path.join(productRoot, 'runtime', 'python', 'bin');
    fs.mkdirSync(pythonBin, { recursive: true });
    fs.writeFileSync(path.join(pythonBin, 'python3'), '#!/bin/sh\nexit 0\n');
    fs.symlinkSync(archiveSymlinkTarget, path.join(pythonBin, 'python'));
  }
  if (safeArchiveLinks) {
    const pythonRoot = path.join(productRoot, 'runtime', 'python', 'bin');
    fs.mkdirSync(pythonRoot, { recursive: true });
    const python3 = path.join(pythonRoot, 'python3');
    fs.writeFileSync(python3, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(python3, 0o755);
    fs.symlinkSync('python3', path.join(pythonRoot, 'python'));
    fs.linkSync(python3, path.join(pythonRoot, 'python-copy'));
  }
  if (parentRelativeArchiveSymlink) {
    const terminfoRoot = path.join(
      productRoot,
      'runtime',
      'python',
      'share',
      'terminfo',
    );
    fs.mkdirSync(path.join(terminfoRoot, '1'), { recursive: true });
    fs.mkdirSync(path.join(terminfoRoot, 'a'), { recursive: true });
    fs.writeFileSync(path.join(terminfoRoot, 'a', 'adm1178'), 'terminfo\n');
    fs.symlinkSync('../a/adm1178', path.join(terminfoRoot, '1', '1178'));
  }
  if (unsupportedArchiveMember) {
    const fifo = spawnSync('mkfifo', [
      path.join(productRoot, 'runtime', 'unsupported-fifo'),
    ]);
    assert.equal(fifo.status, 0, fifo.stderr?.toString());
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
  const { demoCatalog = '', demoId = '', ...fixtureOptions } = options;
  const { artifact, coordinate } = fixture(root, fixtureOptions);
  const output = path.join(root, 'output');
  const demoArguments = [];
  if (demoCatalog) demoArguments.push('--demo-catalog', demoCatalog);
  if (demoId) demoArguments.push('--demo-id', demoId);
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
      ...demoArguments,
    ],
    { encoding: 'utf8' },
  );
  return { result, output };
}

test('adapter maps only Linux PTY EIO onto terminal EOF', () => {
  const probe = [
    'import errno',
    'import importlib.util',
    'import sys',
    'spec = importlib.util.spec_from_file_location("adapter", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'def eio(_fd, _size):',
    '    raise OSError(errno.EIO, "pty eof")',
    'def eperm(_fd, _size):',
    '    raise OSError(errno.EPERM, "real failure")',
    'assert module.read_pty_chunk(7, eio) == b""',
    'try:',
    '    module.read_pty_chunk(7, eperm)',
    'except OSError as error:',
    '    assert error.errno == errno.EPERM',
    'else:',
    '    raise AssertionError("non-EIO failure was swallowed")',
  ].join('\n');
  const result = spawnSync('python3', ['-c', probe, ADAPTER], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('adapter selects a second catalog demo without changing the capture engine', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auditable-demo-adapter-'),
  );
  try {
    const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
    catalog.demos.push({
      ...structuredClone(catalog.demos[0]),
      id: 'agent-work-lab-secondary',
      evidenceClass:
        'exact-installed-artifact-agent-work-lab-secondary-autoplay/v1',
      scene: {
        ...catalog.demos[0].scene,
        id: 'kungfu-agent-work-lab-secondary-autoplay',
        title: 'Kungfu Agent Work Lab — secondary capture simulation',
      },
      publication: {
        readmeFeatured: false,
        siteSlug: 'agent-work-lab-secondary',
      },
    });
    catalog.demos[1].renditions[0].scene = structuredClone(
      catalog.demos[1].scene,
    );
    catalog.demos[1].renditions[1].scene = {
      ...catalog.demos[1].renditions[1].scene,
      id: 'kungfu-agent-work-lab-secondary-autoplay-720p',
      title: 'Kungfu Agent Work Lab — secondary capture simulation',
    };
    const demoCatalog = path.join(root, 'catalog.json');
    json(demoCatalog, catalog);
    const { result, output } = run(root, {
      demoCatalog,
      demoId: 'agent-work-lab-secondary',
    });
    assert.equal(result.status, 0, result.stderr);
    const scene = JSON.parse(
      fs.readFileSync(path.join(output, 'scene.json'), 'utf8'),
    );
    const projection = JSON.parse(
      fs.readFileSync(path.join(output, 'public-projection.json'), 'utf8'),
    );
    assert.equal(scene.id, 'kungfu-agent-work-lab-secondary-autoplay');
    assert.equal(
      projection.evidenceClass,
      'exact-installed-artifact-agent-work-lab-secondary-autoplay/v1',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('adapter fails closed when a selected demo is not declared', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auditable-demo-adapter-'),
  );
  try {
    const { result } = run(root, { demoId: 'missing-demo' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /selected demo id is not declared/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('catalog rejects shell-shaped arguments and duplicate publication identities', () => {
  for (const mutate of [
    (value) => {
      value.demos[0].argv = ['agent-work-lab', 'autoplay\nwhoami'];
    },
    (value) => {
      value.demos.push(structuredClone(value.demos[0]));
    },
  ]) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'auditable-demo-catalog-'),
    );
    try {
      const value = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
      mutate(value);
      const catalogPath = path.join(root, 'catalog.json');
      json(catalogPath, value);
      assert.throws(
        () => loadAuditableDemo({ catalogPath }),
        /argument vector|demo ids must be unique/u,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('adapter executes only the exact installed archive in a PTY and emits the declared capture', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auditable-demo-adapter-'),
  );
  try {
    const { result, output } = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(output).sort(), [
      'complete-transcript-720p.txt',
      'complete-transcript.txt',
      'public-projection-720p.json',
      'public-projection.json',
      'rendition-set.json',
      'scene-720p.json',
      'scene.json',
      'terminal-capture-720p.json',
      'terminal-capture.json',
    ]);
    const transcript = fs.readFileSync(
      path.join(output, 'complete-transcript.txt'),
      'utf8',
    );
    assert.match(transcript, /Kungfu Agent Work Lab fixture/);
    assert.match(transcript, /exit\.status=0/);
    assert.doesNotMatch(transcript, new RegExp(root));
    const projection = JSON.parse(
      fs.readFileSync(path.join(output, 'public-projection.json'), 'utf8'),
    );
    assert.equal(
      projection.evidenceClass,
      'exact-installed-artifact-agent-work-lab-autoplay/v1',
    );
    assert.match(
      projection.claimBoundary,
      /Terminal bytes are observation only/,
    );
    const capture = JSON.parse(
      fs.readFileSync(path.join(output, 'terminal-capture.json'), 'utf8'),
    );
    assert.equal(capture.command, 'kungfu agent-work-lab autoplay');
    assert.deepEqual(capture.dimensions, { columns: 150, rows: 36 });
    assert.equal(capture.completion.status, 'qualified');
    assert.deepEqual(capture.authority.grants, []);
    assert.deepEqual(capture.authority.nonAuthorities, [
      'first-party-identity',
      'system-identity',
      'kfd-compliance',
      'product-system-metadata',
      'package-metadata',
      'registry-history',
      'scan-output',
      'standalone-generation',
    ]);
    assert.equal(capture.events[0].atMs, 0);
    assert.ok(
      capture.events.every((event) =>
        /^[A-Za-z0-9+/]+={0,2}$/u.test(event.data),
      ),
    );
    const terminalBytes = Buffer.concat(
      capture.events.map((event) => Buffer.from(event.data, 'base64')),
    ).toString('utf8');
    assert.ok(terminalBytes.includes('\u001b[1;36m'));
    assert.ok(terminalBytes.includes('\u001b[38;2;103;232;165m'));
    assert.match(terminalBytes, /terminal-size=36 150/u);
    const responsiveCapture = JSON.parse(
      fs.readFileSync(path.join(output, 'terminal-capture-720p.json'), 'utf8'),
    );
    assert.deepEqual(responsiveCapture.dimensions, { columns: 100, rows: 28 });
    const responsiveBytes = Buffer.concat(
      responsiveCapture.events.map((event) =>
        Buffer.from(event.data, 'base64'),
      ),
    ).toString('utf8');
    assert.match(responsiveBytes, /terminal-size=28 100/u);
    assert.notEqual(terminalBytes, responsiveBytes);
    const renditionSet = JSON.parse(
      fs.readFileSync(path.join(output, 'rendition-set.json'), 'utf8'),
    );
    assert.equal(renditionSet.schema, 'kungfu.auditable-demo.rendition-set/v1');
    assert.deepEqual(
      renditionSet.renditions.map(({ id, role }) => ({ id, role })),
      [
        { id: '1080p', role: 'primary' },
        { id: '720p', role: 'responsive' },
      ],
    );
    assert.notEqual(
      renditionSet.renditions[0].captureRoot,
      renditionSet.renditions[1].captureRoot,
    );
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

test('adapter accepts bounded internal symlink and hardlink members', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auditable-demo-adapter-'),
  );
  try {
    const { result } = run(root, { safeArchiveLinks: true });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('adapter accepts a bounded relative symlink to a regular archive member', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auditable-demo-adapter-'),
  );
  try {
    const { result } = run(root, { archiveSymlinkTarget: 'python3' });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('adapter accepts a parent-relative symlink that remains inside the archive root', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auditable-demo-adapter-'),
  );
  try {
    const { result } = run(root, { parentRelativeArchiveSymlink: true });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('adapter rejects absolute and escaping archive symlinks before extraction', () => {
  for (const archiveSymlinkTarget of ['/tmp', '../../../../outside']) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'auditable-demo-adapter-'),
    );
    try {
      const { result } = run(root, { archiveSymlinkTarget });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /unsafe CLI archive link target/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('adapter rejects unsupported archive member types', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auditable-demo-adapter-'),
  );
  try {
    const { result } = run(root, { unsupportedArchiveMember: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported CLI archive member type/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('adapter fails closed on missing, non-qualified, or nonzero autoplay completion', () => {
  for (const [options, expected] of [
    [{ omitSentinel: true }, /must emit exactly one/u],
    [{ completionStatus: 'failed' }, /completion sentinel did not pass/u],
    [{ completionStatus: 'passed' }, /completion sentinel did not pass/u],
    [{ exitCode: 9 }, /failed with exit status 9/u],
  ]) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'auditable-demo-adapter-'),
    );
    try {
      const { result } = run(root, options);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('adapter retains a bounded sanitized PTY tail and exit status when completion is missing', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'auditable-demo-adapter-'),
  );
  try {
    const { result } = run(root, { omitSentinel: true, exitCode: 23 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must emit exactly one/u);
    assert.match(result.stderr, /exit status 23/u);
    assert.match(result.stderr, /Kungfu Agent Work Lab fixture/u);
    assert.equal(result.stderr.includes(String.fromCharCode(27)), false);
    assert.doesNotMatch(result.stderr, new RegExp(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('adapter rejects credential-shaped terminal output before publication', () => {
  for (const privateOutput of [
    'token=not-a-real-token',
    '/home/private-user/project',
    'Authorization: Bearer not-a-real-bearer',
    `ghp_${'x'.repeat(32)}`,
    `AKIA${'A'.repeat(16)}`,
    '-----BEGIN PRIVATE KEY-----',
  ]) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'auditable-demo-adapter-'),
    );
    try {
      const { result } = run(root, { privateOutput });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /private path or credential-shaped value/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    assert.equal(projection.cues[1].transcriptLines[0], 20);
    assert.equal(projection.cues[2].transcriptLines.at(-1), 202);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
