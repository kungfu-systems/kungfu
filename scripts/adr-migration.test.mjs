// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  applyAdrMigrationPlan,
  createAdrMigrationPlan,
} from './adr-migration.mjs';

const roots = [];

function git(root, args, extraEnv = {}) {
  return childProcess
    .execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith('GIT_'),
          ),
        ),
        ...extraEnv,
      },
    })
    .trim();
}

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function record(id, title) {
  return `---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ${id}
decision_status: accepted
implementation_status: unknown
review_state: legacy-unreviewed
sensitivity: public
---

# ${id}: ${title}

- Status: accepted
`;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-adr-migration-'));
  roots.push(root);
  const records = [
    { id: 'ADR-0001', path: 'docs/adr/ADR-0001-first.md' },
    { id: 'SHIFU-ADR-0002', path: 'docs/adr/SHIFU-ADR-0002-second.md' },
  ];
  write(
    root,
    'docs/adr/legacy-identities.v1.json',
    `${JSON.stringify({
      schema: 'kungfu.adr-legacy-identities/v1',
      cutoverCommit: 'a'.repeat(40),
      records,
    })}\n`,
  );
  write(root, records[0].path, record(records[0].id, 'First'));
  write(root, records[1].path, record(records[1].id, 'Second'));
  write(
    root,
    'docs/README.md',
    '[First](adr/ADR-0001-first.md), SHIFU-ADR-0002, and unrelated ADR-00010.\n',
  );
  write(
    root,
    'crates/xinfa/fixtures/golden/history.json',
    '{"decision":"ADR-0001"}\n',
  );
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['add', '.']);
  git(
    root,
    ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'fixture'],
    {
      GIT_AUTHOR_DATE: '2026-07-22T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-07-22T00:00:00Z',
    },
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

test('plans deterministic ID-only renames from an exact Git tree', () => {
  const root = fixture();
  const first = createAdrMigrationPlan({ root });
  const second = createAdrMigrationPlan({ root });

  assert.deepEqual(first, second);
  assert.match(first.source.root, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.mappings.length, 2);
  assert.ok(
    first.mappings.every(
      (row) =>
        row.targetPath === `docs/adr/${row.targetId}.md` &&
        !row.targetPath.includes('-first') &&
        !row.targetPath.includes('-second'),
    ),
  );
  assert.equal(first.problems.length, 0);
  assert.deepEqual(first.conservation, {
    sourceIdentities: 2,
    targetIdentities: 2,
    oneToOne: true,
  });
  assert.equal(first.preserved.length, 2);
  assert.ok(
    first.preserved.every((row) => row.lifecycle === 'historical-append-only'),
  );
});

test('applies a reviewed manifest idempotently and preserves historical bytes', () => {
  const root = fixture();
  const plan = createAdrMigrationPlan({ root });
  const historical = path.join(
    root,
    'crates/xinfa/fixtures/golden/history.json',
  );
  const before = fs.readFileSync(historical);

  assert.equal(
    applyAdrMigrationPlan(root, plan, plan.source.root).changed,
    true,
  );
  assert.equal(
    applyAdrMigrationPlan(root, plan, plan.source.root).changed,
    false,
  );
  assert.deepEqual(fs.readFileSync(historical), before);
  for (const row of plan.mappings) {
    assert.equal(fs.existsSync(path.join(root, row.path)), false);
    assert.equal(fs.existsSync(path.join(root, row.targetPath)), true);
  }
  const docs = fs.readFileSync(path.join(root, 'docs/README.md'), 'utf8');
  assert.ok(plan.mappings.every((row) => docs.includes(row.targetId)));
  assert.match(docs, /ADR-00010/);
});

test('fails closed on expected-root or working-file drift', () => {
  const root = fixture();
  const plan = createAdrMigrationPlan({ root });
  assert.throws(
    () => applyAdrMigrationPlan(root, plan, `sha256:${'0'.repeat(64)}`),
    /expected source root/,
  );
  fs.appendFileSync(path.join(root, 'docs/README.md'), 'drift\n');
  assert.throws(
    () => applyAdrMigrationPlan(root, plan, plan.source.root),
    /differs from both manifest source and result/,
  );
});
