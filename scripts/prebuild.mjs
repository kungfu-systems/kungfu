// SPDX-License-Identifier: Apache-2.0
//
// prebuild lifecycle step: before a local (non-CI) build, sync the toolchain and
// format the tree. framework/core is a CommonJS package, so reach it through a
// createRequire shim (preserves the exact directory resolution of the former
// `require('./framework/core')`).

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

if (!process.env.CI) {
  const { shell } = require('../framework/core');
  const opts = { silent: true };
  shell.run('pnpm', ['run', 'sync'], true, opts);
  shell.run('pnpm', ['run', 'format'], true, opts);
}
