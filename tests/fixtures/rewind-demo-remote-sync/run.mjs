// SPDX-License-Identifier: Apache-2.0
// Remote mirror fixture. Proves a source registry entry can mirror a runtime
// into remotes/<source-id>/runtime with a sync manifest instead of mixing it
// into the local authoritative runtime.

import fs from 'node:fs';
import path from 'node:path';
import { assertFileContains, json, kfc, locate, tmpDir } from '../_harness.mjs';

const { coreDir } = locate(import.meta.url);
const localHome = tmpDir('kf-remote-local-');
const sourceHome = tmpDir('kf-remote-source-');

fs.mkdirSync(path.join(sourceHome, 'rewind', 'run-a', 'bundle'), { recursive: true });
fs.writeFileSync(
  path.join(sourceHome, 'rewind', 'run-a', 'bundle', 'manifest.json'),
  JSON.stringify({ schema: 'test-manifest', run_id: 'run-a' }),
);
fs.mkdirSync(path.join(sourceHome, 'work', 'store'), { recursive: true });
fs.writeFileSync(
  path.join(sourceHome, 'work', 'store', 'manifest.json'),
  JSON.stringify({ schema: 'test-work-store' }),
);

const added = json(
  kfc(coreDir, localHome, [
    'remote',
    'add',
    'ubuntu',
    '--host',
    'localhost',
    '--home',
    sourceHome,
    '--json',
  ]),
);
if (added.source.transport !== 'local') {
  throw new Error(`expected local transport, got ${added.source.transport}`);
}

const synced = json(kfc(coreDir, localHome, ['remote', 'sync', 'ubuntu', '--json']));
if (synced.manifest.sync_state !== 'fresh') {
  throw new Error(`sync failed: ${JSON.stringify(synced.manifest)}`);
}

const mirror = synced.manifest.mirror_runtime;
assertFileContains(
  path.join(mirror, 'rewind', 'run-a', 'bundle', 'manifest.json'),
  'run-a',
  'mirrored rewind manifest',
);
assertFileContains(
  path.join(path.dirname(mirror), 'sync-manifest.json'),
  'source-scoped',
  'sync manifest boundary',
);

const shown = json(kfc(coreDir, localHome, ['remote', 'show', 'ubuntu', '--json']));
if (shown.manifest.sync_state !== 'fresh') {
  throw new Error(`show missing fresh manifest: ${JSON.stringify(shown)}`);
}

console.log('ok remote sync');
