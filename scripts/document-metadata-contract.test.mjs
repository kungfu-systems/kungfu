// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  validateDocumentMetadata,
  validateReachableCommit,
} from './document-metadata-contract.mjs';

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
  ],
  sourceKinds: ['local-files'],
  externalFrontmatterSchemas: [{ id: 'skill', patterns: ['(^|/)SKILL\\.md$'] }],
  profiles: [
    {
      id: 'architecture-decision',
      metadataMode: 'inline',
      patterns: ['^adr/(ADR-[0-9]{4})-.*\\.md$'],
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
  adrRegistries: [
    {
      index: 'adr/README.md',
      recordPattern: '^adr/(ADR-[0-9]{4})-.*\\.md$',
    },
  ],
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
adr_id: ADR-0001
decision_status: accepted
implementation_status: unknown
review_state: legacy-unreviewed
sensitivity: public
---`;

function run(files, documents = {}) {
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
      .filter((file) => file.endsWith('.md'))
      .sort(),
    contract,
  });
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
  const file = 'adr/ADR-0001-example.md';
  const text = `${adrHeader.replace(
    'implementation_status: unknown',
    `implementation_status: ${status}\nimplementation_commits: [${commit}]\nclosure_commit: ${commit}`,
  )}\n\n# ADR-0001: Example\n\n- Status: accepted\n`;
  fs.mkdirSync(path.join(root, 'adr'), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
  return { root, file, commit };
}

test('accepts typed public metadata and aligned ADR projections', () => {
  const findings = run(
    {
      'README.md': '# Home\n',
      'adr/README.md': `${indexHeader}\n\n# ADRs\n\n| ADR | Status | Title |\n|---|---|---|\n| [ADR-0001](ADR-0001-example.md) | accepted | Example |\n`,
      'adr/ADR-0001-example.md': `${adrHeader}\n\n# ADR-0001: Example\n\n- Status: accepted\n`,
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

test('accepts reciprocal acyclic ADR supersession metadata', () => {
  const findings = run({
    'adr/README.md': `${indexHeader}

# ADRs

| ADR | Status | Title |
|---|---|---|
| [ADR-0001](ADR-0001-example.md) | superseded | Old |
| [ADR-0002](ADR-0002-replacement.md) | accepted | New |
`,
    'adr/ADR-0001-example.md': `---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0001
decision_status: superseded
implementation_status: not-applicable
superseded_by: [ADR-0002]
review_state: legacy-unreviewed
sensitivity: public
---

# ADR-0001: Old

- Status: superseded
`,
    'adr/ADR-0002-replacement.md': `---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0002
decision_status: accepted
implementation_status: unknown
supersedes: [ADR-0001]
review_state: legacy-unreviewed
sensitivity: public
---

# ADR-0002: New

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
| [ADR-0001](ADR-0001-example.md) | superseded | One |
| [ADR-0002](ADR-0002-example.md) | superseded | Two |
`,
    'adr/ADR-0001-example.md': `---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0001
decision_status: superseded
implementation_status: not-applicable
supersedes: [ADR-0002]
superseded_by: [ADR-0002]
review_state: legacy-unreviewed
sensitivity: public
---

# ADR-0001: One

- Status: superseded
`,
    'adr/ADR-0002-example.md': `---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0002
decision_status: superseded
implementation_status: not-applicable
supersedes: [ADR-0001]
superseded_by: [ADR-0001]
review_state: legacy-unreviewed
sensitivity: public
---

# ADR-0002: Two

- Status: superseded
`,
  });
  assert.ok(
    findings.some((finding) => finding.code === 'adr-supersession-cycle'),
  );
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

test('accepts reachable full-SHA implementation and closure evidence', () => {
  const { root, file } = evidenceFixture();
  const findings = validateDocumentMetadata({ root, files: [file], contract });
  assert.deepEqual(findings, []);
});

test('pins PR evidence reachability to the workflow base SHA', () => {
  const workflow = fs.readFileSync(
    path.join(REPO_ROOT, '.github/workflows/docs-check.yml'),
    'utf8',
  );
  assert.match(workflow, /"scripts\/document-metadata-contract\.mjs"/);
  assert.match(
    workflow,
    /KUNGFU_ADR_EVIDENCE_BASE_SHA:\s*\$\{\{ github\.event\.pull_request\.base\.sha \}\}/,
  );
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
      legacyEvidenceExemptions: { 'ADR-0001': 'legacy debt' },
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
