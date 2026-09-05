// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('affected-native proof bootstrap has no installed package imports', () => {
  const sourceOnlyModules = [
    'scripts/affected-native-proof.mjs',
    'scripts/project-cut-family-queue-lease.mjs',
    'product/release/affected-native-artifact-lookup.mjs',
    'product/release/affected-native-proof-cli.mjs',
    'framework/spec/format/project-cut-canonical-json.mjs',
  ];
  for (const relativePath of sourceOnlyModules) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    const specifiers = [
      ...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/gu),
    ].map((match) => match[1]);
    assert.deepEqual(
      specifiers.filter(
        (specifier) =>
          !specifier.startsWith('node:') && !specifier.startsWith('.'),
      ),
      [],
      `${relativePath} must run before workspace dependencies are installed`,
    );
  }
});
