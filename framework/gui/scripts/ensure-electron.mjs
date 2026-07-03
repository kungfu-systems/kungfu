// SPDX-License-Identifier: Apache-2.0
//
// Make the Electron binary a precondition the verbs enforce, not an install
// side effect the developer has to remember. pnpm's build-script scheduling
// has been observed to skip electron's postinstall on fresh worktrees (the
// package lands without dist/); rather than depending on that machinery, every
// launch/package verb runs this first: present -> no-op in milliseconds,
// missing -> run electron's own install script in place (ELECTRON_MIRROR and
// friends come from the environment kungfu-code already loads).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const guiDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const electronDir = path.join(guiDir, 'node_modules', 'electron');
const pathTxt = path.join(electronDir, 'path.txt');

if (!fs.existsSync(electronDir)) {
  process.stderr.write('[gui] electron package missing — run install first\n');
  process.exit(1);
}

const binaryPresent = () => {
  if (!fs.existsSync(pathTxt)) return false;
  const relative = fs.readFileSync(pathTxt, 'utf8').trim();
  return fs.existsSync(path.join(electronDir, 'dist', ...relative.split('/')));
};

if (!binaryPresent()) {
  process.stderr.write('[gui] electron binary missing — fetching once\n');
  execFileSync(process.execPath, ['install.js'], {
    cwd: electronDir,
    stdio: 'inherit',
  });
  if (!binaryPresent()) {
    process.stderr.write('[gui] electron install did not produce the binary\n');
    process.exit(1);
  }
}
