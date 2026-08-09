// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { DesktopUpdateState } from './update-controller';
import { createFileUpdateStateStore } from './update-state-store';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kungfu-update-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'desktop-update.json');
  return { stateFile, store: createFileUpdateStateStore(stateFile) };
}

function state(): DesktopUpdateState {
  return {
    schema: 'kungfu.desktop-update-state/v1',
    phase: 'downloaded',
    version: '4.0.0-alpha.1',
    manifest: null,
    plan: null,
    receipt: null,
    progressPercent: 100,
    reasonCode: 'workspace-idle',
    nextAction: 'Install after a fresh Core plan.',
    documentationUrl: 'https://www.kungfu.tech/docs/guides/upgrading',
    error: '',
    message: null,
    updatedAtMs: 123,
  };
}

test('saved desktop update state round-trips through the canonical file', (t) => {
  const { store } = fixture(t);
  const expected = state();

  store.save(expected);

  assert.deepEqual(store.load(), expected);
});

test('a truncated canonical state recovers as an explainable error', (t) => {
  const { stateFile, store } = fixture(t);
  writeFileSync(stateFile, '{', 'utf8');

  const loaded = store.load();

  assert.equal(loaded?.phase, 'error');
  assert.equal(loaded?.reasonCode, 'desktop-updater-error');
  assert.match(loaded?.error ?? '', /saved desktop update state/i);
  assert.equal(loaded?.message?.messageReasonCode, 'action-required');
  assert.match(loaded?.documentationUrl ?? '', /#troubleshooting$/);
  assert.equal(readFileSync(stateFile, 'utf8'), '{');
});

test('a schema-valid but incomplete state cannot regain update authority', (t) => {
  const { stateFile, store } = fixture(t);
  writeFileSync(
    stateFile,
    JSON.stringify({
      schema: 'kungfu.desktop-update-state/v1',
      phase: 'downloaded',
    }),
    'utf8',
  );

  const loaded = store.load();

  assert.equal(loaded?.phase, 'error');
  assert.equal(loaded?.manifest, null);
  assert.equal(loaded?.plan, null);
  assert.equal(loaded?.receipt, null);
});

test('an interrupted temporary write cannot replace canonical state', (t) => {
  const { stateFile, store } = fixture(t);
  const expected = state();
  store.save(expected);
  writeFileSync(`${stateFile}.${process.pid}.tmp`, '{', 'utf8');

  assert.deepEqual(store.load(), expected);
});
