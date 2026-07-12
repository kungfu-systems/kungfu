// SPDX-License-Identifier: Apache-2.0

export default {
  globs: [
    '**/*.md',
    '!framework/core/.deps/**',
    '!**/node_modules/**',
    '!**/.venv/**',
    '!**/build/**',
    '!**/dist/**',
    '!**/out/**',
  ],
  config: {
    default: false,
    MD001: true,
    MD018: true,
    MD019: true,
    MD023: true,
    MD027: true,
    MD042: true,
    MD045: true,
    MD047: true,
    MD051: true,
    MD052: true,
    MD053: true,
    MD057: true,
  },
};
