#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const RETIREMENT_MESSAGE =
  'update-auditable-demo-readme.mjs is retired; use Buildchain declarative demo materialization';

export function main() {
  throw new Error(RETIREMENT_MESSAGE);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
