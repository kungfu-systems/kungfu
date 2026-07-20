// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  XINFA_ROOT,
  scanCargoManifest,
  scanHostManifest,
  scanSourceFiles,
  validateBoundary,
} from './check-boundary.mjs';

test('current Xinfa source satisfies the linked component boundary', () => {
  assert.deepEqual(validateBoundary(), []);
});
test('trunk dependency direction is exact and one-way', () => {
  const boundary = {
    hostIntegration: {
      hostDependency: 'xinfa = { path = "../../xinfa" }',
    },
  };
  assert.deepEqual(
    scanHostManifest(
      '[dependencies]\nshifu-core = { path = "../shifu-core" }\n',
      boundary,
    ),
    [
      'kungfu-trunk Cargo.toml: expected one-way dependency xinfa = { path = "../../xinfa" }',
    ],
  );
});
test('non-registry and non-allowlisted dependencies are rejected', () => {
  const boundary = {
    core: {
      allowedDependencies: ['serde_json'],
    },
  };
  assert.deepEqual(
    scanCargoManifest(
      '[dependencies]\nserde_json = { path = "../private" }\nkungfu = "1"\n',
      boundary,
    ),
    [
      'Cargo.toml: dependency serde_json must use the public registry',
      'Cargo.toml: dependency kungfu is not allowlisted',
    ],
  );
});
test('private host-product imports are rejected', () => {
  const boundary = {
    core: {
      forbiddenRustNamespaces: ['shifu', 'kungfu', 'libkungfu'],
      forbiddenPackagePrefixes: ['@kungfu-tech/'],
      forbiddenRelativeRoots: ['../crates', '../framework'],
    },
  };
  const fixture = path.join(
    XINFA_ROOT,
    'tooling',
    'fixtures',
    'private-runtime-import.rs',
  );
  assert.deepEqual(scanSourceFiles([fixture], boundary), [
    'tooling/fixtures/private-runtime-import.rs: forbidden Rust namespace shifu',
    'tooling/fixtures/private-runtime-import.rs: forbidden Rust namespace kungfu',
    'tooling/fixtures/private-runtime-import.rs: forbidden monorepo-relative root ../framework',
  ]);
});
