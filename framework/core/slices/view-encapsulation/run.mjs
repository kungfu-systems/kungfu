// SPDX-License-Identifier: Apache-2.0
//
// Drive the view-encapsulation slice end to end (ADR-0039):
//   1. run view_encapsulation_probe — the kungfu::view projection roundtrip
//      (thin/full/evolve/verify) built without linking the runtime;
//   2. run the FB boundary guard (check-view-boundary.mjs) — no raw
//      flatbuffers::/reflection:: outside the kungfu::view module.
//
// A red run means either the sole-access-point API regressed (1) or FlatBuffers
// leaked back out of the chokepoint (2).
//
// Usage: node run.mjs [build-dir]

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { assertContains, fail, findBin, locate, run } from '../_harness.mjs';

const { buildDir } = locate(import.meta.url);

const probe = findBin(
  buildDir,
  'view_encapsulation_probe',
  'slices/view-encapsulation',
);
if (!probe) {
  fail(
    `slice binary not found under ${buildDir}\n` +
      `build first: cmake --build ${buildDir} --target view_encapsulation_probe`,
  );
}

console.error('== projection roundtrip through kungfu::view');
const out = run(probe, []).stdout;
assertContains(
  out,
  'OK: kungfu::view projection roundtrip',
  'view projection probe',
);

console.error('== FlatBuffers boundary guard (no raw FB outside kungfu::view)');
const guard = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'src',
  'libkungfu',
  'check-view-boundary.mjs',
);
const g = spawnSync(process.execPath, [guard], { encoding: 'utf8' });
process.stderr.write(g.stdout || '');
if (g.status !== 0) {
  process.stderr.write(g.stderr || '');
  fail(
    'FlatBuffers boundary guard failed (raw flatbuffers::/reflection:: outside kungfu::view)',
  );
}

console.log(
  '\nOK: FlatBuffers access is confined to kungfu::view and the projection roundtrip holds.',
);
