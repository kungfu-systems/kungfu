// SPDX-License-Identifier: Apache-2.0

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const {
  authorityArtifact,
  authorityManifest,
  conformanceBundlePath,
  inspectAuthority,
  inspectBundle,
  preserveBundle,
  verifyAuthorityBundle,
  verifyBundle,
} = require('./index.js');
const {
  buildArtifacts,
  checkArtifacts,
  normalizeLf,
  renderArtifacts,
  writeArtifacts,
} = require('./scripts/generate.js');
const {
  npmCommand,
  npmPackArgs,
  npmSpawnOptions,
} = require('./scripts/pack.js');

function pythonCommand(platform = process.platform) {
  return (
    process.env.PYTHON || (platform === 'win32' ? 'python.exe' : 'python3')
  );
}

test('uses platform command shims when qualifying and packing', () => {
  assert.equal(pythonCommand('win32'), process.env.PYTHON || 'python.exe');
  assert.equal(pythonCommand('darwin'), process.env.PYTHON || 'python3');
  assert.equal(pythonCommand('linux'), process.env.PYTHON || 'python3');
  assert.equal(npmCommand('win32'), 'npm.cmd');
  assert.equal(npmCommand('darwin'), 'npm');
  assert.equal(npmCommand('linux'), 'npm');
  assert.deepEqual(npmSpawnOptions('win32'), { shell: true });
  assert.deepEqual(npmSpawnOptions('linux'), { shell: false });
  assert.deepEqual(npmPackArgs('release-spec'), [
    'pack',
    '--foreground-scripts',
    '--pack-destination',
    'release-spec',
  ]);
});

test('exposes rooted authority, compatibility, vectors, and non-claims', () => {
  const manifest = authorityManifest();
  const inspected = inspectAuthority();
  const verified = verifyAuthorityBundle();
  assert.equal(inspected.status, 'read');
  assert.equal(inspected.normative_root, manifest.normative.root);
  assert.equal(inspected.normative_status, 'pre-release');
  assert.equal(inspected.authority.status.composition, 'accepted');
  assert.equal(inspected.compatibility.status, 'current');
  assert.equal(inspected.vectors.vectors.length, 16);
  assert.ok(inspected.non_claims.length > 0);
  assert.equal(verified.status, 'read');
  assert.equal(verified.artifact_count, 8);
  assert.equal(verified.vector_count, 16);
  assert.ok(verified.source_binding_count >= 8);
  assert.equal(authorityArtifact('reader_matrix').value.profiles.length, 7);
  assert.equal(
    manifest.categories.format_spec.path,
    manifest.artifacts.authority.path,
  );
  assert.equal(
    manifest.history.spec_0_1_draft.status,
    'historical-non-normative',
  );
});

test('qualifies every retained vector through the packaged Python reader', () => {
  const report = JSON.parse(
    execFileSync(
      pythonCommand(),
      [
        path.join(
          __dirname,
          'reference-readers/python/portable_format_reader.py',
        ),
        '--json',
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(report.package.name, '@kungfu-tech/spec');
  assert.equal(report.vectorCount, 16);
  assert.deepEqual(report.runtimeDependencies, []);
  assert.deepEqual(report.outcomes, [
    'migration-required',
    'preserve-only',
    'read',
    'read-degraded',
    'reject',
  ]);
});

test('generates byte-identical authority artifacts and detects hand edits', () => {
  const first = renderArtifacts(buildArtifacts());
  const second = renderArtifacts(buildArtifacts());
  assert.deepEqual(first, second);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-spec-generated-'));
  try {
    writeArtifacts(first, root);
    assert.doesNotThrow(() => checkArtifacts(second, root));
    const target = path.join(root, 'capabilities.json');
    const sourceChanged = new Map(second);
    const changedCapabilities = sourceChanged.get('capabilities.json');
    assert.ok(changedCapabilities);
    sourceChanged.set(
      'capabilities.json',
      changedCapabilities.replace(
        '"status": "current"',
        '"status": "successor"',
      ),
    );
    assert.throws(
      () => checkArtifacts(sourceChanged, root),
      /capabilities\.json: generated artifact drift/,
    );
    fs.appendFileSync(target, ' ');
    assert.throws(
      () => checkArtifacts(second, root),
      /capabilities\.json: generated artifact drift/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('treats Windows checkout line endings as canonical LF', () => {
  assert.equal(normalizeLf('first\r\nsecond\r\n'), 'first\nsecond\n');
  const rendered = new Map([
    ['authority.json', '{\n  "status": "current"\n}\n'],
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-spec-crlf-'));
  try {
    fs.writeFileSync(
      path.join(root, 'authority.json'),
      '{\r\n  "status": "current"\r\n}\r\n',
    );
    assert.doesNotThrow(() => checkArtifacts(rendered, root));
    fs.appendFileSync(path.join(root, 'authority.json'), ' ');
    assert.throws(
      () => checkArtifacts(rendered, root),
      /authority\.json: generated artifact drift/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('opens, inspects, and verifies the portable conformance bundle', () => {
  const result = inspectBundle(conformanceBundlePath);
  assert.equal(result.status, 'read-degraded');
  assert.equal(result.structural_verification, 'complete');
  assert.equal(result.semantic_verification, 'incomplete');
  assert.equal(result.event_count, 1);
  assert.equal(result.unknown_records, 1);
  assert.deepEqual(result.capabilities, [
    'open',
    'inspect',
    'verify',
    'preserve_unknowns',
  ]);
});

test('preserves an unknown record byte-for-byte', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-spec-test-'));
  const output = path.join(root, 'preserved');
  try {
    const before = fs.readFileSync(
      path.join(conformanceBundlePath, 'events.jsonl'),
    );
    const result = preserveBundle(conformanceBundlePath, output);
    const after = fs.readFileSync(path.join(output, 'events.jsonl'));
    assert.equal(result.status, 'preserve-only');
    assert.equal(result.unknown_records_preserved, 1);
    assert.deepEqual(after, before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects payload mutation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-spec-test-'));
  try {
    fs.cpSync(conformanceBundlePath, root, { recursive: true });
    const eventLog = path.join(root, 'events.jsonl');
    fs.writeFileSync(
      eventLog,
      fs
        .readFileSync(eventLog, 'utf8')
        .replace('future\\":true', 'future\\":false'),
    );
    assert.throws(() => verifyBundle(root), /segment checksum mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
