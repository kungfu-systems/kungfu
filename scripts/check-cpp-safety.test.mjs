#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  digest,
  inventoryBoundarySites,
  parseDiagnostics,
  selectTranslationUnits,
  summarizeDiagnostics,
} from './check-cpp-safety.mjs';

const policy = {
  scopeRoots: [
    'framework/core/src/libkungfu/src/runtime/storage/',
    'framework/core/src/bindings/node/binding/',
  ],
};

test('selects only declared first-party C++ translation units', () => {
  const database = [
    { file: 'framework/core/src/libkungfu/src/runtime/storage/service.cpp' },
    { file: 'framework/core/src/bindings/node/binding/watcher.cpp' },
    { file: 'framework/core/src/libkungfu/tests/service.cpp' },
    { file: 'framework/core/.deps/vendor.cpp' },
    { file: 'framework/core/src/libkungfu/src/runtime/storage/readme.md' },
  ];
  assert.deepEqual(selectTranslationUnits(database, policy), [
    'framework/core/src/bindings/node/binding/watcher.cpp',
    'framework/core/src/libkungfu/src/runtime/storage/service.cpp',
  ]);
});

test('normalizes and roots clang-tidy diagnostics without notes or summaries', () => {
  const output = [
    '/repo/service.cpp:9:3: warning: suspicious size [bugprone-sizeof-expression]',
    '/repo/service.cpp:9:3: note: expanded from macro',
    '42 warnings generated.',
  ].join('\n');
  const diagnostics = parseDiagnostics(output);
  assert.deepEqual(diagnostics, [
    {
      path: '/repo/service.cpp',
      line: 9,
      column: 3,
      severity: 'warning',
      message: 'suspicious size',
      check: 'bugprone-sizeof-expression',
    },
  ]);
  assert.deepEqual(summarizeDiagnostics(diagnostics), {
    'bugprone-sizeof-expression': 1,
  });
  assert.match(digest(diagnostics), /^sha256:[0-9a-f]{64}$/u);
});

test('the checked-in boundary inventory classifies every manual lifetime and reinterpret cast site', () => {
  const policy = JSON.parse(
    fs.readFileSync(
      new URL(
        '../developer/maintainability/cpp-safety-policy.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const inventory = inventoryBoundarySites(policy);
  assert.ok(inventory.sites.length > 0);
  assert.deepEqual(inventory.unclassified, []);
  assert.match(inventory.root, /^sha256:[0-9a-f]{64}$/u);
});
