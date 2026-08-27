// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkWorkspaceContinuationContract } from './workspace-continuation-contract.mjs';

const SOURCE_ROOT = path.resolve(import.meta.dirname, '..');
const FILES = [
  'framework/episode-provider/workspace-continuation.contract.json',
  'framework/core/src/python/kungfu/workspace.py',
  'framework/core/src/python/kungfu/_workspace/continuation.py',
  'framework/gui/src/main/workspace-selection.ts',
  'framework/core/src/python/kungfu/agent/kfd3_api.registry.json',
  'framework/core/src/python/kungfu/agent/commands.json',
];

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-workspace-continuation-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of FILES) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(SOURCE_ROOT, relative), target);
  }
  return root;
}

test('workspace continuation contract and public projections stay aligned', () => {
  const result = checkWorkspaceContinuationContract();
  assert.equal(result.states, 4);
  assert.equal(result.actions, 5);
  assert.match(result.contractRoot, /^sha256:[0-9a-f]{64}$/u);
});

test('missing explicit continuation action fails closed', (t) => {
  const root = fixture(t);
  const file = path.join(
    root,
    'framework/episode-provider/workspace-continuation.contract.json',
  );
  const contract = JSON.parse(fs.readFileSync(file, 'utf8'));
  contract.actions = contract.actions.filter(
    (action) => action.id !== 'start-continuation',
  );
  fs.writeFileSync(file, `${JSON.stringify(contract, null, 2)}\n`);
  assert.throws(
    () => checkWorkspaceContinuationContract(root),
    /action vocabulary drifted/,
  );
});

test('missing continuation implementation state fails closed', (t) => {
  const root = fixture(t);
  const file = path.join(
    root,
    'framework/core/src/python/kungfu/_workspace/continuation.py',
  );
  const source = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(
    file,
    source.replaceAll('"shadow-only"', '"shadow-missing"'),
  );
  assert.throws(
    () => checkWorkspaceContinuationContract(root),
    /state is not projected: shadow-only/,
  );
});
