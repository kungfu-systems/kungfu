// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runInstalledEmbeddedNodeAddonSmoke } from './index.mjs';

function fixture(t) {
  const installRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-node-pty-runtime-'),
  );
  t.after(() => fs.rmSync(installRoot, { recursive: true, force: true }));
  const nodePtyEntry = path.join(
    installRoot,
    'tui/node_modules/node-pty/lib/index.js',
  );
  fs.mkdirSync(path.dirname(nodePtyEntry), { recursive: true });
  fs.writeFileSync(nodePtyEntry, 'module.exports = {};\n');
  return {
    installRoot,
    nodePtyEntry,
    runtimeEntry: path.join(installRoot, 'runtime', 'kungfu'),
  };
}

test('installed embedded Node loads the staged node-pty native addon', (t) => {
  const { installRoot, nodePtyEntry, runtimeEntry } = fixture(t);
  let invocation;

  runInstalledEmbeddedNodeAddonSmoke(
    { installRoot, runtimeEntry, env: { QUALIFICATION: 'true' } },
    {
      spawn(command, args, options) {
        invocation = { command, args, options };
        return {
          status: 0,
          signal: null,
          stdout: 'KUNGFU_NODE_PTY_READY\n',
          stderr: '',
        };
      },
    },
  );

  assert.equal(invocation.command, runtimeEntry);
  assert.equal(invocation.options.env.KUNGFU_AS_VARIANT, 'node');
  assert.equal(invocation.options.env.KUNGFU_NODE_PTY_ENTRY, nodePtyEntry);
  assert.match(invocation.args[1], /typeof nodePty\.spawn/u);
});

test('installed embedded Node node-pty smoke fails closed', (t) => {
  const { installRoot, runtimeEntry } = fixture(t);

  assert.throws(
    () =>
      runInstalledEmbeddedNodeAddonSmoke(
        { installRoot, runtimeEntry, env: {} },
        {
          spawn() {
            return {
              status: 127,
              signal: null,
              stdout: '',
              stderr: 'undefined symbol: napi_create_function',
            };
          },
        },
      ),
    /could not load node-pty[\s\S]*napi_create_function/u,
  );
});
