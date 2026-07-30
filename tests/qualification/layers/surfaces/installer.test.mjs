// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  copyMacApplication,
  findOne,
  installerKind,
  nsisUninstallArgs,
  pathRemovalDiagnostics,
  waitForPathRemoval,
} from './installer.mjs';

test('recognizes every supported desktop installer family', () => {
  assert.equal(installerKind('Kungfu.dmg'), 'dmg');
  assert.equal(installerKind('Kungfu.AppImage'), 'appimage');
  assert.equal(installerKind('Kungfu Setup.exe'), 'nsis');
  assert.throws(() => installerKind('Kungfu.zip'), /unsupported/);
});

test('NSIS uninstall keeps the standard temporary-copy behavior', () => {
  assert.deepEqual(nsisUninstallArgs(), ['/S']);
  assert.equal(
    nsisUninstallArgs().some((arg) => arg.startsWith('_?=')),
    false,
  );
});

test('waits for a detached NSIS uninstaller to remove its install root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-uninstall-wait-'));
  setTimeout(() => fs.rmSync(root, { recursive: true, force: true }), 20);
  await waitForPathRemoval(root, { timeoutMs: 500, pollIntervalMs: 5 });
  assert.equal(fs.existsSync(root), false);
});

test('reports bounded removal diagnostics instead of hiding an uninstall lock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-uninstall-lock-'));
  fs.writeFileSync(path.join(root, 'locked.exe'), 'fixture');
  try {
    await assert.rejects(
      waitForPathRemoval(root, {
        timeoutMs: 10,
        pollIntervalMs: 1,
        diagnostics: (target) =>
          pathRemovalDiagnostics(target, { platform: 'linux' }),
      }),
      /diagnostics=.*file:locked\.exe/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('one-shot GUI qualification cannot start the durable Agent Session host', () => {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..',
  );
  const mainSource = fs.readFileSync(
    path.join(root, 'framework/gui/src/main/index.ts'),
    'utf8',
  );
  const rendererSource = fs.readFileSync(
    path.join(root, 'framework/gui/src/renderer/src/runtime.ts'),
    'utf8',
  );
  assert.match(
    mainSource,
    /if \(!qualificationMode\) \{[\s\S]*createMainAgentSessionHost/u,
  );
  assert.match(
    rendererSource,
    /env\.KF_QUALIFICATION_MODE === '1'[\s\S]*\? null[\s\S]*createAgentSessionProxy/u,
  );
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
