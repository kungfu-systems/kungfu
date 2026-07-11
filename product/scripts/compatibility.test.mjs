// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sha256Tree } from './compatibility.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

test('compatibility native contract input exists', () => {
  assert.equal(
    fs.existsSync(
      path.join(
        repoRoot,
        'framework/core/src/libkungfu/include/kungfu/native_storage.h',
      ),
    ),
    true,
  );
});

test('compatibility tree hash is path-stable and content-sensitive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-compatibility-'));
  try {
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', 'b.txt'), 'b\n');
    fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
    const first = sha256Tree(root);
    const second = sha256Tree(root);
    assert.equal(first, second);
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
    assert.notEqual(sha256Tree(root), first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
