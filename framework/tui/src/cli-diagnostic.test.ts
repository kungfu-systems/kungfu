// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { describeCliFailure } from './terminal-lifecycle.js';

test('projects a structured CLI diagnosis instead of the child-process wrapper', () => {
  assert.equal(
    describeCliFailure(
      new Error('Command failed: kungfu profile member-call'),
      JSON.stringify({
        schema: 'kungfu.profile-diagnosis/v1',
        ok: false,
        code: 'profile-not-active',
        message: 'Profile member adapters require an active exact Profile root',
      }),
    ),
    'profile-not-active: Profile member adapters require an active exact Profile root',
  );
});

test('falls back through stderr, stdout and the process error', () => {
  assert.equal(
    describeCliFailure(new Error('wrapper'), 'not-json', 'specific stderr'),
    'specific stderr',
  );
  assert.equal(describeCliFailure(new Error('wrapper')), 'wrapper');
});

test('collapses a Python traceback to one actionable terminal line', () => {
  assert.equal(
    describeCliFailure(
      new Error('Command failed'),
      '',
      `Traceback (most recent call last):
  File "<frozen runpy>", line 203, in _run_module_as_main
  File "kungfu/cli/__init__.py", line 14, in select
    next(m for m in modules if m.main())
StopIteration`,
    ),
    'Kungfu CLI routing produced no command result.',
  );
  assert.equal(
    describeCliFailure(
      new Error('Command failed'),
      '',
      `Traceback (most recent call last):
  File "profile.py", line 10, in load
RuntimeError: No Profile answers are available at this cut.`,
    ),
    'RuntimeError: No Profile answers are available at this cut.',
  );
});
