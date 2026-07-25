// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectNpmRegistryIssues } from './check-npm-package-registry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(
  fs.readFileSync(
    path.join(root, 'framework/release/npm-package-registry.json'),
    'utf8',
  ),
);

test('accepts the exact 28-package Release inventory', () => {
  assert.deepEqual(collectNpmRegistryIssues({ root, registry: source }), []);
});

test('rejects package-count and rollback drift', () => {
  const registry = structuredClone(source);
  registry.packages.pop();
  registry.rollback.unpublishAllowed = true;
  const codes = collectNpmRegistryIssues({ root, registry }).map(
    (entry) => entry.code,
  );
  assert.ok(codes.includes('count'));
  assert.ok(codes.includes('rollback'));
});
