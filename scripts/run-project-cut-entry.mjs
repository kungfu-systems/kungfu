#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath, pathToFileURL } from 'node:url';

const [task, ...args] = process.argv.slice(2);

if (
  task !== 'project-cut' &&
  !/^@[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*$/u.test(task || '')
) {
  process.stderr.write(
    'run-project-cut-entry: first argument must be project-cut or a public package entry\n',
  );
  process.exit(2);
}

const CLI = fileURLToPath(
  import.meta.resolve(
    task === 'project-cut' ? '@kungfu-tech/work/project-cut/cli' : task,
  ),
);

process.argv = [process.execPath, CLI, ...args];
await import(pathToFileURL(CLI).href);
