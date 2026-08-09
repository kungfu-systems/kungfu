// SPDX-License-Identifier: Apache-2.0
// @ts-check

const { resolveExecutable } = require('./platform-packages');

/** @param {string} name @returns {string} */
function resolve(name) {
  return resolveExecutable(name);
}

const executable = {};

// Keep source-only consumers importable before a native platform artifact is
// installed. The runtime still fails closed at the first actual CLI access.
Object.defineProperty(executable, 'kfc', {
  enumerable: true,
  get() {
    return resolve('kungfu');
  },
});

module.exports = executable;
