#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath, pathToFileURL } from 'node:url';

const CLI = fileURLToPath(
  import.meta.resolve('@kungfu-tech/work/project-cut/cli'),
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
