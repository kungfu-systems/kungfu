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
    timeout: options.timeout,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const error = new Error(
      `${command} ${args.join(' ')} failed (status=${result.status}):\n${result.stderr || result.error?.message || ''}`,
    );
    error.code = result.error?.code || 'ECHILD';
    throw error;
  }
  return result.stdout || '';
}

export const NSIS_INSTALL_TIMEOUT_MS = 300_000;

export function installNsisArtifact(
  installer,
  installRoot,
  {
    runCommand = run,
    filesystem = fs,
    timeoutMs = NSIS_INSTALL_TIMEOUT_MS,
  } = {},
) {
  const args = ['/S', `/D=${installRoot}`];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      runCommand(installer, args, { timeout: timeoutMs });
      return;
    } catch (error) {
      if (error?.code !== 'ETIMEDOUT' || attempt === 2) throw error;
      const entries = filesystem.existsSync(installRoot)
        ? filesystem.readdirSync(installRoot)
        : [];
      if (entries.length !== 0)
        fail(
          `NSIS timed out after partially installing ${installRoot}; refusing to retry`,
        );
      if (filesystem.existsSync(installRoot)) filesystem.rmdirSync(installRoot);
    }
  }
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

export function nsisUninstallArgs() {
  // Keep the standard NSIS temporary-copy behavior. The _?= override runs the
  // uninstaller from $INSTDIR, where electron-builder's process check can
  // mistake the uninstaller itself for a packaged application process.
  return ['/S'];
}

export function windowsProcessesUnderRoot(target) {
  const script = [
    '$root = [IO.Path]::GetFullPath($env:KF_QUALIFICATION_INSTALL_ROOT)',
    '$matches = @(Get-CimInstance -ClassName Win32_Process | Where-Object {',
    '  $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)',
    '} | Select-Object ProcessId, Name, ExecutablePath)',
    '$matches | ConvertTo-Json -Compress',
  ].join('\n');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, KF_QUALIFICATION_INSTALL_ROOT: target },
    },
  );
  if (result.status !== 0)
    return [
      {
        diagnostic_error: (
          result.stderr ||
          result.error?.message ||
          'PowerShell failed'
        ).trim(),
      },
    ];
  try {
    const parsed = JSON.parse(result.stdout || '[]');
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch (error) {
    return [
      {
        diagnostic_error: `invalid PowerShell JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    ];
  }
}

export async function waitForWindowsProcessesUnderRootExit(
  target,
  {
    platform = process.platform,
    timeoutMs = 60_000,
    pollIntervalMs = 100,
    processesUnderRoot = windowsProcessesUnderRoot,
  } = {},
) {
  if (platform !== 'win32') return;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const processes = processesUnderRoot(target);
    if (processes.length === 0) return;
    if (Date.now() >= deadline)
      fail(
        `timed out waiting for installed Windows processes to exit under ${target}; processes=${JSON.stringify(
          processes,
        )}`,
      );
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export function pathRemovalDiagnostics(
  target,
  { platform = process.platform } = {},
) {
  const diagnostics = { remaining_entries: [], processes_under_root: [] };
  try {
    const remainingEntries = [];
    const visit = (dir, relativeDir = '') => {
      for (const entry of fs
        .readdirSync(dir, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))) {
        if (remainingEntries.length >= 48) return;
        const relative = path.join(relativeDir, entry.name);
        const kind = entry.isSymbolicLink()
          ? 'link'
          : entry.isDirectory()
            ? 'dir'
            : 'file';
        remainingEntries.push(`${kind}:${relative}`);
        if (entry.isDirectory() && !entry.isSymbolicLink())
          visit(path.join(dir, entry.name), relative);
      }
    };
    visit(target);
    diagnostics.remaining_entries = remainingEntries;
  } catch (error) {
    diagnostics.remaining_entries = [
      `unreadable:${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  if (platform !== 'win32') return diagnostics;
  diagnostics.processes_under_root = windowsProcessesUnderRoot(target);
  return diagnostics;
}

export function removeEmptyDirectoryShells(target, filesystem = fs) {
  let stat;
  try {
    stat = filesystem.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;

  let entries;
  try {
    entries = filesystem.readdirSync(target, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      !removeEmptyDirectoryShells(child, filesystem)
    )
      return false;
  }

  try {
    filesystem.rmdirSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    if (
      error?.code === 'EBUSY' ||
      error?.code === 'ENOTEMPTY' ||
      error?.code === 'EPERM'
    )
      return false;
    throw error;
  }
  return !filesystem.existsSync(target);
}

export async function waitForPathRemoval(
  target,
  {
    timeoutMs = 60_000,
    pollIntervalMs = 100,
    diagnostics = pathRemovalDiagnostics,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (fs.existsSync(target)) {
    // NSIS can finish after removing every installed file while leaving empty
    // directory shells behind. Qualification may remove only those shells:
    // any file, link, or locked directory keeps the uninstall fail-closed.
    if (removeEmptyDirectoryShells(target)) return;
    if (Date.now() >= deadline)
      fail(
        `timed out waiting for uninstall to remove ${target}; diagnostics=${JSON.stringify(
          diagnostics(target),
        )}`,
      );
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
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
    installNsisArtifact(installer, installRoot);
    if (!fs.existsSync(installRoot))
      fail('NSIS did not create the install root');
  }
  return {
    kind,
    installRoot,
    async uninstall() {
      if (kind === 'nsis') {
        const uninstaller = findOne(
          installRoot,
          (target, entry) =>
            entry.isFile() && /uninstall.*\.exe$/i.test(path.basename(target)),
          'NSIS uninstaller',
        );
        // A bounded GUI startup can leave a short-lived packaged runtime child
        // after Electron's main process exits. Starting NSIS before that child
        // releases its DLLs makes the one-shot uninstaller skip those files
        // permanently, even though no process remains by the final timeout.
        await waitForWindowsProcessesUnderRootExit(installRoot);
        run(uninstaller, nsisUninstallArgs());
        await waitForPathRemoval(installRoot);
        return;
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
