// SPDX-License-Identifier: Apache-2.0
// @ts-check

/**
 * Build a sywac CLI: wire the caller's `setup`, optional -h/--help and
 * -v/--version, and parse+exit when run as the main module. Returns the cli
 * instance so callers can further configure it.
 * @param {NodeModule} module the caller's `module`, to detect `require.main`
 * @param {(cli: any) => void} setup callback that registers commands/options
 * @param {{ silent?: boolean, tolerant?: boolean, help?: boolean, version?: boolean }} [opts]
 * @returns {any} the configured sywac cli instance
 */
module.exports = function (module, setup, opts = {}) {
  /** @type {any} sywac has no bundled types */
  const cli = require('sywac').strict();
  /** @param {any} result */
  const exitHandler = (result) => {
    if (result.output) {
      console.log(result.output);
      process.exit(result.code);
    }
    if (result.code !== 0) process.exit(result.code);
    if (!opts.silent && result.details.args.length === 0) {
      cli.showHelpByDefault().parseAndExit();
    }
    return result.argv;
  };
  /** @param {any} error */
  const errorHandler = (error) => {
    console.error(error);
    opts.tolerant || process.exit(-1);
  };
  setup(cli);
  if (opts.help === undefined || opts.help) {
    cli.help('-h, --help');
  }
  if (opts.version === undefined || opts.version) {
    cli.version('-v, --version');
  }
  if (require.main === module) {
    cli.parse().then(exitHandler).catch(errorHandler);
  }
  return cli;
};
