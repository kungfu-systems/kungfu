import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type QueryChangelogPage,
  applyQueryChangelogPage,
  emptyQueryChangelogState,
  parseSavedQueryView,
} from '../src/capability/query.ts';

const token = {
  schema: 'kungfu.query.resume-token/v1' as const,
  definition: {
    schema: 'kungfu.query.definition/v1' as const,
    basis: {},
    object: 'episodes',
    limit: 100,
    evidence: 'proof',
  },
  query_definition_hash: 'query',
  logical_plan_hash: 'plan',
  from: { kind: 'empty' as const, record_count: '0' },
  from_result_hash: '',
  target: {
    kind: 'manifest_frame_uid' as const,
    manifest_frame_uid: '20',
    record_count: '2',
  },
  target_result_hash: 'result',
  next_message_index: 0,
  batch_id: 'batch',
  token_hash: 'token',
};

function page(messages: QueryChangelogPage['messages']): QueryChangelogPage {
  return {
    schema: 'kungfu.query.changelog/v1',
    batch_id: 'batch',
    messages,
    resume_token: token,
    complete: true,
  };
}

test('changelog replay is idempotent and evidence stays visible', () => {
  const snapshot = page([
    {
      type: 'SnapshotBegin',
      message_id: 'begin',
      index: 0,
      basis: {},
      result_schema: { schema: 'rows/v1', fields: [] },
    },
    {
      type: 'RowUpsert',
      message_id: 'row',
      index: 1,
      key: '48',
      row: { episode_id: '48', status: 'open' },
      evidence_ref: {
        content_root_status: 'unverifiable',
        determinism: 'unverifiable',
      },
    },
    {
      type: 'SnapshotEnd',
      message_id: 'end',
      index: 2,
      result_hash: 'result',
      frontier: {
        kind: 'manifest_frame_uid',
        manifest_frame_uid: '20',
        record_count: '2',
      },
    },
  ]);
  const applied = applyQueryChangelogPage(emptyQueryChangelogState(), snapshot);
  const replayed = applyQueryChangelogPage(applied, snapshot);

  assert.deepEqual(replayed, applied);
  assert.equal(replayed.rows['48']?.status, 'open');
  assert.equal(replayed.evidence['48']?.content_root_status, 'unverifiable');
});

test('gap halts mutation and frontier regression fails closed', () => {
  const gap = applyQueryChangelogPage(
    emptyQueryChangelogState(),
    page([
      {
        type: 'Gap',
        message_id: 'gap',
        index: 0,
        expected: { result_hash: 'old' },
        observed: { result_hash: 'new' },
        recovery_hint: 'discard-token-and-request-full-snapshot',
      },
      {
        type: 'RowUpsert',
        message_id: 'after-gap',
        index: 1,
        key: '48',
        row: { episode_id: '48' },
        evidence_ref: {},
      },
    ]),
  );
  assert.equal(gap.gap?.type, 'Gap');
  assert.deepEqual(gap.rows, {});

  const advanced = {
    ...emptyQueryChangelogState(),
    frontier: {
      kind: 'manifest_frame_uid' as const,
      manifest_frame_uid: '20',
      record_count: '2',
    },
  };
  assert.throws(
    () =>
      applyQueryChangelogPage(
        advanced,
        page([
          {
            type: 'Progress',
            message_id: 'regression',
            index: 0,
            frontier: {
              kind: 'manifest_frame_uid',
              manifest_frame_uid: '999',
              record_count: '1',
            },
            watermark: {},
          },
        ]),
      ),
    /frontier regressed/,
  );
});

test('attention saved view remains presentation-only', () => {
  const definition = {
    ...token.definition,
    temporal_pattern: {
      schema: 'kungfu.query.temporal-pattern/v1' as const,
      partition_by: 'source',
      order_by: 'begin_time',
      sequence: [
        { field: 'title', equals: 'alpha_published' },
        { field: 'title', equals: 'gate_failed' },
      ] as const,
      repeat: { min: 2, max: 8 },
      within_ns: '3600000000000',
      as_of_time: '7200000000000',
      absence: { field: 'title', equals: 'stable_published' },
    },
  };
  const saved = parseSavedQueryView({
    schema: 'kungfu.query.saved-view/v1',
    name: 'release attention',
    definition,
    view: {
      kind: 'attention',
      partitionField: 'partition_key',
      repeatField: 'repeat_count',
      elapsedField: 'elapsed_ns',
      attributionField: 'attribution_counts',
      evidenceField: 'matched_episode_ids',
    },
  });

  assert.equal(saved.view.kind, 'attention');
  assert.deepEqual(
    saved.definition.temporal_pattern,
    definition.temporal_pattern,
  );
});

test('saved Mission Control view preserves query ownership', () => {
  const saved = parseSavedQueryView({
    schema: 'kungfu.query.saved-view/v1',
    name: 'What actually happened?',
    definition: {
      schema: 'kungfu.query.definition/v1',
      basis: { cut: { kind: 'head' } },
      object: 'fact-state',
      subject_keys: ['atlas:mission-a'],
      limit: 1,
      evidence: 'proof',
    },
    view: {
      kind: 'mission-control',
      profileId: 'kungfu.mission-control',
      profileVersion: '1',
      questionId: 'observed-progress',
      reducer: 'kungfu.mission-control.reducer/v1',
    },
  });

  assert.equal(saved.view.kind, 'mission-control');
  assert.equal(saved.definition.object, 'fact-state');
});
