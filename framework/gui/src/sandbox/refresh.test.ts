import assert from 'node:assert/strict';
import test from 'node:test';

import { publishRefresh } from './refresh.ts';

test('refresh bus isolates subscribers and continues after a failure', () => {
  const calls: string[] = [];
  const errors: unknown[] = [];

  publishRefresh(
    new Set([
      () => calls.push('first'),
      () => {
        throw new Error('broken view');
      },
      () => calls.push('last'),
    ]),
    (error) => errors.push(error),
  );

  assert.deepEqual(calls, ['first', 'last']);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /broken view/);
});
