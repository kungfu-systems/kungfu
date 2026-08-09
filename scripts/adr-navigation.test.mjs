// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildAdrNavigation, renderAdrNavigation } from './adr-navigation.mjs';

function record(id, overrides = {}) {
  return {
    id,
    owner: 'kungfu',
    file: `docs/adr/${id}.md`,
    title: 'Runtime storage facts',
    theme: 'runtime-storage',
    decisionStatus: 'accepted',
    implementationStatus: 'implemented',
    reviewState: 'maintainer-reviewed',
    qualificationRefs: ['tests/proof'],
    supersedes: [],
    supersededBy: [],
    ...overrides,
  };
}

test('separates authoritative relations from navigation-only neighbors', () => {
  const oldId = 'KF-ADR-019f86da-4f90-7000-8000-000000000001';
  const newId = 'KF-ADR-019f86da-4f90-7000-8000-000000000002';
  const projection = buildAdrNavigation([
    record(oldId, {
      title: 'Journal layout',
      supersededBy: [newId],
    }),
    record(newId, {
      title: 'Journal layout v2',
      supersedes: [oldId],
    }),
  ]);
  assert.equal(projection.summary.records, 2);
  assert.deepEqual(projection.authoritativeEdges, [
    {
      source: newId,
      target: oldId,
      relation: 'supersedes',
      authority: 'adr-frontmatter',
    },
  ]);
  assert.ok(
    projection.records.every(
      (item) => item.inferredNavigationNeighbors.length === 1,
    ),
  );
});

test('renders compact links without exposing UUID filenames as labels', () => {
  const id = 'KF-ADR-019f86da-4f90-7000-8000-000000000001';
  const markdown = renderAdrNavigation(buildAdrNavigation([record(id)]));
  assert.match(markdown, /\[Runtime storage facts\]\(\.\.\/adr\/KF-ADR-/);
  assert.match(markdown, /navigation-only/);
  assert.doesNotMatch(markdown, new RegExp(`\\[${id}\\]`));
});

test('uses whole terms for domains and explains semantic neighborhoods', () => {
  const artifact = record('KF-ADR-019f86da-4f90-7000-8000-000000000003', {
    title: 'Local artifact catalog',
    theme: '',
  });
  const storage = record('KF-ADR-019f86da-4f90-7000-8000-000000000004', {
    title: 'Storage journal replay',
    theme: 'runtime-storage',
  });
  const storagePeer = record('KF-ADR-019f86da-4f90-7000-8000-000000000005', {
    title: 'Storage journal facts',
    theme: 'runtime-storage',
  });
  const projection = buildAdrNavigation([artifact, storage, storagePeer]);
  assert.equal(
    projection.records.find((item) => item.id === artifact.id).domain,
    'build-release',
  );
  const related = projection.records.find((item) => item.id === storage.id);
  assert.deepEqual(related.inferredNavigationNeighbors, [storagePeer.id]);
  assert.match(related.inferredNavigation[0].reason, /same theme:/);
  assert.match(related.inferredNavigation[0].reason, /shared terms:/);
});
