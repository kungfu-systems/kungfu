// SPDX-License-Identifier: Apache-2.0
// @ts-check

const {
  currentPlatformPackage,
  MODULE_NAME,
  BINDING_SUBDIR,
} = require('./platform-packages');

/**
 * Resolve the directory holding the native addon.
 *
 * Order: explicit `KUNGFU_DIR` override → the installed prebuilt platform
 * package for this platform (`@kungfu-tech/core-{platform}`, via its exported
 * `bindingDir`) → the in-package build tree for developers who ran
 * `npm run build`. The platform package's `index.js` also colocates the libnode
 * shared library next to the addon before returning, so `@loader_path` /
 * `$ORIGIN` / same-dir-DLL lookup resolves.
 * @param {string} moduleName
 * @returns {string}
 */
function resolveBindingDir(moduleName) {
  if (process.env.KUNGFU_DIR) return process.env.KUNGFU_DIR;

  const descriptor = currentPlatformPackage();
  if (descriptor) {
    try {
      const platformPackage = require(descriptor.name);
      if (platformPackage && platformPackage.bindingDir) {
        return platformPackage.bindingDir;
      }
    } catch (e) {
      // Platform package not installed (e.g. local source build); fall back.
    }
  }

  return `${moduleName}/${BINDING_SUBDIR}`;
}

/**
 * Load the native kungfu binding and expose its typed factory surface.
 *
 * The binding is a dynamically-resolved native addon, so it has no static
 * type. It is treated as `any` here; the annotations below describe the
 * public factory API this module hands to callers, not the addon internals.
 * @returns {Record<string, any>}
 */
module.exports = function () {
  /** @type {any} */
  const binding = (() => {
    try {
      const moduleName = '@kungfu-tech/core';
      const kungfuDir = resolveBindingDir(moduleName);

      const nodeBinding = require.resolve(`${kungfuDir}/${MODULE_NAME}.node`);
      const electronBinding = nodeBinding.replace('_node.', '_electron.');
      const kungfuBinding = nodeBinding.replace('_node.', '_cli.');
      const useElectron =
        process.platform !== 'win32' && 'electron' in process.versions;
      const useKfc =
        process.platform === 'linux' &&
        process.env.KUNGFU_AS_VARIANT === 'node';
      const binding_path = useElectron
        ? electronBinding
        : useKfc
          ? kungfuBinding
          : nodeBinding;
      return require(binding_path);
    } catch (e) {
      console.error(`Can not find kungfu node binding: ${e}`);
      return {};
    }
  })();

  return {
    _binding: binding,
    hash: binding.hash,
    formatTime: binding.formatTime,
    formatStringToHashHex: binding.formatStringToHashHex,
    parseTime: binding.parseTime,
    pyExec: binding.pyExec,
    pyEval: binding.pyEval,
    pyEvalFile: binding.pyEvalFile,
    shutdown: binding.shutdown,
    Longfist: () => new binding.Longfist(),
    /**
     * @param {any} arg a single location or an array of locations
     * @param {string} [mode]
     * @param {string} [category]
     * @param {string} [group]
     * @param {string} [name]
     * @returns {any}
     */
    Assemble: function (
      arg,
      mode = '*',
      category = '*',
      group = '*',
      name = '*',
    ) {
      if (Array.isArray(arg)) {
        return new binding.Assemble(arg, mode, category, group, name);
      } else {
        return new binding.Assemble([arg], mode, category, group, name);
      }
    },

    /** @param {any} home @returns {any} */
    History: function (home) {
      return new binding.History(home);
    },
    /** @param {any} home @returns {any} */
    ConfigStore: function (home) {
      return new binding.ConfigStore(home);
    },
    /** @param {any} home @returns {any} */
    RiskSettingStore: function (home) {
      return new binding.RiskSettingStore(home);
    },
    /** @param {any} home @returns {any} */
    CommissionStore: function (home) {
      return new binding.CommissionStore(home);
    },
    /** @param {any} home @returns {any} */
    BasketStore: function (home) {
      return new binding.BasketStore(home);
    },
    /** @param {any} home @returns {any} */
    BasketInstrumentStore: function (home) {
      return new binding.BasketInstrumentStore(home);
    },
    /** @param {any} location @param {any} home @returns {any} */
    SessionStore: function (location, home) {
      return new binding.SessionStore(location, home);
    },
    /** @param {any} location @param {any} home @returns {any} */
    IODevice: function (location, home) {
      return new binding.IODevice(location, home);
    },
    /**
     * @param {any} location
     * @param {any} home
     * @param {boolean} read
     * @param {boolean} write
     * @param {number} begin
     * @param {number} end
     * @returns {any}
     */
    tracer: function (location, home, read, write, begin, end) {
      return new binding.Tracer(location, home, read, write, begin, end);
    },

    /**
     * @param {any} home
     * @param {string} name
     * @param {boolean} [bypassRestore]
     * @param {boolean} [bypassAccounting]
     * @param {boolean} [bypassTradingData]
     * @param {boolean} [refreshTradingDataBeforeSync]
     * @param {boolean} [bypassRefreshBook]
     * @param {number} [millisecondsSleepAfterStep]
     * @returns {any}
     */
    watcher: function (
      home,
      name,
      bypassRestore = false,
      bypassAccounting = false,
      bypassTradingData = false,
      refreshTradingDataBeforeSync = false,
      bypassRefreshBook = false,
      millisecondsSleepAfterStep = 50,
    ) {
      return new binding.Watcher(
        home,
        name,
        bypassRestore,
        bypassAccounting,
        bypassTradingData,
        refreshTradingDataBeforeSync,
        bypassRefreshBook,
        millisecondsSleepAfterStep,
      );
    },
  };
};
