// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  readMetadataContract,
  validateDocumentMetadata,
  validateReachableCommit,
} from './document-metadata-contract.mjs';
import { sourceAcceptancePlan } from './source-acceptance.mjs';

const roots = [];
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

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
  metadataRegistry: 'docs/document-metadata.registry.json',
  optionalFields: [
    'implementation_commits',
    'implementation_prs',
    'closure_commit',
    'closure_pr',
    'qualification_refs',
    'supersedes',
    'superseded_by',
    'amends',
    'amended_by',
  ],
  sourceKinds: ['local-files'],
  externalFrontmatterSchemas: [{ id: 'skill', patterns: ['(^|/)SKILL\\.md$'] }],
  profiles: [
    {
      id: 'architecture-decision',
      metadataMode: 'inline',
      patterns: ['^adr/(?!README\\.md$).+\\.(?:md|markdown)$'],
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
        decision_status: [
          'proposed',
          'accepted',
          'superseded',
          'rejected',
          'withdrawn',
        ],
        implementation_status: [
          'unknown',
          'implemented',
          'not-started',
          'not-applicable',
        ],
        review_state: ['legacy-unreviewed'],
      },
      forbidden: ['status'],
    },
    {
      id: 'adr-index',
      metadataMode: 'inline',
      files: ['adr/README.md'],
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
      metadataMode: 'registry',
      files: ['README.md'],
      patterns: ['^docs/.+\\.md$'],
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
      metadataMode: 'inline-optional',
      patterns: ['.*'],
      required: [],
      forbidden: ['status'],
    },
  ],
  adrRegistries: [],
  adrEvidence: {
    commitFields: ['implementation_commits'],
    pullRequestFields: ['implementation_prs'],
    closureCommitField: 'closure_commit',
    closurePullRequestField: 'closure_pr',
    qualificationRefField: 'qualification_refs',
    statusesRequiringImplementationEvidence: ['implemented'],
    statusesRequiringClosure: ['implemented'],
    statusesForbiddingEvidence: ['not-started'],
    pullRequestPattern:
      '^https://github\\.com/kungfu-systems/kungfu/pull/[0-9]+$',
    legacyEvidenceExemptions: {},
  },
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
adr_id: KF-ADR-019f86da-4f90-7179-a900-c40bdb498910
decision_status: accepted
implementation_status: unknown
review_state: legacy-unreviewed
sensitivity: public
---`;

function run(files, documents = {}, selectedContract = contract) {
  const root = fixture({
    ...files,
    'docs/document-metadata.registry.json': `${JSON.stringify(
      {
        schemaVersion: 1,
        metadataSchema: 'kungfu.document-metadata/v1',
        documents,
      },
      null,
      2,
    )}\n`,
  });
  return validateDocumentMetadata({
    root,
    files: Object.keys(files)
      .filter((file) => /\.(?:md|markdown)$/.test(file))
      .sort(),
    contract: selectedContract,
  });
}

function identityContract() {
  const selected = structuredClone(contract);
  selected.adrIdentity = {
    root: 'adr',
    scheme: 'uuidv7',
    prefixes: ['KF-ADR', 'SHIFU-ADR'],
    filenameProjection: 'canonical-id-only',
  };
  selected.profiles[0].patterns = [
    '^adr/(?!README\\.md$).+\\.(?:md|markdown)$',
  ];
  selected.profiles[0].enums.review_state = ['legacy-unreviewed', 'unreviewed'];
  return selected;
}

function git(root, args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  return childProcess
    .execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env,
    })
    .trim();
}

function evidenceFixture(status = 'implemented') {
  const root = fixture({
    'seed.txt': 'implementation\n',
    'docs/document-metadata.registry.json': `${JSON.stringify({
      schemaVersion: 1,
      metadataSchema: 'kungfu.document-metadata/v1',
      documents: {},
    })}\n`,
  });
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['add', 'seed.txt']);
  git(root, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'seed']);
  const commit = git(root, ['rev-parse', 'HEAD']);
  const file = 'adr/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md';
  const text = `${adrHeader.replace(
    'implementation_status: unknown',
    `implementation_status: ${status}\nimplementation_commits: [${commit}]\nclosure_commit: ${commit}`,
  )}\n\n# KF-ADR-019f86da-4f90-7179-a900-c40bdb498910: Example\n\n- Status: accepted\n`;
  fs.mkdirSync(path.join(root, 'adr'), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
  return { root, file, commit };
}

