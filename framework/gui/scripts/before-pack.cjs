// SPDX-License-Identifier: Apache-2.0
// electron-builder beforePack hook: bake the frozen first-party manifest into
// dist/kungfu just before it is shipped to Resources/kungfu, so the packaged
// app grants extension trust by verifiable source (ADR-0013). Runs after the
// build, so the extension view bundles are present to pin.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function toEsmEntrypointSpecifier(entryPath, platform = process.platform) {
  return platform === 'win32' ? pathToFileURL(entryPath).href : entryPath;
}

function esmEntrypointArgs(entryPath) {
  const specifier = toEsmEntrypointSpecifier(entryPath);
  return ['--eval', `import(${JSON.stringify(specifier)})`];
}

exports.default = async function beforePack() {
  const tsxLoader = require.resolve('tsx/esm');
  for (const [script, label] of [
    ['gen-first-party-manifest.mjs', 'first-party manifest'],
    ['gen-system-profile-kfd3.mjs', 'system Profile KFD-3 manifest'],
  ]) {
    const gen = path.join(__dirname, script);
    const result = spawnSync(
      process.execPath,
      ['--import', tsxLoader, ...esmEntrypointArgs(gen)],
      { stdio: 'inherit' },
    );
    if (result.status !== 0) {
      throw new Error(`failed to bake the ${label} before pack`);
    }
  }
};

exports.toEsmEntrypointSpecifier = toEsmEntrypointSpecifier;
exports.esmEntrypointArgs = esmEntrypointArgs;
