// SPDX-License-Identifier: Apache-2.0

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  conformanceBundlePath,
  inspectBundle,
  preserveBundle,
  verifyBundle,
} = require('./index.js');
const { npmCommand, npmSpawnOptions } = require('./scripts/pack.js');

test('uses the platform npm shim when packing the artifact', () => {
  assert.equal(npmCommand('win32'), 'npm.cmd');
  assert.equal(npmCommand('darwin'), 'npm');
  assert.equal(npmCommand('linux'), 'npm');
  assert.deepEqual(npmSpawnOptions('win32'), { shell: true });
  assert.deepEqual(npmSpawnOptions('linux'), { shell: false });
});

test('opens, inspects, and verifies the portable conformance bundle', () => {
  const result = inspectBundle(conformanceBundlePath);
  assert.equal(result.status, 'passing');
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
    assert.equal(result.status, 'passing');
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
