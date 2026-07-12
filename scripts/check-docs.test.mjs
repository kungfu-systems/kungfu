// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { checkDocs } from './check-docs.mjs';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-docs-gate-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

const contract = {
  schemaVersion: 1,
  requiredFiles: ['README.md', 'docs/guide.md'],
  requiredPointers: [{ from: 'README.md', to: 'docs/guide.md' }],
};

function run(files) {
  const root = fixture(files);
  return checkDocs({
    root,
    files: Object.keys(files)
      .filter((file) => /\.(?:md|markdown)$/i.test(file))
      .sort(),
    contract,
    vocabularyRegistry: false,
  });
}

test('accepts local files, cross-file anchors, images, and external links', () => {
  const findings = run({
    'README.md':
      '# Home\n\n[Guide](docs/guide.md#replay--rewind)\n\n[Web](https://kungfu.tech)\n',
    'docs/guide.md':
      '# Guide\n\n## Replay & Rewind\n\n![Map](images/map.svg)\n',
    'docs/images/map.svg': '<svg/>\n',
  });
  assert.deepEqual(findings, []);
});

test('rejects missing local targets with source coordinates', () => {
  const findings = run({
    'README.md': '# Home\n\n[Guide](docs/missing.md)\n',
    'docs/guide.md': '# Guide\n',
  });
  const missing = findings.find((finding) => finding.code === 'missing-target');
  assert.equal(missing?.file, 'README.md');
  assert.equal(missing?.line, 3);
});

test('rejects missing cross-file anchors', () => {
  const findings = run({
    'README.md': '# Home\n\n[Guide](docs/guide.md#missing)\n',
    'docs/guide.md': '# Guide\n\n## Present\n',
  });
  assert.ok(findings.some((finding) => finding.code === 'missing-anchor'));
});

test('rejects local-link case mismatches on case-insensitive filesystems', () => {
  const findings = run({
    'README.md': '# Home\n\n[Guide](docs/GUIDE.md)\n',
    'docs/guide.md': '# Guide\n',
  });
  assert.ok(
    findings.some((finding) =>
      ['case-mismatch', 'missing-target'].includes(finding.code),
    ),
  );
});

test('tracks GitHub duplicate-heading suffixes', () => {
  const findings = run({
    'README.md': '# Home\n\n[Guide](docs/guide.md#topic-1)\n',
    'docs/guide.md': '# Guide\n\n## Topic\n\n## Topic\n',
  });
  assert.deepEqual(findings, []);
});

test('rejects missing canonical entry pointers', () => {
  const findings = run({
    'README.md': '# Home\n',
    'docs/guide.md': '# Guide\n',
  });
  assert.ok(findings.some((finding) => finding.code === 'required-pointer'));
});

test('rejects repository-escaping local links', () => {
  const findings = run({
    'README.md':
      '# Home\n\n[Guide](docs/guide.md)\n\n[Outside](../secret.md)\n',
    'docs/guide.md': '# Guide\n',
  });
  assert.ok(findings.some((finding) => finding.code === 'outside-root'));
});