test('accepts typed public metadata and aligned ADR projections', () => {
  const findings = run(
    {
      'README.md': '# Home\n',
      'adr/README.md': `${indexHeader}\n\n# ADRs\n\n| ADR | Status | Title |\n|---|---|---|\n| [KF-ADR-019f86da-4f90-7179-a900-c40bdb498910](KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md) | accepted | Example |\n`,
      'adr/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md': `${adrHeader}\n\n# KF-ADR-019f86da-4f90-7179-a900-c40bdb498910: Example\n\n- Status: accepted\n`,
    },
    {
      'README.md': {
        metadata_schema: 'kungfu.document-metadata/v1',
        document_status: 'active',
        doc_type: 'public-document',
        review_state: 'unreviewed',
        sensitivity: 'public',
      },
    },
  );
  assert.deepEqual(findings, []);
});

test('rejects deleting or weakening the repository ADR identity policy', () => {
  for (const adrIdentity of [
    undefined,
    {
      root: 'docs/adr',
      scheme: 'uuidv7',
      prefixes: ['KF-ADR', 'SHIFU-ADR'],
      filenameProjection: 'canonical-id-with-slug',
    },
  ]) {
    const root = fixture({
      'contract.json': `${JSON.stringify({
        schemaVersion: 1,
        metadataSchema: 'kungfu.document-metadata/v1',
        metadataRegistry: 'docs/document-metadata.registry.json',
        adrIdentity,
        externalFrontmatterSchemas: [],
        profiles: [],
        adrRegistries: [],
      })}\n`,
    });
    assert.throws(
      () => readMetadataContract(root, 'contract.json'),
      /must pin KF-ADR\/SHIFU-ADR UUIDv7 and ID-only filenames/,
    );
  }

  const canonical = JSON.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, 'docs/document-metadata.contract.json'),
      'utf8',
    ),
  );
  for (const mutate of [
    (value) => {
      value.profiles.find(
        (profile) => profile.id === 'architecture-decision',
      ).patterns = ['^docs/adr/[^/]+\\.md$'];
    },
    (value) => {
      value.profiles.find(
        (profile) => profile.id === 'architecture-decision',
      ).metadataMode = 'registry';
    },
    (value) => {
      const profile = value.profiles.find(
        (candidate) => candidate.id === 'architecture-decision',
      );
      profile.required = profile.required.filter((field) => field !== 'adr_id');
    },
    (value) => value.adrRegistries.push({ index: 'docs/adr/README.md' }),
  ]) {
    const weakened = structuredClone(canonical);
    mutate(weakened);
    const root = fixture({
      'contract.json': `${JSON.stringify(weakened)}\n`,
    });
    assert.throws(
      () => readMetadataContract(root, 'contract.json'),
      /ADR metadata routing must be inline/,
    );
  }
});

test('cannot bypass ADR routing with external schemas or profile order', () => {
  const invalidId = ['ADR', '9999'].join('-');
  const selected = identityContract();
  const architecture = selected.profiles.find(
    (profile) => profile.id === 'architecture-decision',
  );
  architecture.required = architecture.required.filter(
    (field) => field !== 'adr_id',
  );
  selected.externalFrontmatterSchemas.unshift({
    id: 'adr-bypass',
    patterns: ['^adr/.*'],
  });
  const publicProfile = selected.profiles.find(
    (profile) => profile.id === 'public-document',
  );
  publicProfile.patterns.unshift('^adr/.*');
  selected.profiles = [
    publicProfile,
    architecture,
    ...selected.profiles.filter(
      (profile) => profile !== publicProfile && profile !== architecture,
    ),
  ];

  const findings = run(
    {
      'adr/README.md': `${indexHeader}\n\n# ADRs\n`,
      [`adr/${invalidId}-bypass.md`]: `---\nmetadata_schema: kungfu.document-metadata/v1\ndoc_type: architecture-decision\ndecision_status: proposed\nimplementation_status: not-started\nreview_state: unreviewed\nsensitivity: public\n---\n\n# ${invalidId}: Bypass\n\n- Status: proposed\n`,
    },
    {},
    selected,
  );
  assert.ok(findings.some((finding) => finding.code === 'adr-id-required'));
});

