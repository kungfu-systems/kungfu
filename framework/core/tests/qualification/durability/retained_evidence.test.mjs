// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', '..', '..');
const evidenceRoot = path.join(
  root,
  'docs',
  'qualification',
  'evidence',
  'durability',
  '12dd26e899',
);
const schema = JSON.parse(
  fs.readFileSync(
    path.join(
      here,
      'schemas',
      'durability-qualification-report-v1.schema.json',
    ),
    'utf8',
  ),
);
const expectedRevision = '12dd26e8992b012067d0fd54da42d17ae93a68a2';
const expectedTree = 'a41d11a7354b827ec0acbd911381219a7e98e726';
const expectedPairs = new Set(
  [
    'macos-apfs-process-v1',
    'linux-ext4-process-v1',
    'windows-ntfs-process-v1',
  ].flatMap((profile) =>
    ['durable_group', 'durable_sync'].map(
      (durability) => `${profile}:${durability}`,
    ),
  ),
);

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const pathname = path.join(directory, entry.name);
    if (entry.isDirectory()) return files(pathname);
    return entry.isFile() && entry.name.endsWith('.json') ? [pathname] : [];
  });
}

function sha256(pathname) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(pathname))
    .digest('hex');
}

test('retained three-platform process evidence is complete and immutable', () => {
  const reports = files(evidenceRoot).sort();
  assert.equal(reports.length, 6);
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
    schema,
  );
  const observed = new Set();
  for (const pathname of reports) {
    const report = JSON.parse(fs.readFileSync(pathname, 'utf8'));
    assert.equal(validate(report), true, JSON.stringify(validate.errors));
    assert.equal(report.mode, 'execute');
    assert.deepEqual(report.source, {
      revision: expectedRevision,
      tree: expectedTree,
      dirty: false,
    });
    assert.equal(report.verdict, 'passed');
    assert.deepEqual(report.violations, []);
    assert.deepEqual(report.claims, {
      declared_process_envelope_qualified: true,
      power_loss_qualified: false,
      production_profile_eligible: false,
    });
    assert.equal(report.toolchain.doctor_status, 'passed');
    assert.equal(report.platform.filesystem_evidence, 'operator-declared');
    observed.add(`${report.profile.name}:${report.durability_profile}`);
    for (const suite of report.suites) {
      assert.equal(suite.status, 'passed');
      assert.equal(suite.exit_code, 0);
      assert.deepEqual(suite.missing_markers, []);
      const portableRawLog = suite.raw_log.replaceAll('\\', '/');
      assert.equal(path.isAbsolute(portableRawLog), false);
      const raw = path.resolve(path.dirname(pathname), portableRawLog);
      assert.equal(
        raw.startsWith(`${path.dirname(pathname)}${path.sep}`),
        true,
      );
      assert.equal(fs.statSync(raw).isFile(), true, raw);
      assert.equal(sha256(raw), suite.raw_sha256, raw);
      assert.equal(
        execFileSync(
          'git',
          ['ls-files', '--error-unmatch', path.relative(root, raw)],
          { cwd: root, encoding: 'utf8' },
        ).trim(),
        path.relative(root, raw),
        `${raw} exists only as untracked local residue`,
      );
    }
  }
  assert.deepEqual(observed, expectedPairs);
});
