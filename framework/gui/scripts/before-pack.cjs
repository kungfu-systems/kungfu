// SPDX-License-Identifier: Apache-2.0
// electron-builder beforePack hook: bake release qualification and upgrade
// metadata into dist/kungfu just before packaging.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function toEsmEntrypointSpecifier(entryPath, platform = process.platform) {
  return platform === 'win32' ? pathToFileURL(entryPath).href : entryPath;
}

function esmEntrypointArgs(entryPath, platform = process.platform) {
  const specifier = toEsmEntrypointSpecifier(entryPath, platform);
  return ['--eval', `import(${JSON.stringify(specifier)})`];
}

function beforePackArgs(tsxLoader, generator, platform = process.platform) {
  return [
    '--import',
    toEsmEntrypointSpecifier(tsxLoader, platform),
    ...esmEntrypointArgs(generator, platform),
  ];
}

exports.default = async function beforePack() {
  const tsxLoader = require.resolve('tsx/esm');
  for (const [script, label] of [
    ['gen-system-profile-kfd3.mjs', 'system Profile KFD-3 manifest'],
    ['gen-upgrade-manifest.mjs', 'bundled runtime upgrade manifest'],
  ]) {
    const gen = path.join(__dirname, script);
    const result = spawnSync(process.execPath, beforePackArgs(tsxLoader, gen), {
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      throw new Error(`failed to bake the ${label} before pack`);
    }
  }
};

exports.beforePackArgs = beforePackArgs;
exports.toEsmEntrypointSpecifier = toEsmEntrypointSpecifier;
exports.esmEntrypointArgs = esmEntrypointArgs;
