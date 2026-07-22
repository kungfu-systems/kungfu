// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCodexAppServerSchemaManifest } from '../../../scripts/generate-codex-app-server-schema-manifest.mjs';
import {
  loadCodexAppServerContract,
  loadCodexAppServerSchemaManifest,
} from '../src/codex-app-server-contract.mjs';

test('installed Codex regenerates the exact credential-free stable schema bundle', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-codex-schema-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const schemaDir = path.join(root, 'schema');
  const codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(codexHome);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    CODEX_HOME: codexHome,
    LANG: 'C',
    LC_ALL: 'C',
  };
  const executable = process.env.KUNGFU_CODEX_BIN ?? 'codex';
  const version = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    env,
    shell: false,
    timeout: 10_000,
  });
  if (version.error?.code === 'ENOENT') {
    t.skip('Codex CLI is not installed');
    return;
  }
  assert.equal(version.status, 0, version.stderr);
  const cliVersion = version.stdout.match(/([0-9]+\.[0-9]+\.[0-9]+)/u)?.[1];
  assert.equal(cliVersion, '0.144.3');

  const generated = spawnSync(
    executable,
    ['app-server', 'generate-json-schema', '--out', schemaDir],
    { encoding: 'utf8', env, shell: false, timeout: 30_000 },
  );
  assert.equal(generated.status, 0, generated.stderr);

  const actual = buildCodexAppServerSchemaManifest({ schemaDir, cliVersion });
  const contract = loadCodexAppServerContract();
  const expected = loadCodexAppServerSchemaManifest(contract);
  assert.deepEqual(actual, expected);
});
