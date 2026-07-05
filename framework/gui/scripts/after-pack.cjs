// SPDX-License-Identifier: Apache-2.0
// electron-builder afterPack hook: enforce that the app ships a single copy of
// the frozen core runtime under Contents/Resources/kungfu.
const {
  auditPackagedApp,
  findAppFromContext,
} = require('./bundle-core-audit.cjs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  auditPackagedApp(findAppFromContext(context), { prune: true });
};
