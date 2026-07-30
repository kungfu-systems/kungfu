// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkEpisodeAdmissionContract } from './episode-admission-contract.mjs';

const SOURCE_ROOT = path.resolve(import.meta.dirname, '..');
const FILES = [
  'framework/episode-admission/episode-admission.contract.json',
  'framework/core/src/libkungfu/src/runtime/storage/episode_admission.cpp',
  'framework/core/src/python/kungfu/storage/service.py',
  'framework/api/src/capability/storage.ts',
  'framework/core/src/python/kungfu/cli/commands/workspace.py',
  'framework/core/src/python/kungfu/agent/kfd3_api.registry.json',
  'framework/core/src/python/kungfu/agent/commands.json',
];

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-episode-admission-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of FILES) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(SOURCE_ROOT, relative), target);
  }
  return root;
}

test('Episode Admission contract and public projections stay aligned', () => {
  const result = checkEpisodeAdmissionContract();
  assert.equal(result.actions, 7);
  assert.equal(result.transports, 3);
  assert.equal(result.states, 9);
  assert.match(result.contractRoot, /^sha256:[0-9a-f]{64}$/u);
});

test('removing destination authority fails closed', (t) => {
  const root = fixture(t);
  const file = path.join(
    root,
    'framework/episode-admission/episode-admission.contract.json',
  );
  const contract = JSON.parse(fs.readFileSync(file, 'utf8'));
  contract.mutationBoundary.destinationDecides = false;
  fs.writeFileSync(file, `${JSON.stringify(contract, null, 2)}\n`);
  assert.throws(
    () => checkEpisodeAdmissionContract(root),
    /authority boundary drifted/,
  );
});

test('widening the simulated remote adapter fails closed', (t) => {
  const root = fixture(t);
  const file = path.join(
    root,
    'framework/episode-admission/episode-admission.contract.json',
  );
  const contract = JSON.parse(fs.readFileSync(file, 'utf8'));
  contract.remoteBoundary.encryptionRequired = false;
  fs.writeFileSync(file, `${JSON.stringify(contract, null, 2)}\n`);
  assert.throws(
    () => checkEpisodeAdmissionContract(root),
    /remote safety boundary drifted/,
  );
});
