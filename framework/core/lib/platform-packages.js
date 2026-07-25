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
const fs = require('node:fs');
const path = require('node:path');

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

/**
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {string}
 */
function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/**
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {PlatformDescriptor | undefined}
 */
function platformPackage(platform = process.platform, arch = process.arch) {
  const key = platformKey(platform, arch);
  return platformPackages.find((d) => d.key === key);
}

/** @returns {string} */
function currentKey() {
  return platformKey();
}

/** @returns {PlatformDescriptor | undefined} */
function currentPlatformPackage() {
  return platformPackage();
}

/** @returns {string} */
function sourceRuntimeDir() {
  return path.resolve(__dirname, '..', BINDING_SUBDIR);
}

/**
 * Resolve the one directory that owns the native addon, dynamic libraries,
 * executable CLI, frozen Python runtime, Wasm adapters, and runtime contracts.
 *
 * @param {{
 *   platform?: string,
 *   arch?: string,
 *   env?: NodeJS.ProcessEnv,
 *   loadPackage?: (name: string) => any,
 *   allowSourceFallback?: boolean,
 * }} [options]
 * @returns {string}
 */
function resolveRuntimeDir(options = {}) {
  const env = options.env || process.env;
  if (env.KUNGFU_DIR) return path.resolve(env.KUNGFU_DIR);

  const descriptor = platformPackage(options.platform, options.arch);
  if (!descriptor) {
    throw new Error(
      `@kungfu-tech/core does not support ${platformKey(options.platform, options.arch)}`,
    );
  }

  const loadPackage = options.loadPackage || ((name) => require(name));
  let packageError;
  try {
    const platformModule = loadPackage(descriptor.name);
    const runtimeDir = platformModule?.runtimeDir || platformModule?.bindingDir;
    if (typeof runtimeDir !== 'string' || runtimeDir.length === 0) {
      throw new Error(`${descriptor.name} does not export runtimeDir`);
    }
    return path.resolve(runtimeDir);
  } catch (error) {
    packageError = error;
  }

  const localRuntime = sourceRuntimeDir();
  if (options.allowSourceFallback !== false && fs.existsSync(localRuntime)) {
    return localRuntime;
  }

  const error = new Error(
    `Missing ${descriptor.name}; reinstall @kungfu-tech/core for ${descriptor.key}`,
  );
  error.cause = packageError;
  throw error;
}

/**
 * @param {string} name
 * @param {Parameters<typeof resolveRuntimeDir>[0]} [options]
 * @returns {string}
 */
function resolveExecutable(name, options = {}) {
  const platform = options.platform || process.platform;
  const bin = platform === 'win32' ? `${name}.exe` : name;
  return path.join(resolveRuntimeDir(options), bin);
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
  platformKey,
  platformPackage,
  currentKey,
  currentPlatformPackage,
  sourceRuntimeDir,
  resolveRuntimeDir,
  resolveExecutable,
  packageNameForConfiguration,
};
