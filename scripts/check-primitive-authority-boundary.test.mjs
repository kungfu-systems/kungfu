// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkPrimitiveAuthorityBoundary,
  primitiveAuthorityBoundaryIssues,
} from './check-primitive-authority-boundary.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOVERNED_PATHS = [
  'scripts/generate-primitive-catalog.mjs',
  'scripts/new-primitive.mjs',
  'framework/core/src/libkungfu/src/runtime/action/action_runtime.cpp',
  'framework/core/src/python/kungfu/cli/commands/primitive.py',
  'scripts/buildchain-kfd-evidence.mjs',
  'scripts/check-primitive-authority-boundary.mjs',
];

function governedEntries() {
  return GOVERNED_PATHS.map((pathname) => ({
    path: pathname,
    content: fs.readFileSync(path.join(ROOT, pathname), 'utf8'),
  }));
}

test('current Primitive authority producers and consumers form a closed set', () => {
  const result = checkPrimitiveAuthorityBoundary(ROOT);
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.governedSources.map((entry) => entry.role).sort(), [
    'authority-boundary-enforcer',
    'read-only-installed-contract-projection',
    'read-only-kfd5-candidate-reference',
    'read-only-native-projection',
    'sole-derived-projection-generator',
    'sole-passport-authoring-entrypoint',
  ]);
});

test('an undeclared runtime catalog reader fails closed', () => {
  const issues = primitiveAuthorityBoundaryIssues([
    ...governedEntries(),
    {
      path: 'framework/core/src/python/kungfu/parallel_primitive.py',
      content: 'load_contract("primitive-catalog")\n',
    },
  ]);
  assert.deepEqual(issues, [
    'undeclared-primitive-authority-source:framework/core/src/python/kungfu/parallel_primitive.py',
  ]);
});

test('an alternate passport reader or projection producer fails closed', () => {
  const issues = primitiveAuthorityBoundaryIssues([
    ...governedEntries(),
    {
      path: 'scripts/parallel-primitive-catalog.mjs',
      content:
        "const registry = 'framework/spec/incubation/incubation-passport.registry.json';\nconst declarations = registry.primitiveDeclarations;\n",
    },
  ]);
  assert.deepEqual(issues, [
    'undeclared-primitive-authority-source:scripts/parallel-primitive-catalog.mjs',
  ]);
});

test('a non-Primitive passport consumer remains outside this authority boundary', () => {
  const issues = primitiveAuthorityBoundaryIssues([
    ...governedEntries(),
    {
      path: 'scripts/run-native-work-journal-admission.mjs',
      content:
        "const registry = read('framework/spec/incubation/incubation-passport.registry.json');\nconst journal = registry.passports.find((entry) => entry.id === 'kungfu.work-journal');\n",
    },
  ]);
  assert.deepEqual(issues, []);
});

test('a Primitive-context passport consumer still fails closed', () => {
  const issues = primitiveAuthorityBoundaryIssues([
    ...governedEntries(),
    {
      path: 'scripts/parallel-passport-reader.mjs',
      content:
        "const registry = read('framework/spec/incubation/incubation-passport.registry.json');\nconst primitive = registry.passports.at(0);\n",
    },
  ]);
  assert.deepEqual(issues, [
    'undeclared-primitive-authority-source:scripts/parallel-passport-reader.mjs',
  ]);
});

test('a governed reader cannot reach through to the passport intake', () => {
  const entries = governedEntries();
  const cli = entries.find(
    (entry) =>
      entry.path ===
      'framework/core/src/python/kungfu/cli/commands/primitive.py',
  );
  cli.content += '\n# incubation-passport\n';
  assert.ok(
    primitiveAuthorityBoundaryIssues(entries).includes(
      'primitive-authority-bypass:framework/core/src/python/kungfu/cli/commands/primitive.py:read-only-installed-contract-projection',
    ),
  );
});

test('a governed reader cannot gain a catalog write path', () => {
  const entries = governedEntries();
  const native = entries.find(
    (entry) =>
      entry.path ===
      'framework/core/src/libkungfu/src/runtime/action/action_runtime.cpp',
  );
  native.content += '\nstd::ofstream parallel_catalog;\n';
  assert.ok(
    primitiveAuthorityBoundaryIssues(entries).includes(
      'primitive-authority-bypass:framework/core/src/libkungfu/src/runtime/action/action_runtime.cpp:read-only-native-projection',
    ),
  );
});
