// SPDX-License-Identifier: Apache-2.0
//
// Storage Node binding parity fixture. Requires the built core native runtime.
// It fails if Node cannot reach the same C++ storage service used by Python.

import path from 'node:path';
import { locate, run, runtimeEnv } from '../_harness.mjs';

const { coreDir } = locate(import.meta.url);
const bindingDir = path.join(coreDir, 'dist', 'kungfu');

run(
  process.execPath,
  ['--test', path.join(coreDir, 'tests', 'storage-node-binding.test.js')],
  {
    cwd: coreDir,
    env: {
      ...runtimeEnv(coreDir),
      KUNGFU_DIR: bindingDir,
      KUNGFU_REQUIRE_NATIVE: '1',
    },
  },
);
