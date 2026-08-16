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
  installNsisArtifact,
  installerKind,
  nsisUninstallArgs,
  pathRemovalDiagnostics,
  removeEmptyDirectoryShells,
  waitForPathRemoval,
  waitForWindowsProcessesUnderRootExit,
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

test('NSIS install retries one empty timeout and retains the exact target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-nsis-retry-'));
  const installRoot = path.join(root, 'installed');
  const calls = [];
  try {
    installNsisArtifact('Kungfu Setup.exe', installRoot, {
      timeoutMs: 42,
      runCommand(command, args, options) {
        calls.push({ command, args, options });
        fs.mkdirSync(installRoot, { recursive: true });
        if (calls.length === 1) {
          const error = new Error('timed out');
          error.code = 'ETIMEDOUT';
          throw error;
        }
        fs.writeFileSync(path.join(installRoot, 'Kungfu Episodes.exe'), 'ok');
      },
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], {
      command: 'Kungfu Setup.exe',
      args: ['/S', `/D=${installRoot}`],
      options: { timeout: 42 },
    });
    assert.equal(
      fs.readFileSync(path.join(installRoot, 'Kungfu Episodes.exe'), 'utf8'),
      'ok',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('NSIS install never retries a partial timed-out installation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-nsis-partial-'));
  const installRoot = path.join(root, 'installed');
  let calls = 0;
  try {
    assert.throws(
      () =>
        installNsisArtifact('Kungfu Setup.exe', installRoot, {
          timeoutMs: 42,
          runCommand() {
            calls += 1;
            fs.mkdirSync(installRoot, { recursive: true });
            fs.writeFileSync(path.join(installRoot, 'partial.bin'), 'partial');
            const error = new Error('timed out');
            error.code = 'ETIMEDOUT';
            throw error;
          },
        }),
      /timed out after partially installing.*refusing to retry/,
    );
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(path.join(installRoot, 'partial.bin')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('waits for packaged Windows runtime children before starting NSIS', async () => {
  const observations = [
    [
      {
        ProcessId: 42,
        Name: 'kungfu.exe',
        ExecutablePath: 'C:\\installed\\resources\\kungfu\\kungfu.exe',
      },
    ],
    [],
  ];
  let calls = 0;
  await waitForWindowsProcessesUnderRootExit('C:\\installed', {
    platform: 'win32',
    pollIntervalMs: 1,
    processesUnderRoot() {
      calls += 1;
      return observations.shift();
    },
  });
  assert.equal(calls, 2);
});

test('fails closed when an installed Windows process does not exit', async () => {
  await assert.rejects(
    waitForWindowsProcessesUnderRootExit('C:\\installed', {
      platform: 'win32',
      timeoutMs: 5,
      pollIntervalMs: 1,
      processesUnderRoot: () => [
        {
          ProcessId: 42,
          Name: 'kungfu.exe',
          ExecutablePath: 'C:\\installed\\resources\\kungfu\\kungfu.exe',
        },
      ],
    }),
    /timed out waiting for installed Windows processes.*kungfu\.exe/,
  );
});

test('waits for a detached NSIS uninstaller to remove its install root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-uninstall-wait-'));
  setTimeout(() => fs.rmSync(root, { recursive: true, force: true }), 20);
  await waitForPathRemoval(root, { timeoutMs: 500, pollIntervalMs: 5 });
  assert.equal(fs.existsSync(root), false);
});

test('removes only empty directory shells left by NSIS', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-uninstall-empty-'),
  );
  fs.mkdirSync(path.join(root, 'resources', 'app'), { recursive: true });
  await waitForPathRemoval(root, { timeoutMs: 50, pollIntervalMs: 1 });
  assert.equal(fs.existsSync(root), false);
});

test('tolerates NSIS removing a child during empty-shell traversal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-uninstall-race-'));
  const vanishing = path.join(
    root,
    'resources',
    'app',
    'node_modules',
    'node-pty',
  );
  const retained = path.join(root, 'retained.exe');
  fs.mkdirSync(vanishing, { recursive: true });
  fs.writeFileSync(retained, 'fixture');
  let raced = false;
  const filesystem = {
    existsSync: fs.existsSync,
    lstatSync(target) {
      if (!raced && target === vanishing) {
        raced = true;
        fs.rmSync(vanishing, { recursive: true, force: true });
      }
      return fs.lstatSync(target);
    },
    readdirSync: fs.readdirSync,
    rmdirSync: fs.rmdirSync,
  };
  try {
    assert.equal(removeEmptyDirectoryShells(root, filesystem), false);
    assert.equal(raced, true);
    assert.equal(fs.existsSync(retained), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not remove a file or link while cleaning empty directory shells', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-uninstall-file-'));
  const resource = path.join(root, 'resources', 'app');
  fs.mkdirSync(resource, { recursive: true });
  fs.writeFileSync(path.join(resource, 'package.json'), '{}');
  try {
    assert.equal(removeEmptyDirectoryShells(root), false);
    assert.equal(fs.existsSync(path.join(resource, 'package.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reports bounded removal diagnostics instead of hiding an uninstall lock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-uninstall-lock-'));
  const resource = path.join(root, 'resources');
  fs.mkdirSync(resource);
  fs.writeFileSync(path.join(resource, 'locked.exe'), 'fixture');
  try {
    await assert.rejects(
      waitForPathRemoval(root, {
        timeoutMs: 10,
        pollIntervalMs: 1,
        diagnostics: (target) =>
          pathRemovalDiagnostics(target, { platform: 'linux' }),
      }),
      /diagnostics=.*dir:resources.*file:resources[/\\]+locked\.exe/,
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
