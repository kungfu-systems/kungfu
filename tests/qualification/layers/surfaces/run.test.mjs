// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { guiQualificationArgs } from './installer.mjs';
import { findArtifact } from './run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, 'run.mjs');

test('surface qualification source contract validates without artifacts', () => {
  const result = spawnSync(process.execPath, [runner, '--validate-only'], {
    cwd: path.resolve(here, '..', '..', '..', '..'),
    env: { ...process.env, SHIFU_ENTRYPOINT: '1' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /source-valid/);
  assert.match(result.stdout, /does not qualify installed artifacts/);
});

test('desktop discovery treats a matched app bundle as one artifact root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-surface-find-'));
  try {
    const app = path.join(root, 'Kungfu Episodes.app');
    fs.mkdirSync(
      path.join(app, 'Contents', 'Frameworks', 'Kungfu Episodes Helper.app'),
      { recursive: true },
    );
    assert.equal(
      findArtifact(
        root,
        (target, entry) => entry.isDirectory() && target.endsWith('.app'),
        'desktop directory',
      ),
      app,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Linux clean-install GUI smoke uses the bounded Electron sandbox escape', () => {
  assert.deepEqual(guiQualificationArgs('linux'), [
    '--no-sandbox',
    '--ozone-platform=headless',
    '--disable-gpu',
  ]);
  assert.deepEqual(guiQualificationArgs('darwin'), []);
  assert.deepEqual(guiQualificationArgs('win32'), []);
});

test('bounded GUI qualification avoids display-backed menus and embedded views', () => {
  const mainSource = fs.readFileSync(
    path.resolve(
      here,
      '..',
      '..',
      '..',
      '..',
      'framework',
      'gui',
      'src',
      'main',
      'index.ts',
    ),
    'utf8',
  );
  assert.match(mainSource, /if \(!qualificationMode\) buildMenu\(\);/);
  assert.match(
    mainSource,
    /if \(!qualificationMode\) \{\s*manager = new SandboxManager\(/,
  );
  assert.match(mainSource, /offscreen: qualificationMode/);
});
