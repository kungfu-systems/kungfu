// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { stageProductTrunkEntrypoints } from './dist.mjs';

test('product trunk staging refreshes both Windows runtime entry aliases', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-trunk-stage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'rebuilt-kungfu-trunk.exe');
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(runtime);
  fs.writeFileSync(source, 'rebuilt Windows Rust trunk');
  fs.writeFileSync(path.join(runtime, 'kungfu.exe'), 'stale first build');

  stageProductTrunkEntrypoints(source, runtime, 'win32');

  assert.deepEqual(
    fs.readFileSync(path.join(runtime, 'kungfu.exe')),
    fs.readFileSync(source),
  );
  assert.deepEqual(
    fs.readFileSync(path.join(runtime, 'kungfu-trunk.exe')),
    fs.readFileSync(source),
  );
});
