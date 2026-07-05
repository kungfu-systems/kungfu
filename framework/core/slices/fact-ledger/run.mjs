// SPDX-License-Identifier: Apache-2.0
//
// Drive the minimal fact-ledger slice end to end:
//   1. assert the tools carry no dynamic dependencies beyond the system runtime
//   2. run the host (write path); it exits
//   3. run the independent export tool (read path) on the same directory
//   4. verify the manifest's whole-segment checksum with a pure-Node hash
//
// Usage: node run.mjs [build-dir] [event-count]
//   build-dir defaults to ../../build (relative to framework/core)
//   event-count defaults to 5

import fs from 'node:fs';
import {
  locate,
  findBin,
  fail,
  tmpDir,
  run,
  sha256,
  jsonField,
  assertNoExtraDylibs,
} from '../_harness.mjs';

const { buildDir } = locate(import.meta.url);
const eventCount = process.argv[3] || '5';

const hostBin = findBin(buildDir, 'fact_ledger_host', 'slices/fact-ledger');
const exportBin = findBin(buildDir, 'fact_ledger_export', 'slices/fact-ledger');
if (!hostBin || !exportBin) {
  fail(
    `fact_ledger_host / fact_ledger_export not found under ${buildDir}\n` +
      `build first, e.g.:\n  cmake --build ${buildDir} --target fact_ledger_host fact_ledger_export`,
  );
}

console.log('== step 0: assert zero extra dynamic dependencies (cut-proof)');
assertNoExtraDylibs(hostBin);
assertNoExtraDylibs(exportBin);
console.log();

const work = tmpDir('fact-ledger-slice-');
console.log(`== journal root: ${work}`);

console.log(`== step 1: host writes ${eventCount} events, then exits`);
run(hostBin, [work, eventCount], { inherit: true });

console.log('\n== step 2: independent export tool reopens the directory');
run(exportBin, [work, 'fact_ledger_slice', 'host', `${work}/export`], {
  inherit: true,
});

console.log('\n== step 3: verify whole-segment checksum with a pure-Node hash');
const declared = jsonField(
  `${work}/export.manifest.json`,
  'event_log',
  'segment_sha256',
);
const recomputed = sha256(`${work}/export.jsonl`);
console.log(`declared:   ${declared}`);
console.log(`recomputed: ${recomputed}`);
if (declared !== recomputed) fail('segment checksum mismatch');

console.log(`\n== exported event log (${work}/export.jsonl):`);
process.stdout.write(fs.readFileSync(`${work}/export.jsonl`));
console.log(`\n== run manifest (${work}/export.manifest.json):`);
process.stdout.write(fs.readFileSync(`${work}/export.manifest.json`));
console.log('\nOK: host wrote, independent tool reopened, checksum verified.');
console.log(`artifacts in ${work}`);
