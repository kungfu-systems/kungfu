#!/usr/bin/env node

const path = require('path');
const { kfc } = require('./executable');
const shell = require('./shell');

shell.run(kfc, process.argv.slice(2), true, {
  silent: true,
  env: {
    // kept for the runtime's cli command; the webpack-era CLI package this
    // used to resolve is retired, so the value is the same fallback the old
    // lookup always produced
    KF_CLI_DEV_PATH: path.resolve('.', 'lib', 'dev', 'cli.dev.js'),
    KF_LOG_LEVEL: 'trace',
    ...process.env,
  },
});
