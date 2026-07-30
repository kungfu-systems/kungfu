// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import { fail, findBin, locate, run, tmpDir } from '../_harness.mjs';

const { sliceDir, buildDir } = locate(import.meta.url);
const toolchain = path.join(buildDir, 'conan_toolchain.cmake');
if (!fs.existsSync(toolchain)) {
  fail(`${toolchain} not found; seed the Core build first`);
}

const scratch = tmpDir('custom-provider-consumer-');
run('cmake', [
  '-S',
  sliceDir,
  '-B',
  scratch,
  '-G',
  'Ninja',
  `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`,
  '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW',
  '-DCMAKE_BUILD_TYPE=Release',
]);
run('cmake', ['--build', scratch, '--target', 'custom_provider_consumer']);
const executable = findBin(scratch, 'custom_provider_consumer');
if (!executable) {
  fail(`custom_provider_consumer not found under ${scratch}`);
}
run(executable, [], { inherit: true });
