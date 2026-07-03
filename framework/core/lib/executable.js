// SPDX-License-Identifier: Apache-2.0

const path = require('path');

function resolve(name) {
  const kungfuDir = path.resolve(__dirname, '..', 'dist', 'kungfu');
  const bin = process.platform === 'win32' ? `${name}.exe` : name;
  return path.resolve(kungfuDir, bin);
}

module.exports = {
  kfc: resolve('kungfu'),
  kfs: resolve('kfs'),
};
