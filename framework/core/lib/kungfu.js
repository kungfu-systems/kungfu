// SPDX-License-Identifier: Apache-2.0

module.exports = function () {
  const binding = (() => {
    try {
      const moduleName = '@kungfu-tech/core';
      const config = require(`${moduleName}/package.json`);
      const binary = config.binary;
      const kungfuDir =
        process.env.KUNGFU_DIR || `${moduleName}/${binary.module_path}`;

      const nodeBinding = require.resolve(
        `${kungfuDir}/${binary.module_name}.node`,
      );
      const electronBinding = nodeBinding.replace('_node.', '_electron.');
      const kungfuBinding = nodeBinding.replace('_node.', '_cli.');
      const useElectron =
        process.platform !== 'win32' && 'electron' in process.versions;
      const useKfc =
        process.platform === 'linux' && process.env.KUNGFU_AS_VARIANT === 'node';
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

    History: function (home) {
      return new binding.History(home);
    },
    ConfigStore: function (home) {
      return new binding.ConfigStore(home);
    },
    RiskSettingStore: function (home) {
      return new binding.RiskSettingStore(home);
    },
    CommissionStore: function (home) {
      return new binding.CommissionStore(home);
    },
    BasketStore: function (home) {
      return new binding.BasketStore(home);
    },
    BasketInstrumentStore: function (home) {
      return new binding.BasketInstrumentStore(home);
    },
    SessionStore: function (location, home) {
      return new binding.SessionStore(location, home);
    },
    IODevice: function (location, home) {
      return new binding.IODevice(location, home);
    },
    tracer: function (location, home, read, write, begin, end) {
      return new binding.Tracer(location, home, read, write, begin, end);
    },

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
