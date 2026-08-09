import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_ASSIGNMENT_CARD_QUERY,
  assignmentCardQueryFromView,
  parseAssignmentCardQuerySpec,
  workControlAssignmentCardView,
} from '../src/view/work-control-query.ts';

const attentionQuery = {
  ...DEFAULT_ASSIGNMENT_CARD_QUERY,
  text: 'release',
  sections: ['attention'] as const,
  trust: ['stale'] as const,
  sort: { field: 'trust-risk' as const, direction: 'desc' as const },
};

test('Work Control owns assignment-card validation and the Profile ViewSpec', () => {
  const view = workControlAssignmentCardView('3.0.0', attentionQuery);

  assert.equal(view.kind, 'profile');
  assert.equal(view.memberId, 'work-control-views');
  assert.equal(view.spec.schema, 'kungfu.work-control.assignment-card-view/v1');
  assert.deepEqual(assignmentCardQueryFromView(view)?.sections, ['attention']);
});

test('Work Control rejects unknown trust states inside its own boundary', () => {
  assert.throws(
    () =>
      parseAssignmentCardQuerySpec({
        ...DEFAULT_ASSIGNMENT_CARD_QUERY,
        trust: ['inherited'],
      }),
    /unsupported trust state/,
  );
});

test('Work Control rejects a foreign reducer inside its Profile envelope', () => {
  const view = workControlAssignmentCardView('3.0.0', attentionQuery);

  assert.throws(
    () =>
      assignmentCardQueryFromView({
        ...view,
        spec: { ...view.spec, reducer: 'example.foreign-reducer/v1' },
      }),
    /unsupported Work Control assignment-card view contract/,
  );
});
