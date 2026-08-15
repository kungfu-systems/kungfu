// SPDX-License-Identifier: Apache-2.0
//
// Atlas import fixture (P7 dogfood slice): a synthetic control-plane tree is
// imported twice; the journal carries both snapshot batches and the projection
// folds the latest one. Read-only against the source tree — the fixture also
// asserts the sample tree is byte-identical after both imports. Asserted by
// check_import.py. Requires the core dev environment (built dist/kungfu).
//
// Usage: node tests/fixtures/atlas-demo-import/run.mjs

import fs from 'node:fs';
import path from 'node:path';
import { locate, tmpDir, kfc, uvPython, json, sha256, fail } from '../_harness.mjs';

const { fixtureDir, coreDir } = locate(import.meta.url);
const home = tmpDir('atlas-import-');
const sampleRoot = path.join(fixtureDir, 'sample-root');
const missionProfile = path.resolve(
  coreDir,
  '..',
  '..',
  'extensions',
  'work-control',
);

function activateMissionProfile(runtimeDir) {
  uvPython(coreDir, [
    path.join(fixtureDir, '..', '_activate_work_control_profile.py'),
    runtimeDir,
    missionProfile,
  ]);
}

// Byte-identity fingerprint of the source tree (replaces `find ... -exec cksum`).
// Sorted list of relpath:sha256 over every regular file — stable across runs.
function fingerprint(root) {
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) files.push(full);
    }
  };
  walk(root);
  return files
    .map((f) => `${path.relative(root, f)}:${sha256(f)}`)
    .sort()
    .join('\n');
}

const before = fingerprint(sampleRoot);

const k = (args) => kfc(coreDir, home, args);

activateMissionProfile(path.join(home, 'runtime'));
k(['atlas', 'import', '--repo', sampleRoot]);
const second = json(k(['atlas', 'import', '--repo', sampleRoot, '--json']));
const secondId = second.import_id;

const runtimeOverride = path.join(tmpDir('atlas-runtime-dir-'), 'demo-runtime');
activateMissionProfile(runtimeOverride);
uvPython(
  coreDir,
  ['.devtools/kungfu_cli.py', 'atlas', 'import', '--repo', sampleRoot],
  { env: { KF_RUNTIME_DIR: runtimeOverride } },
);
const overrideImport = json(
  uvPython(
    coreDir,
    ['.devtools/kungfu_cli.py', 'atlas', 'import', '--repo', sampleRoot, '--json'],
    { env: { KF_RUNTIME_DIR: runtimeOverride } },
  ),
);
json(
  uvPython(
    coreDir,
    ['.devtools/kungfu_cli.py', 'atlas', 'show', 'import', '--json'],
    { env: { KF_RUNTIME_DIR: runtimeOverride } },
  ),
);

const after = fingerprint(sampleRoot);
if (before !== after) fail('source tree was modified');

uvPython(coreDir, [
  path.join(fixtureDir, 'check_import.py'),
  path.join(home, 'runtime'),
  secondId,
]);
uvPython(coreDir, [
  path.join(fixtureDir, 'check_import.py'),
  runtimeOverride,
  overrideImport.import_id,
]);
