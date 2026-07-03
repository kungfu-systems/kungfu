import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

// Where the `kungfu` command is installed. /usr/local/bin is on the default
// macOS PATH and is the conventional home for user-installed CLIs (the same
// spot VS Code uses for its `code` command).
const PATH_TARGET = '/usr/local/bin/kungfu';

export interface CliInstallResult {
  ok: boolean;
  message: string;
}

// Absolute path to the wrapper script shipped inside the app bundle
// (Resources/cli/kungfu); in development it lives in the gui package resources.
function wrapperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'cli', 'kungfu')
    : path.join(__dirname, '..', '..', 'resources', 'cli', 'kungfu');
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function isPermissionError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

// Run a shell command with a macOS administrator prompt (osascript). Used only
// when /usr/local/bin is not writable by the current user.
function elevate(script: string): void {
  execFileSync('osascript', [
    '-e',
    `do shell script "${script.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`,
  ]);
}

// Create /usr/local/bin/kungfu -> wrapper. Direct symlink first; on a
// permission error, retry once with an administrator prompt.
export function installKungfuCliToPath(): CliInstallResult {
  const wrapper = wrapperPath();
  if (!fs.existsSync(wrapper)) {
    return { ok: false, message: `wrapper not found: ${wrapper}` };
  }
  try {
    fs.rmSync(PATH_TARGET, { force: true });
    fs.symlinkSync(wrapper, PATH_TARGET);
    return { ok: true, message: `Installed: ${PATH_TARGET} -> ${wrapper}` };
  } catch (e) {
    if (isPermissionError(e)) {
      try {
        elevate(`mkdir -p ${shq(path.dirname(PATH_TARGET))} && ln -sf ${shq(wrapper)} ${shq(PATH_TARGET)}`);
        return { ok: true, message: `Installed (elevated): ${PATH_TARGET} -> ${wrapper}` };
      } catch (e2) {
        return { ok: false, message: `elevated install failed: ${(e2 as Error).message}` };
      }
    }
    return { ok: false, message: `install failed: ${(e as Error).message}` };
  }
}

// Remove /usr/local/bin/kungfu. Absent is treated as success.
export function uninstallKungfuCliFromPath(): CliInstallResult {
  if (!fs.lstatSync(PATH_TARGET, { throwIfNoEntry: false })) {
    return { ok: true, message: `Not installed: ${PATH_TARGET}` };
  }
  try {
    fs.rmSync(PATH_TARGET, { force: true });
    return { ok: true, message: `Removed ${PATH_TARGET}` };
  } catch (e) {
    if (isPermissionError(e)) {
      try {
        elevate(`rm -f ${shq(PATH_TARGET)}`);
        return { ok: true, message: `Removed (elevated) ${PATH_TARGET}` };
      } catch (e2) {
        return { ok: false, message: `elevated uninstall failed: ${(e2 as Error).message}` };
      }
    }
    return { ok: false, message: `uninstall failed: ${(e as Error).message}` };
  }
}

// Whether the command is currently installed and points at this app's wrapper.
export function isKungfuCliInstalled(): boolean {
  try {
    return fs.realpathSync(PATH_TARGET) === fs.realpathSync(wrapperPath());
  } catch {
    return false;
  }
}
