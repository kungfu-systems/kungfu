import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assignmentSelector,
  resolveWorkProject,
} from '../src/view/project-work-run.ts';

test('a Work card binds its exact Assignment and owning Project', () => {
  const projects = [
    { id: 'project:a', path: '/projects/a' },
    { id: 'project:b', path: '/projects/b' },
  ];

  assert.equal(
    assignmentSelector('initiative-a:create-launch-brief'),
    'create-launch-brief',
  );
  assert.deepEqual(
    resolveWorkProject([{ workspace_id: 'project:b' }], projects),
    projects[1],
  );
  assert.deepEqual(
    resolveWorkProject([{ workspace_id: '/projects/a' }], projects),
    projects[0],
  );
});