test('accepts an ID-only UUIDv7 ADR without a shared index row', () => {
  const id = 'KF-ADR-019f8758-0efc-7011-a233-445566778899';
  const findings = run(
    {
      'adr/README.md': `${indexHeader}\n\n# ADRs\n\n| ADR | Status | Title |\n|---|---|---|\n`,
      [`adr/${id}.md`]: `---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ${id}
decision_status: proposed
implementation_status: not-started
review_state: unreviewed
sensitivity: public
---

# ${id}: Example

- Status: proposed
`,
    },
    {},
    identityContract(),
  );

  assert.deepEqual(findings, []);
});

test('rejects duplicate UUIDs and heading or owner-prefix drift', () => {
  const id = 'KF-ADR-019f8758-0efc-7011-a233-445566778899';
  const other = 'SHIFU-ADR-019f8758-0efc-7011-a233-445566778899';
  const record = (heading) => `---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ${id}
decision_status: proposed
implementation_status: not-started
review_state: unreviewed
sensitivity: public
---

# ${heading}: Example

- Status: proposed
`;
  const findings = run(
    {
      'adr/README.md': `${indexHeader}\n\n# ADRs\n`,
      [`adr/${id}.md`]: record(id),
      [`adr/${other}.md`]: record(other),
    },
    {},
    identityContract(),
  );

  assert.ok(findings.some((finding) => finding.code === 'adr-id-duplicate'));
  assert.ok(
    findings.some((finding) => finding.code === 'adr-heading-id-drift'),
  );
});

test('routes every non-index ADR Markdown file through identity validation', () => {
  const id = 'OTHER-ADR-019f8758-0efc-7011-a233-445566778899';
  const findings = run(
    {
      'adr/README.md': `${indexHeader}\n\n# ADRs\n`,
      [`adr/${id}-escape.md`]: `---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ${id}
decision_status: proposed
implementation_status: not-started
review_state: unreviewed
sensitivity: public
---

# ${id}: Escape

- Status: proposed
`,
    },
    {},
    identityContract(),
  );

  assert.ok(findings.some((finding) => finding.code === 'adr-id-format'));
  assert.ok(
    findings.some((finding) => finding.code === 'adr-filename-identity'),
  );

  for (const [rel, expectedCode] of [
    [
      'adr/nested/KF-ADR-019f8758-0efc-7011-a233-445566778899.md',
      'adr-path-layout',
    ],
    [`adr/${['ADR', '9999'].join('-')}-escape.markdown`, 'adr-path-extension'],
  ]) {
    const invalidId = ['ADR', '9999'].join('-');
    const escaped = run(
      {
        'adr/README.md': `${indexHeader}\n\n# ADRs\n`,
        [rel]: `---\nmetadata_schema: kungfu.document-metadata/v1\ndoc_type: architecture-decision\nadr_id: ${invalidId}\ndecision_status: proposed\nimplementation_status: not-started\nreview_state: unreviewed\nsensitivity: public\n---\n\n# ${invalidId}: Escape\n`,
      },
      {},
      identityContract(),
    );
    assert.ok(
      escaped.some((finding) => finding.code === expectedCode),
      `${rel} must pass through ADR identity validation`,
    );
  }
});

test('accepts reciprocal acyclic ADR supersession metadata', () => {
  const findings = run({
    'adr/README.md': `${indexHeader}

# ADRs

| ADR | Status | Title |
|---|---|---|
| [KF-ADR-019f86da-4f90-7179-a900-c40bdb498910](KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md) | superseded | Old |
| [KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a](KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a.md) | accepted | New |
`,
    'adr/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md': `---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f86da-4f90-7179-a900-c40bdb498910
decision_status: superseded
implementation_status: not-applicable
superseded_by: [KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a]
review_state: legacy-unreviewed
sensitivity: public
---

# KF-ADR-019f86da-4f90-7179-a900-c40bdb498910: Old

- Status: superseded
`,
    'adr/KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a.md': `---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a
decision_status: accepted
implementation_status: unknown
supersedes: [KF-ADR-019f86da-4f90-7179-a900-c40bdb498910]
review_state: legacy-unreviewed
sensitivity: public
---

# KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a: New

- Status: accepted
`,
  });
  assert.deepEqual(findings, []);
});

