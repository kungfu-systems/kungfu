// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveMacSigningIdentity } from './sign-macos.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');

test('preserves an explicit certificate hash for duplicate named identities', () => {
  assert.equal(
    resolveMacSigningIdentity(
      { identity: 'Developer ID Application: Example (TEAMID)' },
      { CSC_NAME: '0123456789abcdef0123456789abcdef01234567' },
    ),
    '0123456789abcdef0123456789abcdef01234567',
  );
});

test('falls back to the identity resolved by electron-builder', () => {
  assert.equal(
    resolveMacSigningIdentity(
      { identity: 'Developer ID Application: Example (TEAMID)' },
      { CSC_NAME: 'Example' },
    ),
    'Developer ID Application: Example (TEAMID)',
  );
});

test('both desktop builders resolve the signing hook from the GUI project', () => {
  for (const config of [
    'framework/gui/electron-builder.yml',
    'product/electron-builder.yml',
  ]) {
    assert.match(
      fs.readFileSync(path.join(ROOT, config), 'utf8'),
      /^\s+sign: \.\/scripts\/sign-macos\.mjs$/m,
      config,
    );
  }
});
