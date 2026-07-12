// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { validateDocumentMetadata } from './document-metadata-contract.mjs';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-metadata-'));
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
  metadataSchema: 'kungfu.document-metadata/v1',
  sourceKinds: ['local-files'],
  externalFrontmatterSchemas: [{ id: 'skill', patterns: ['(^|/)SKILL\\.md$'] }],
  profiles: [
    {
      id: 'architecture-decision',
      patterns: ['^adr/(ADR-[0-9]{4})-.*\\.md$'],
      frontmatterRequired: true,
      required: [
        'metadata_schema',
        'doc_type',
        'adr_id',
        'decision_status',
        'implementation_status',
        'review_state',
        'sensitivity',
      ],
      constants: {
        metadata_schema: 'kungfu.document-metadata/v1',
        doc_type: 'architecture-decision',
        sensitivity: 'public',
      },
      enums: {
        decision_status: ['proposed', 'accepted', 'superseded'],
        implementation_status: ['unknown'],
        review_state: ['legacy-unreviewed'],
      },
      forbidden: ['status'],
    },
    {
      id: 'adr-index',
      files: ['adr/README.md'],
      frontmatterRequired: true,
      required: [
        'metadata_schema',
        'doc_type',
        'document_status',
        'review_state',
        'sensitivity',
      ],
      constants: {
        metadata_schema: 'kungfu.document-metadata/v1',
        doc_type: 'adr-index',
        document_status: 'active',
        sensitivity: 'public',
      },
      enums: { review_state: ['self-reviewed'] },
      forbidden: ['status'],
    },
    {
      id: 'public-document',
      files: ['README.md'],
      frontmatterRequired: true,
      required: [
        'metadata_schema',
        'doc_type',
        'document_status',
        'review_state',
        'sensitivity',
      ],
      constants: {
        metadata_schema: 'kungfu.document-metadata/v1',
        sensitivity: 'public',
      },
      enums: {
        document_status: ['active'],
        review_state: ['unreviewed'],
      },
      forbidden: ['status'],
    },
    {
      id: 'repository-document',
      patterns: ['.*'],
      frontmatterRequired: false,
      required: [],
      forbidden: ['status'],
    },
  ],
  adrRegistries: [
    {
      index: 'adr/README.md',
      recordPattern: '^adr/(ADR-[0-9]{4})-.*\\.md$',
    },
  ],
};

const publicHeader = `---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: public-document
review_state: unreviewed
sensitivity: public
---`;
const indexHeader = `---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: adr-index
review_state: self-reviewed
sensitivity: public
---`;
const adrHeader = `---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0001
decision_status: accepted
implementation_status: unknown
review_state: legacy-unreviewed
sensitivity: public
---`;

function run(files) {
  const root = fixture(files);
  return validateDocumentMetadata({
    root,
    files: Object.keys(files).sort(),
    contract,
  });
}

test('accepts typed public metadata and aligned ADR projections', () => {
  const findings = run({
    'README.md': `${publicHeader}\n\n# Home\n`,
    'adr/README.md': `${indexHeader}\n\n# ADRs\n\n| ADR | Status | Title |\n|---|---|---|\n| [ADR-0001](ADR-0001-example.md) | accepted | Example |\n`,
    'adr/ADR-0001-example.md': `${adrHeader}\n\n# ADR-0001: Example\n\n- Status: accepted\n`,
  });
  assert.deepEqual(findings, []);
});

test('rejects missing required public frontmatter', () => {
  const findings = run({ 'README.md': '# Home\n' });
  assert.ok(findings.some((finding) => finding.code === 'metadata-required'));
});

test('rejects the ambiguous legacy status field', () => {
  const findings = run({
    'README.md': `${publicHeader.replace('document_status: active', 'status: active')}\n\n# Home\n`,
  });
  assert.ok(
    findings.some((finding) => finding.code === 'metadata-forbidden-field'),
  );
});

test('rejects ADR body status drift', () => {
  const findings = run({
    'adr/README.md': `${indexHeader}\n\n# ADRs\n\n| ADR | Status | Title |\n|---|---|---|\n| [ADR-0001](ADR-0001-example.md) | accepted | Example |\n`,
    'adr/ADR-0001-example.md': `${adrHeader}\n\n# ADR-0001: Example\n\n- Status: proposed\n`,
  });
  assert.ok(findings.some((finding) => finding.code === 'adr-status-drift'));
});

test('rejects ADR index status drift', () => {
  const findings = run({
    'adr/README.md': `${indexHeader}\n\n# ADRs\n\n| ADR | Status | Title |\n|---|---|---|\n| [ADR-0001](ADR-0001-example.md) | proposed | Example |\n`,
    'adr/ADR-0001-example.md': `${adrHeader}\n\n# ADR-0001: Example\n\n- Status: accepted\n`,
  });
  assert.ok(findings.some((finding) => finding.code === 'adr-index-drift'));
});

test('rejects implementation detail in the ADR index status column', () => {
  const findings = run({
    'adr/README.md': `${indexHeader}\n\n# ADRs\n\n| ADR | Status | Title |\n|---|---|---|\n| [ADR-0001](ADR-0001-example.md) | accepted; staged | Example |\n`,
    'adr/ADR-0001-example.md': `${adrHeader}\n\n# ADR-0001: Example\n\n- Status: accepted\n`,
  });
  assert.ok(
    findings.some((finding) => finding.code === 'adr-index-compound-status'),
  );
});

test('preserves independently consumed frontmatter schemas', () => {
  const findings = run({
    'skills/demo/SKILL.md': '---\nkey: demo\ntriggers: [demo]\n---\n\n# Demo\n',
  });
  assert.deepEqual(findings, []);
});
