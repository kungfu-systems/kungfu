// SPDX-License-Identifier: Apache-2.0

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeStubText } = require('../.gyp/gen-stubs');

test('normalizes unresolved type annotations without changing ellipsis semantics', () => {
  const generated = [
    'def direct(value: ...) -> None:',
    '    ...',
    'def optional(value: ... = ...) -> ...:',
    '    ...',
    'def keyword(from: int) -> None:   ',
    '    ...',
    '',
  ].join('\r\n');

  assert.equal(
    normalizeStubText(generated),
    [
      'def direct(value: typing.Any) -> None:',
      '    ...',
      'def optional(value: typing.Any = ...) -> ...:',
      '    ...',
      'def keyword(from_: int) -> None:',
      '    ...',
      '',
    ].join('\n'),
  );
});
