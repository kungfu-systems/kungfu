// SPDX-License-Identifier: Apache-2.0
// Remote mirror fixture. Proves a source registry entry can mirror a runtime
// into remotes/<source-id>/runtime with a sync manifest instead of mixing it
// into the local authoritative runtime.

import path from 'node:path';
import { assertFileContains, json, kfc, locate, tmpDir } from '../_harness.mjs';

const { coreDir } = locate(import.meta.url);
const localHome = tmpDir('kf-remote-local-');
const sourceHome = tmpDir('kf-remote-source-');

const remoteWorkId = 'assignment-remote-source-1';
const remoteRun = json(
  kfc(coreDir, sourceHome, [
    'report',
    'run',
    'begin',
    '--work',
    remoteWorkId,
    '--provider',
    'codex',
    '--run-id',
    'remote-run-1',
    '--json',
  ]),
);
kfc(coreDir, sourceHome, [
  'report',
  'run',
  'end',
  '--run',
  remoteRun.run_id,
  '--status',
  'succeeded',
  '--json',
]);

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
  path.join(mirror, 'rewind', remoteRun.run_id, 'bundle', 'manifest.json'),
  remoteRun.run_id,
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

const mirroredRuns = json(kfc(coreDir, localHome, ['remote', 'runs', 'ubuntu', '--json']));
const run = mirroredRuns.runs.find((row) => row.run_id === remoteRun.run_id);
if (!run) {
  throw new Error(`remote run projection missing ${remoteRun.run_id}`);
}
if (run.source !== 'remote:ubuntu' || run.sync_state !== 'fresh') {
  throw new Error(`remote run labels missing: ${JSON.stringify(run)}`);
}

console.log('ok remote sync');
