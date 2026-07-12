// SPDX-License-Identifier: Apache-2.0
//
// Drive the content-store slice end to end (ADR-0040):
//   1. assert the probe links only the yijinjing static core (cut-proof)
//   2. run the fixture suite: four contract obligations, declared error
//      categories, size-limit semantics, in-process concurrent dedup
//   3. run the dependency-direction guard and its seeded self-test -- the
//      kernel must reference no concrete engine, and the gate must be able
//      to fail
//   4. multi-process concurrency proof: several writer processes publish the
//      same content set against one store root; the filesystem must end with
//      exactly one object per content and zero temp residue
//
// Usage: node run.mjs [build-dir]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertNoExtraDylibs,
  fail,
  findBin,
  locate,
  run,
  tmpDir,
} from '../_harness.mjs';

const { coreDir, buildDir } = locate(import.meta.url);

const probe = findBin(buildDir, 'content_store_probe', 'slices/content-store');
if (!probe) {
  fail(
    `content_store_probe not found under ${buildDir}\n` +
      `build first, e.g.:\n  cmake --build ${buildDir} --target content_store_probe`,
  );
}

console.log('== step 0: assert zero extra dynamic dependencies (cut-proof)');
assertNoExtraDylibs(probe);

const work = tmpDir('content-store-slice-');

console.log('\n== step 1: contract obligations + in-process concurrency');
run(probe, [path.join(work, 'store')], { inherit: true });

console.log('\n== step 2: dependency-direction guard + seeded self-test');
const guard = path.join(coreDir, 'src', 'libyijinjing', 'check-deps.mjs');
run(process.execPath, [guard], { inherit: true });
run(process.execPath, [guard, '--self-test'], { inherit: true });

console.log('\n== step 3: multi-process concurrent dedup');
const writers = 6;
const contents = 16;
const mpRoot = path.join(work, 'mp-store');
const exits = await Promise.all(
  Array.from(
    { length: writers },
    () =>
      new Promise((resolve) => {
        const child = spawn(probe, ['--writer', mpRoot, String(contents)], {
          stdio: 'inherit',
        });
        child.on('error', () => resolve(-1));
        child.on('exit', (code) => resolve(code));
      }),
  ),
);
if (exits.some((code) => code !== 0))
  fail(`writer exit codes: ${exits.join(', ')}`);

let objects = 0;
let residue = 0;
const namespaceDir = path.join(mpRoot, 'payloads');
for (const entry of fs.readdirSync(namespaceDir, {
  recursive: true,
  withFileTypes: true,
})) {
  if (!entry.isFile()) continue;
  if (path.basename(entry.parentPath ?? entry.path) === 'tmp') residue += 1;
  else objects += 1;
}
if (objects !== contents)
  fail(`expected ${contents} unique objects, found ${objects}`);
if (residue !== 0) fail(`expected zero temp residue, found ${residue}`);

console.log(
  `\nOK: ${writers} concurrent writer processes x ${contents} shared contents -> ${objects} objects, no torn state.`,
);
