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
  schemaVersion: 2,
  requiredFiles: ['README.md', 'docs/guide.md'],
  requiredPointers: [{ from: 'README.md', to: 'docs/guide.md' }],
  publication: {
    roots: ['README.md'],
    include: ['README.md', 'docs'],
    allowedOrphans: [],
  },
  executableExamples: [],
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
    metadataContract: false,
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

test('rejects unreachable public documents', () => {
  const findings = run({
    'README.md': '# Home\n\n[Guide](docs/guide.md)\n',
    'docs/guide.md': '# Guide\n',
    'docs/orphan.md': '# Orphan\n',
  });
  assert.ok(findings.some((finding) => finding.code === 'publication-orphan'));
});

test('allows unreachable documents only through a typed compatibility profile', () => {
  const typed = structuredClone(contract);
  typed.publication.allowedOrphanDocumentTypes = ['adr-redirect'];
  const root = fixture({
    'README.md': '# Home\n\n[Guide](docs/guide.md)\n',
    'docs/guide.md': '# Guide\n',
    'docs/redirect.md': `---
doc_type: adr-redirect
---

# Moved
`,
  });
  const findings = checkDocs({
    root,
    files: ['README.md', 'docs/guide.md', 'docs/redirect.md'],
    contract: typed,
    vocabularyRegistry: false,
    metadataContract: false,
  });
  assert.deepEqual(findings, []);
});

test('enforces a canonical docs hierarchy with entry-only root Markdown', () => {
  const hierarchical = structuredClone(contract);
  hierarchical.requiredFiles = ['README.md', 'docs/README.md'];
  hierarchical.requiredPointers = [{ from: 'README.md', to: 'docs/README.md' }];
  hierarchical.hierarchy = {
    root: 'docs',
    entryFiles: ['docs/README.md'],
    canonicalDirectories: ['docs/guides'],
  };
  const root = fixture({
    'README.md': '# Home\n\n[Docs](docs/README.md)\n',
    'docs/README.md': '# Docs\n\n[Guide](guides/guide.md)\n',
    'docs/guides/guide.md': '# Guide\n',
  });
  const findings = checkDocs({
    root,
    files: ['README.md', 'docs/README.md', 'docs/guides/guide.md'],
    contract: hierarchical,
    vocabularyRegistry: false,
    metadataContract: false,
  });
  assert.deepEqual(findings, []);
});

test('rejects every undeclared root Markdown document', () => {
  const hierarchical = structuredClone(contract);
  hierarchical.requiredFiles = ['README.md', 'docs/README.md'];
  hierarchical.requiredPointers = [{ from: 'README.md', to: 'docs/README.md' }];
  hierarchical.hierarchy = {
    root: 'docs',
    entryFiles: ['docs/README.md'],
    canonicalDirectories: ['docs/guides'],
  };
  const root = fixture({
    'README.md': '# Home\n\n[Docs](docs/README.md)\n',
    'docs/README.md': '# Docs\n\n[Guide](guides/guide.md)\n',
    'docs/flat.md': '# Flat canonical page\n',
    'docs/legacy.md': '# Legacy route\n',
    'docs/guides/guide.md': '# Guide\n',
  });
  const findings = checkDocs({
    root,
    files: [
      'README.md',
      'docs/README.md',
      'docs/flat.md',
      'docs/legacy.md',
      'docs/guides/guide.md',
    ],
    contract: hierarchical,
    vocabularyRegistry: false,
    metadataContract: false,
  });
  assert.ok(
    findings.some((finding) => finding.code === 'documentation-hierarchy-root'),
  );
  assert.equal(
    findings.filter(
      (finding) => finding.code === 'documentation-hierarchy-root',
    ).length,
    2,
  );
});

test('rejects undeclared executable examples', () => {
  const root = fixture({
    'README.md': '# Home\n\n[Guide](docs/guide.md)\n',
    'docs/guide.md': '# Guide\n\n```sh docs-exec=unsafe\n./shifu fix\n```\n',
  });
  const findings = checkDocs({
    root,
    files: ['README.md', 'docs/guide.md'],
    contract,
    vocabularyRegistry: false,
    metadataContract: false,
  });
  assert.ok(
    findings.some(
      (finding) => finding.code === 'executable-example-undeclared',
    ),
  );
});

test('rejects declared executable examples outside the safe argv allowlist', () => {
  const unsafe = structuredClone(contract);
  unsafe.executableExamples = [
    {
      id: 'unsafe',
      file: 'docs/guide.md',
      command: ['./shifu', 'fix'],
      timeoutMs: 1000,
    },
  ];
  const root = fixture({
    'README.md': '# Home\n\n[Guide](docs/guide.md)\n',
    'docs/guide.md': '# Guide\n\n```sh docs-exec=unsafe\n./shifu fix\n```\n',
  });
  const findings = checkDocs({
    root,
    files: ['README.md', 'docs/guide.md'],
    contract: unsafe,
    vocabularyRegistry: false,
    metadataContract: false,
  });
  assert.ok(
    findings.some((finding) => finding.code === 'executable-example-unsafe'),
  );
});
