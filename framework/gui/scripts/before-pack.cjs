// SPDX-License-Identifier: Apache-2.0
// electron-builder beforePack hook: bake the frozen first-party manifest into
// dist/kungfu just before it is shipped to Resources/kungfu, so the packaged
// app grants extension trust by verifiable source (ADR-0013). Runs after the
// build, so the extension view bundles are present to pin.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function beforePack() {
  const gen = path.join(__dirname, 'gen-first-party-manifest.mjs');
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', gen],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error('failed to bake the first-party manifest before pack');
  }
};
