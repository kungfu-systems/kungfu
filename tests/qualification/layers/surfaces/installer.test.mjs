// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyMacApplication, findOne, installerKind } from './installer.mjs';

test('recognizes every supported desktop installer family', () => {
  assert.equal(installerKind('Kungfu.dmg'), 'dmg');
  assert.equal(installerKind('Kungfu.AppImage'), 'appimage');
  assert.equal(installerKind('Kungfu Setup.exe'), 'nsis');
  assert.throws(() => installerKind('Kungfu.zip'), /unsupported/);
});

test('DMG discovery stops below the matched application bundle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-installer-find-'));
  try {
    const app = path.join(root, 'Kungfu Episodes.app');
    fs.mkdirSync(
      path.join(app, 'Contents', 'Frameworks', 'Kungfu Episodes Helper.app'),
      { recursive: true },
    );
    assert.equal(
      findOne(
        root,
        (target, entry) => entry.isDirectory() && target.endsWith('.app'),
        'DMG application',
      ),
      app,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'macOS application copy preserves framework symlink targets',
  { skip: process.platform !== 'darwin' },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-ditto-copy-'));
    try {
      const source = path.join(root, 'source', 'Kungfu Episodes.app');
      const framework = path.join(
        source,
        'Contents',
        'Frameworks',
        'Electron Framework.framework',
      );
      fs.mkdirSync(path.join(framework, 'Versions', 'A'), { recursive: true });
      fs.writeFileSync(
        path.join(framework, 'Versions', 'A', 'Electron Framework'),
        'fixture',
      );
      fs.symlinkSync('A', path.join(framework, 'Versions', 'Current'));
      fs.symlinkSync(
        'Versions/Current/Electron Framework',
        path.join(framework, 'Electron Framework'),
      );
      const destination = path.join(root, 'installed', 'Kungfu Episodes.app');
      copyMacApplication(source, destination);
      assert.equal(
        fs.readFileSync(
          path.join(
            destination,
            'Contents',
            'Frameworks',
            'Electron Framework.framework',
            'Electron Framework',
          ),
          'utf8',
        ),
        'fixture',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
