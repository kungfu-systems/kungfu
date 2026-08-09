import { lstatSync, mkdirSync } from 'node:fs';

export function ensurePrivateRuntimeDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Agent Session runtime path '${directory}' is not a real directory`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(
      `Agent Session runtime path '${directory}' is not owned by this user`,
    );
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(
      `Agent Session runtime path '${directory}' must not be group/world accessible`,
    );
  }
}
