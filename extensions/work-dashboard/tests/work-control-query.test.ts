import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_GOAL_CARD_QUERY,
  goalCardQueryFromView,
  workControlGoalCardView,
  parseGoalCardQuerySpec,
} from '../src/view/work-control-query.ts';

const attentionQuery = {
  ...DEFAULT_GOAL_CARD_QUERY,
  text: 'release',
  sections: ['attention'] as const,
  trust: ['stale'] as const,
  sort: { field: 'trust-risk' as const, direction: 'desc' as const },
};

test('Work Control owns goal-card validation and the Profile ViewSpec', () => {
  const view = workControlGoalCardView('3.0.0', attentionQuery);

  assert.equal(view.kind, 'profile');
  assert.equal(view.memberId, 'work-control-views');
  assert.equal(view.spec.schema, 'kungfu.work-control.goal-card-view/v1');
  assert.deepEqual(goalCardQueryFromView(view)?.sections, ['attention']);
});

test('legacy Mission Control v3 saved views project into Work Control', () => {
  const query = goalCardQueryFromView({
    kind: 'mission-control',
    profileId: 'kungfu.mission-control',
    profileVersion: '1',
    questionId: 'observed-progress',
    reducer: 'kungfu.mission-control.reducer/v1',
    goalCards: {
      ...attentionQuery,
      schema: 'kungfu.mission-control.goal-card-query/v1',
    },
  });

  assert.equal(query?.sort.field, 'trust-risk');
  assert.equal(query?.schema, 'kungfu.work-control.goal-card-query/v1');
});

test('Work Control rejects unknown trust states inside its own boundary', () => {
  assert.throws(
    () =>
      parseGoalCardQuerySpec({
        ...DEFAULT_GOAL_CARD_QUERY,
        trust: ['inherited'],
      }),
    /unsupported trust state/,
  );
});

test('Work Control rejects a foreign reducer inside its Profile envelope', () => {
  const view = workControlGoalCardView('3.0.0', attentionQuery);

  assert.throws(
    () =>
      goalCardQueryFromView({
        ...view,
        spec: { ...view.spec, reducer: 'example.foreign-reducer/v1' },
      }),
    /unsupported Work Control goal-card view contract/,
  );
});
