// SPDX-License-Identifier: Apache-2.0
//
// Drive the embedding slice end to end:
//   1. configure the standalone embedder project from scratch in a throwaway
//      build directory (add_subdirectory of src/libyijinjing; no kungfu parent)
//   2. build it
//   3. run embed_smoke: write a causal chain, reopen with assemble, assert
//
// Usage: node run.mjs [core-build-dir]
//   core-build-dir defaults to ../../build (relative to framework/core); it is
//   only used to locate the conan toolchain that stands in for the embedder's
//   own dependency provisioning.

import fs from 'node:fs';
import path from 'node:path';
import { fail, locate, run, tmpDir } from '../_harness.mjs';

const { sliceDir, buildDir } = locate(import.meta.url);
const toolchain = path.join(buildDir, 'conan_toolchain.cmake');
if (!fs.existsSync(toolchain)) {
  fail(
    `${toolchain} not found\nseed the core build first (conan install / rebuild:core); the embedder\nborrows its dependency provisioning from that toolchain.`,
  );
}

const scratch = tmpDir('embedding-slice-build-');
const work = tmpDir('embedding-slice-journal-');

console.log(
  `== step 1: configure the standalone embedder (scratch: ${scratch})`,
);
run('cmake', [
  '-S',
  sliceDir,
  '-B',
  scratch,
  `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`,
  '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW',
  '-DCMAKE_BUILD_TYPE=Release',
]);

console.log('== step 2: build');
run('cmake', ['--build', scratch, '--target', 'embed_smoke']);

console.log('== step 3: write + reopen + assert the causal chain');
run(path.join(scratch, 'embed_smoke'), [work], { inherit: true });

console.log(`artifacts in ${work} (embedder build: ${scratch})`);
