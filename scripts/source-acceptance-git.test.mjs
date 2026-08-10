// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { readSourceAcceptanceGit } from './source-acceptance.mjs';

test('source acceptance retains Git patches larger than the spawnSync default buffer', (t) => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-source-acceptance-large-git-output-'),
  );
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const gitRead = (args) => readSourceAcceptanceGit(args, { cwd: repository });
  gitRead(['init', '--quiet']);
  gitRead(['config', 'user.name', 'KFD Fixture']);
  gitRead(['config', 'user.email', 'kfd-fixture@kungfu.invalid']);
  fs.writeFileSync(path.join(repository, 'large.txt'), '0\n'.repeat(600_000));
  gitRead(['add', 'large.txt']);
  gitRead(['commit', '--quiet', '-m', 'large source patch']);
  const baseSha = gitRead(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repository, 'large.txt'), '1\n'.repeat(600_000));

  const patch = gitRead(['diff', '--binary', '--full-index', baseSha, '--']);
  assert.ok(patch.length > 1024 * 1024);
  assert.match(patch, /\+1/u);
});