test('rejects one-sided and cyclic ADR supersession graphs', () => {
  const findings = run({
    'adr/README.md': `${indexHeader}

# ADRs

| ADR | Status | Title |
|---|---|---|
| [KF-ADR-019f86da-4f90-7179-a900-c40bdb498910](KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md) | superseded | One |
| [KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a](KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a.md) | superseded | Two |
`,
    'adr/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md': `---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f86da-4f90-7179-a900-c40bdb498910
decision_status: superseded
implementation_status: not-applicable
supersedes: [KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a]
superseded_by: [KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a]
review_state: legacy-unreviewed
sensitivity: public
---

# KF-ADR-019f86da-4f90-7179-a900-c40bdb498910: One

- Status: superseded
`,
    'adr/KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a.md': `---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a
decision_status: superseded
implementation_status: not-applicable
supersedes: [KF-ADR-019f86da-4f90-7179-a900-c40bdb498910]
superseded_by: [KF-ADR-019f86da-4f90-7179-a900-c40bdb498910]
review_state: legacy-unreviewed
sensitivity: public
---

# KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a: Two

- Status: superseded
`,
  });
  assert.ok(
    findings.some((finding) => finding.code === 'adr-supersession-cycle'),
  );
});

test('accepts reciprocal acyclic ADR amendment metadata without retiring the target', () => {
  const findings = run({
    'adr/README.md': `${indexHeader}

# ADRs

| ADR | Status | Title |
|---|---|---|
`,
    'adr/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md': `---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f86da-4f90-7179-a900-c40bdb498910
decision_status: accepted
implementation_status: unknown
amended_by: [KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a]
review_state: legacy-unreviewed
sensitivity: public
---

# KF-ADR-019f86da-4f90-7179-a900-c40bdb498910: Original

- Status: accepted
`,
    'adr/KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a.md': `---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a
decision_status: accepted
implementation_status: unknown
amends: [KF-ADR-019f86da-4f90-7179-a900-c40bdb498910]
review_state: legacy-unreviewed
sensitivity: public
---

# KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a: Amendment

- Status: accepted
`,
  });
  assert.deepEqual(findings, []);
});

test('rejects one-sided ADR amendment metadata', () => {
  const findings = run({
    'adr/README.md': `${indexHeader}

# ADRs

| ADR | Status | Title |
|---|---|---|
`,
    'adr/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md': `${adrHeader}

# KF-ADR-019f86da-4f90-7179-a900-c40bdb498910: Original

- Status: accepted
`,
    'adr/KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a.md': `---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a
decision_status: accepted
implementation_status: unknown
amends: [KF-ADR-019f86da-4f90-7179-a900-c40bdb498910]
review_state: legacy-unreviewed
sensitivity: public
---

# KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a: Amendment

- Status: accepted
`,
  });
  assert.ok(
    findings.some((finding) => finding.code === 'adr-amendment-reciprocal'),
  );
});

test('rejects cyclic reciprocal ADR amendment metadata', () => {
  const findings = run({
    'adr/README.md': `${indexHeader}

# ADRs

| ADR | Status | Title |
|---|---|---|
`,
    'adr/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md': `---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f86da-4f90-7179-a900-c40bdb498910
decision_status: accepted
implementation_status: unknown
amends: [KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a]
amended_by: [KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a]
review_state: legacy-unreviewed
sensitivity: public
---

# KF-ADR-019f86da-4f90-7179-a900-c40bdb498910: One

- Status: accepted
`,
    'adr/KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a.md': `---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a
decision_status: accepted
implementation_status: unknown
amends: [KF-ADR-019f86da-4f90-7179-a900-c40bdb498910]
amended_by: [KF-ADR-019f86da-4f90-7179-a900-c40bdb498910]
review_state: legacy-unreviewed
sensitivity: public
---

# KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a: Two

- Status: accepted
`,
  });
  assert.ok(findings.some((finding) => finding.code === 'adr-amendment-cycle'));
});

