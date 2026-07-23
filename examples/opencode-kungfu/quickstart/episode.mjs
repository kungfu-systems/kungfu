// SPDX-License-Identifier: Apache-2.0

import core from '@kungfu-tech/core';

const runtimeDir = process.argv[2];
if (!runtimeDir) throw new Error('usage: node episode.mjs RUNTIME_DIR');
const kungfu = core.kungfu();
const opened = kungfu.storageEpisodeBeginTyped(runtimeDir, {
  title: 'vendor quickstart',
  actor: 'node-host',
});
console.log(
  kungfu.storageEpisodeCloseTyped(runtimeDir, {
    episode_id: opened.episode_id,
    reason: 'quickstart complete',
  }),
);
