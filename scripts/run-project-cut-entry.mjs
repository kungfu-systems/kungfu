#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(
  ROOT,
  'framework',
  'project-cut',
  'bin',
  'project-cut.mjs',
);
const [task, ...args] = process.argv.slice(2);

if (task !== 'project-cut') {
  process.stderr.write(
    'run-project-cut-entry: first argument must be project-cut\n',
  );
  process.exit(2);
}

process.argv = [process.execPath, CLI, ...args];
await import(pathToFileURL(CLI).href);
