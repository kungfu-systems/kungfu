import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_GOAL_CARD_QUERY,
  goalCardQueryFromView,
  missionControlGoalCardView,
  parseGoalCardQuerySpec,
} from '../src/view/mission-control-query.ts';

const attentionQuery = {
  ...DEFAULT_GOAL_CARD_QUERY,
  text: 'release',
  sections: ['attention'] as const,
  trust: ['stale'] as const,
  sort: { field: 'trust-risk' as const, direction: 'desc' as const },
};

test('Mission Control owns goal-card validation and the Profile ViewSpec', () => {
  const view = missionControlGoalCardView('3.0.0', attentionQuery);

  assert.equal(view.kind, 'profile');
  assert.equal(view.memberId, 'mission-control-views');
  assert.equal(view.spec.schema, 'kungfu.mission-control.goal-card-view/v1');
  assert.deepEqual(goalCardQueryFromView(view)?.sections, ['attention']);
});

test('legacy Mission Control saved views remain readable for explicit migration', () => {
  const query = goalCardQueryFromView({
    kind: 'mission-control',
    profileId: 'kungfu.mission-control',
    profileVersion: '1',
    questionId: 'observed-progress',
    reducer: 'kungfu.mission-control.reducer/v1',
    goalCards: attentionQuery,
  });

  assert.equal(query?.sort.field, 'trust-risk');
});

test('Mission Control rejects unknown trust states inside its own boundary', () => {
  assert.throws(
    () =>
      parseGoalCardQuerySpec({
        ...DEFAULT_GOAL_CARD_QUERY,
        trust: ['inherited'],
      }),
    /unsupported trust state/,
  );
});

test('Mission Control rejects a foreign reducer inside its Profile envelope', () => {
  const view = missionControlGoalCardView('3.0.0', attentionQuery);

  assert.throws(
    () =>
      goalCardQueryFromView({
        ...view,
        spec: { ...view.spec, reducer: 'example.foreign-reducer/v1' },
      }),
    /unsupported Mission Control goal-card view contract/,
  );
});
