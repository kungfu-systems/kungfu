// SPDX-License-Identifier: Apache-2.0
//
// Drive the schema-registry slice end to end:
//   1. producer writes a run bound to schema v1; decoder decodes it from the
//      bundle alone (runtime reflection, no generated code)
//   2. producer writes a second run bound to schema v2 (adds a field);
//      decoder decodes it the same way
//   3. assert the two runs bound different schema hashes (version coexistence)
//      and that only the v2 output carries the added field
//
// Usage: node run.mjs [build-dir]

import fs from 'node:fs';
import path from 'node:path';
import {
  locate,
  findBin,
  fail,
  tmpDir,
  run,
  jsonField,
  assertContains,
  assertNotContains,
} from '../_harness.mjs';

const { buildDir } = locate(import.meta.url);
const producer = findBin(
  buildDir,
  'schema_registry_producer',
  'slices/schema-registry',
);
const decoder = findBin(
  buildDir,
  'schema_registry_decoder',
  'slices/schema-registry',
);
const genDir = path.join(buildDir, 'slices', 'schema-registry', 'generated');

if (
  !producer ||
  !decoder ||
  !fs.existsSync(path.join(genDir, 'demo_v1.bfbs'))
) {
  fail(
    `slice binaries or generated .bfbs not found under ${buildDir}\n` +
      `build first: cmake --build ${buildDir} --target schema_registry_producer schema_registry_decoder`,
  );
}

function runOne(version) {
  const work = tmpDir('schema-registry-journal-');
  const bundle = tmpDir('schema-registry-bundle-');
  console.error(`== run v${version}: produce`);
  run(
    producer,
    [work, bundle, String(version), path.join(genDir, `demo_v${version}.bfbs`)],
    {
      inherit: true,
    },
  );
  console.error(`== run v${version}: decode from bundle alone`);
  const decoded = run(decoder, [work, bundle]).stdout;
  return { decoded, bundle };
}

const v1 = runOne(1);
const v2 = runOne(2);

console.log('\n== assertions');
assertContains(v1.decoded, '"kind":"observe"', 'v1 decode');
assertNotContains(v1.decoded, '"note"', 'v1 output (v2-added field)');
assertContains(v2.decoded, '"note":"added in v2"', 'v2 decode');
assertContains(v1.decoded, '"schema_kind":"json"', 'v1 json event');

const hashV1 = jsonField(
  path.join(v1.bundle, 'manifest.json'),
  'schema_bindings',
  '20021',
  'schema_hash',
);
const hashV2 = jsonField(
  path.join(v2.bundle, 'manifest.json'),
  'schema_bindings',
  '20021',
  'schema_hash',
);
if (hashV1 === hashV2) fail('v1 and v2 runs bound the same schema hash');
console.log(
  `  v1 schema ${hashV1.slice(0, 12)}... != v2 schema ${hashV2.slice(0, 12)}... (coexisting, both decoded)`,
);
console.log(
  '\nOK: independent decoder produced named fields from the bundle alone, across two schema versions.',
);