test('rejects missing required public registry metadata', () => {
  const findings = run({ 'README.md': '# Home\n' });
  assert.ok(
    findings.some((finding) => finding.code === 'metadata-registry-required'),
  );
});

test('rejects the ambiguous legacy status field', () => {
  const findings = run(
    {
      'README.md': '# Home\n',
    },
    {
      'README.md': {
        metadata_schema: 'kungfu.document-metadata/v1',
        status: 'active',
        doc_type: 'public-document',
        review_state: 'unreviewed',
        sensitivity: 'public',
      },
    },
  );
  assert.ok(
    findings.some((finding) => finding.code === 'metadata-forbidden-field'),
  );
});

test('rejects visible frontmatter when the registry is authoritative', () => {
  const findings = run(
    { 'README.md': `${publicHeader}\n\n# Home\n` },
    {
      'README.md': {
        metadata_schema: 'kungfu.document-metadata/v1',
        document_status: 'active',
        doc_type: 'public-document',
        review_state: 'unreviewed',
        sensitivity: 'public',
      },
    },
  );
  assert.ok(
    findings.some((finding) => finding.code === 'metadata-authority-duplicate'),
  );
});

test('rejects undeclared maintenance attribution in registry metadata', () => {
  const findings = run(
    { 'README.md': '# Home\n' },
    {
      'README.md': {
        metadata_schema: 'kungfu.document-metadata/v1',
        document_status: 'active',
        doc_type: 'public-document',
        review_state: 'unreviewed',
        sensitivity: 'public',
        generation_attribution: 'automated',
      },
    },
  );
  assert.ok(
    findings.some((finding) => finding.code === 'metadata-unknown-field'),
  );
});

test('rejects orphaned registry entries', () => {
  const findings = run(
    {},
    {
      'missing.md': {
        metadata_schema: 'kungfu.document-metadata/v1',
        document_status: 'active',
        doc_type: 'public-document',
        review_state: 'unreviewed',
        sensitivity: 'public',
      },
    },
  );
  assert.ok(
    findings.some((finding) => finding.code === 'metadata-registry-orphan'),
  );
});

test('rejects ADR body status drift', () => {
  const findings = run({
    'adr/README.md': `${indexHeader}\n\n# ADRs\n\n| ADR | Status | Title |\n|---|---|---|\n| [KF-ADR-019f86da-4f90-7179-a900-c40bdb498910](KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md) | accepted | Example |\n`,
    'adr/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md': `${adrHeader}\n\n# KF-ADR-019f86da-4f90-7179-a900-c40bdb498910: Example\n\n- Status: proposed\n`,
  });
  assert.ok(findings.some((finding) => finding.code === 'adr-status-drift'));
});

test('preserves independently consumed frontmatter schemas', () => {
  const findings = run({
    'skills/demo/SKILL.md': '---\nkey: demo\ntriggers: [demo]\n---\n\n# Demo\n',
  });
  assert.deepEqual(findings, []);
});

test('accepts reachable full-SHA implementation and closure evidence', () => {
  const { root, file } = evidenceFixture();
  const findings = validateDocumentMetadata({ root, files: [file], contract });
  assert.deepEqual(findings, []);
});

test('pins PR evidence reachability to the source-acceptance base SHA', () => {
  const base = 'a'.repeat(40);
  const documentation = sourceAcceptancePlan([], base).find(
    (step) => step.label === 'documentation contracts',
  );
  assert.equal(documentation?.env?.KUNGFU_ADR_EVIDENCE_BASE_SHA, base);
  assert.deepEqual(documentation?.args, ['scripts/run-docs-source-check.mjs']);
});

test('runs Git-sensitive documentation fixtures serially in both gates', () => {
  for (const runner of ['run-docs-check.mjs', 'run-docs-source-check.mjs']) {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts', runner),
      'utf8',
    );
    assert.match(source, /'--test-concurrency=1'/);
    assert.match(source, /path\.join\('scripts', 'adr-identity\.test\.mjs'\)/);
    assert.match(source, /path\.join\('scripts', 'adr-new\.test\.mjs'\)/);
    assert.equal(source.includes(['adr', 'migration'].join('-')), false);
  }
});

