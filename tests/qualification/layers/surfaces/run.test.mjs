// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { guiQualificationArgs } from './installer.mjs';
import {
  findArtifact,
  surfaceQualificationTempPrefix,
  surfaceQualificationTempRoot,
} from './run.mjs';

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

test('Windows installer qualification uses the preserved short host temp', () => {
  assert.equal(
    surfaceQualificationTempRoot(
      'win32',
      { KUNGFU_QUALIFICATION_HOST_TEMP: 'D:\\a\\_temp' },
      'D:\\a\\kungfu\\kungfu\\.buildchain\\tmp',
    ),
    'D:\\a\\_temp',
  );
  assert.equal(
    surfaceQualificationTempRoot(
      'win32',
      { KUNGFU_QUALIFICATION_HOST_TEMP: '  ' },
      'D:\\fallback',
    ),
    'D:\\fallback',
  );
  assert.equal(
    surfaceQualificationTempRoot(
      'linux',
      { KUNGFU_QUALIFICATION_HOST_TEMP: '/runner/temp' },
      '/repo/.buildchain/tmp',
    ),
    '/repo/.buildchain/tmp',
  );
});

test('Windows installer qualification stays below the legacy path budget', () => {
  const repositoryRoot = path.resolve(here, '..', '..', '..', '..');
  const packageSources = [
    {
      root: path.join(
        repositoryRoot,
        'framework',
        'core',
        'src',
        'python',
        'kungfu',
      ),
      installedPrefix: [],
    },
    {
      root: path.join(repositoryRoot, 'extensions', 'work-dashboard'),
      installedPrefix: [
        'profiles',
        'work-control',
        'members',
        'work-dashboard',
      ],
    },
    {
      root: path.join(
        repositoryRoot,
        'extensions',
        'work-control',
        'work-control-actions',
      ),
      installedPrefix: ['profiles', 'work-control', 'work-control-actions'],
    },
  ];
  const files = [];
  const visit = (directory, installedPrefix, relativeDirectory = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory())
        visit(path.join(directory, entry.name), installedPrefix, relative);
      else if (entry.isFile())
        files.push(path.join(...installedPrefix, relative));
    }
  };
  for (const source of packageSources)
    visit(source.root, source.installedPrefix);
  const runnerTemp = 'C:\\actions-runner\\kungfu-systems\\_work\\_temp';
  const workspace = `${surfaceQualificationTempPrefix(runnerTemp)}xxxxxx`;
  const legacyWorkspace = path.win32.join(
    runnerTemp,
    'kungfu-surface-qualification-xxxxxx',
    'desktop-installation',
  );
  const installedLength = (root, relative) =>
    path.win32.join(
      root,
      'installed-desktop',
      'resources',
      'kungfu',
      'python',
      'Lib',
      'site-packages',
      'kungfu',
      ...relative.split(path.sep),
    ).length;
  const longest = Math.max(
    ...files.map((relative) => installedLength(workspace, relative)),
  );
  const legacyLongest = Math.max(
    ...files.map((relative) => installedLength(legacyWorkspace, relative)),
  );
  assert.ok(
    legacyLongest >= 260,
    `fixture no longer covers the legacy path overflow (${legacyLongest})`,
  );
  assert.ok(longest < 260, `longest installed Python path is ${longest}`);
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

test('installed Windows tree traversal waits for packaged runtime children', () => {
  const source = fs.readFileSync(runner, 'utf8');
  const wait = source.indexOf(
    'await waitForWindowsProcessesUnderRootExit(desktopInstall.installRoot)',
  );
  const measure = source.indexOf('directoryBytes(desktopInstall.installRoot)');
  assert.ok(wait >= 0, 'Windows process settlement is missing');
  assert.ok(measure > wait, 'installed tree is traversed before settlement');
});
