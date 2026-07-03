#!/usr/bin/env node

const path = require('path');
const { kfs } = require('./executable');
const shell = require('./shell');

shell.run(kfs, process.argv.slice(2), true, {
  silent: true,
  env: {
    KFS_PATH: path.join(
      require.resolve('@kungfu-tech/sdk'),
      '..',
      '..',
      'dist',
      'sdk',
      'kfs.js',
    ),
    KUNGFU_PATH: path.join(__dirname, '..', 'dist', 'kungfu'),
  },
});
