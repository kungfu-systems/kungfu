// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    fail(
      `${command} ${args.join(' ')} failed (status=${result.status}):\n${result.stderr || result.error?.message || ''}`,
    );
  return result.stdout || '';
}

export function findOne(root, predicate, label) {
  const matches = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (predicate(target, entry)) matches.push(target);
        else visit(target);
      } else if (entry.isFile() && predicate(target, entry))
        matches.push(target);
    }
  };
  visit(root);
  if (matches.length !== 1)
    fail(`${label}: expected one match under ${root}, found ${matches.length}`);
  return matches[0];
}

export function installerKind(file) {
  if (file.endsWith('.dmg')) return 'dmg';
  if (file.endsWith('.AppImage')) return 'appimage';
  if (file.endsWith('.exe')) return 'nsis';
  fail(`unsupported desktop installer: ${file}`);
}

export function copyMacApplication(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  run('ditto', [source, destination]);
}

export function installDesktopArtifact(installer, tempRoot) {
  const kind = installerKind(installer);
  const installRoot = path.join(tempRoot, 'installed-desktop');
  if (kind === 'dmg') {
    const mount = path.join(tempRoot, 'dmg-mount');
    fs.mkdirSync(mount, { recursive: true });
    run('hdiutil', [
      'attach',
      '-nobrowse',
      '-readonly',
      '-mountpoint',
      mount,
      installer,
    ]);
    try {
      const app = findOne(
        mount,
        (target, entry) => entry.isDirectory() && target.endsWith('.app'),
        'DMG application',
      );
      fs.mkdirSync(installRoot, { recursive: true });
      copyMacApplication(app, path.join(installRoot, path.basename(app)));
    } finally {
      run('hdiutil', ['detach', mount]);
    }
  } else if (kind === 'appimage') {
    fs.mkdirSync(installRoot, { recursive: true });
    run(installer, ['--appimage-extract'], { cwd: installRoot });
  } else {
    run(installer, ['/S', `/D=${installRoot}`]);
    if (!fs.existsSync(installRoot))
      fail('NSIS did not create the install root');
  }
  return {
    kind,
    installRoot,
    uninstall() {
      if (kind === 'nsis') {
        const uninstaller = findOne(
          installRoot,
          (target, entry) =>
            entry.isFile() && /uninstall.*\.exe$/i.test(path.basename(target)),
          'NSIS uninstaller',
        );
        run(uninstaller, ['/S', `_?=${installRoot}`]);
      }
      if (fs.existsSync(installRoot))
        fs.rmSync(installRoot, { recursive: true, force: true });
      if (fs.existsSync(installRoot))
        fail('desktop install root survived uninstall');
    },
  };
}

export function findGuiExecutable(installRoot) {
  if (process.platform === 'darwin')
    return findOne(
      installRoot,
      (target, entry) =>
        entry.isFile() &&
        path.basename(target) === 'Kungfu Episodes' &&
        target.includes(`${path.sep}Contents${path.sep}MacOS${path.sep}`),
      'macOS GUI executable',
    );
  if (process.platform === 'win32')
    return findOne(
      installRoot,
      (target, entry) =>
        entry.isFile() && path.basename(target) === 'Kungfu Episodes.exe',
      'Windows GUI executable',
    );
  return findOne(
    installRoot,
    (target, entry) =>
      entry.isFile() &&
      path.basename(target) === 'kungfu' &&
      path.basename(path.dirname(target)) === 'squashfs-root',
    'Linux GUI executable',
  );
}

export function guiQualificationArgs(platform = process.platform) {
  // Extracted AppImages cannot retain a root-owned mode-4755 chrome-sandbox in
  // an unprivileged clean environment. Qualification mode is bounded and does
  // not load user content, so use Electron's supported no-sandbox launch for
  // this installer smoke only. Linux qualification runners are also commonly
  // display-less; select Chromium's headless platform and disable the GPU
  // process so ANGLE does not fall back to the absent default X display. The
  // hidden BrowserWindow still loads before emitting the ready signal, so this
  // remains a real packaged-GUI startup assertion. Shipped user launches
  // remain unchanged.
  return platform === 'linux'
    ? ['--no-sandbox', '--ozone-platform=headless', '--disable-gpu']
    : [];
}
