// SPDX-License-Identifier: Apache-2.0
// @ts-check

/**
 * Single source of truth for `@kungfu-tech/core` prebuilt platform packages.
 *
 * Consumed by the runtime binding resolver (`lib/kungfu.js`) and the packaging
 * tool (`.gyp/core-platform-package.js`). Mirrors the libnode platform-package
 * pattern (`@kungfu-tech/libnode` → `.gyp/node-platform-package.js`); see the
 * Atlas design note for goal
 * `2026-07-04-kungfu-prebuilt-distribution-modernization`.
 */

const SCOPE = '@kungfu-tech/core';

/** Native addon module name (matches the node-pre-gyp build descriptor). */
const MODULE_NAME = 'kungfu_node';

/** Binding directory inside both the main build tree and each platform pkg. */
const BINDING_SUBDIR = 'dist/kungfu';

/**
 * @typedef {Object} PlatformDescriptor
 * @property {string} key      `${platform}-${arch}`
 * @property {string} name     npm platform package name (Release, unsuffixed)
 * @property {string[]} os     npm `os` field
 * @property {string[]} cpu    npm `cpu` field
 */

/** @type {PlatformDescriptor[]} */
const platformPackages = [
  {
    key: 'darwin-arm64',
    name: `${SCOPE}-darwin-arm64`,
    os: ['darwin'],
    cpu: ['arm64'],
  },
  { key: 'linux-x64', name: `${SCOPE}-linux-x64`, os: ['linux'], cpu: ['x64'] },
  { key: 'win32-x64', name: `${SCOPE}-win32-x64`, os: ['win32'], cpu: ['x64'] },
];

/** @returns {string} */
function currentKey() {
  return `${process.platform}-${process.arch}`;
}

/** @returns {PlatformDescriptor | undefined} */
function currentPlatformPackage() {
  const key = currentKey();
  return platformPackages.find((d) => d.key === key);
}

/**
 * Release/Debug is carried in the package name, not in npm os/cpu resolution:
 * CI publishes Release (unsuffixed); a Debug build appends `-debug`. Consumers
 * default to Release; developers opt into Debug via `build_type=Debug`
 * (npm package config / env), which the resolver and packer both honour.
 * @param {string} name  descriptor.name (Release form)
 * @param {string} [configuration]  'Release' | 'Debug'
 * @returns {string}
 */
function packageNameForConfiguration(name, configuration) {
  return configuration === 'Debug' ? `${name}-debug` : name;
}

module.exports = {
  SCOPE,
  MODULE_NAME,
  BINDING_SUBDIR,
  platformPackages,
  currentKey,
  currentPlatformPackage,
  packageNameForConfiguration,
};
