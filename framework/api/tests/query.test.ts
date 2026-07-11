import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type QueryChangelogPage,
  applyQueryChangelogPage,
  emptyQueryChangelogState,
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
