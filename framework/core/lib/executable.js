// SPDX-License-Identifier: Apache-2.0
// @ts-check

const { resolveExecutable } = require('./platform-packages');

/** @param {string} name @returns {string} */
function resolve(name) {
  return resolveExecutable(name);
}

module.exports = {
  kfc: resolve('kungfu'),
};