test('accepts a merge preview by default but rejects PR-only evidence against its base', () => {
  const root = fixture({ 'seed.txt': 'seed\n' });
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['add', 'seed.txt']);
  git(root, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'seed']);
  const base = git(root, ['rev-parse', 'HEAD']);

  git(root, ['checkout', '-q', '-b', 'evidence']);
  fs.writeFileSync(path.join(root, 'evidence.txt'), 'evidence\n');
  git(root, ['add', 'evidence.txt']);
  git(root, [
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-q',
    '-m',
    'evidence',
  ]);
  const evidence = git(root, ['rev-parse', 'HEAD']);

  git(root, ['checkout', '-q', '-b', 'integration', base]);
  fs.writeFileSync(path.join(root, 'integration.txt'), 'integration\n');
  git(root, ['add', 'integration.txt']);
  git(root, [
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-q',
    '-m',
    'integration',
  ]);
  assert.match(validateReachableCommit(root, evidence), /not reachable/);

  git(root, ['merge', '--no-commit', '--no-ff', 'evidence']);
  assert.equal(validateReachableCommit(root, evidence), null);
  assert.match(
    validateReachableCommit(root, evidence, base),
    new RegExp(`is not reachable from pull-request base history ${base}`),
  );
  assert.equal(validateReachableCommit(root, base, base), null);
});

test('accepts stable PR implementation and closure evidence', () => {
  const { root, file } = evidenceFixture();
  const target = path.join(root, file);
  fs.writeFileSync(
    target,
    fs
      .readFileSync(target, 'utf8')
      .replace(
        /^implementation_commits:.*\nclosure_commit:.*$/m,
        'implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/731]\nclosure_pr: https://github.com/kungfu-systems/kungfu/pull/731',
      ),
  );
  const findings = validateDocumentMetadata({ root, files: [file], contract });
  assert.deepEqual(findings, []);
});

test('rejects closure PR evidence outside the canonical repository', () => {
  const { root, file } = evidenceFixture();
  const target = path.join(root, file);
  fs.writeFileSync(
    target,
    fs
      .readFileSync(target, 'utf8')
      .replace(
        /^closure_commit:.*$/m,
        'closure_pr: https://github.com/example/fork/pull/1',
      ),
  );
  const findings = validateDocumentMetadata({ root, files: [file], contract });
  assert.ok(findings.some((finding) => finding.code === 'adr-evidence-pr'));
});

test('rejects malformed implementation commit evidence', () => {
  const { root, file, commit } = evidenceFixture();
  const target = path.join(root, file);
  fs.writeFileSync(
    target,
    fs.readFileSync(target, 'utf8').replace(commit, commit.slice(0, 12)),
  );
  const findings = validateDocumentMetadata({ root, files: [file], contract });
  assert.ok(findings.some((finding) => finding.code === 'adr-evidence-commit'));
});

test('rejects implementation evidence on a not-started ADR', () => {
  const { root, file } = evidenceFixture('not-started');
  const findings = validateDocumentMetadata({ root, files: [file], contract });
  assert.ok(
    findings.some((finding) => finding.code === 'adr-evidence-contradiction'),
  );
});

test('rejects pull-request evidence outside the canonical repository', () => {
  const { root, file } = evidenceFixture();
  const target = path.join(root, file);
  fs.writeFileSync(
    target,
    fs
      .readFileSync(target, 'utf8')
      .replace(
        /^closure_commit:/m,
        'implementation_prs: [https://github.com/example/fork/pull/1]\nclosure_commit:',
      ),
  );
  const findings = validateDocumentMetadata({ root, files: [file], contract });
  assert.ok(findings.some((finding) => finding.code === 'adr-evidence-pr'));
});

test('rejects a legacy exemption after evidence becomes complete', () => {
  const { root, file } = evidenceFixture();
  const exempted = {
    ...contract,
    adrEvidence: {
      ...contract.adrEvidence,
      legacyEvidenceExemptions: {
        'KF-ADR-019f86da-4f90-7179-a900-c40bdb498910': 'legacy debt',
      },
    },
  };
  const findings = validateDocumentMetadata({
    root,
    files: [file],
    contract: exempted,
  });
  assert.ok(
    findings.some((finding) => finding.code === 'adr-evidence-exemption-stale'),
  );
});
