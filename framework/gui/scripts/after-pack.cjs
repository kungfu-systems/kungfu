// SPDX-License-Identifier: Apache-2.0
// electron-builder afterPack hook: enforce that the app ships a single copy of
// the assembled core runtime under Contents/Resources/kungfu.
const {
  auditPackagedApp,
  findAppFromContext,
  repairNodePtySpawnHelpers,
} = require('./bundle-core-audit.cjs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appDir = findAppFromContext(context);
  // electron-builder can copy node-pty's native helper without its executable
  // bit. The addon then fails every PTY launch with only "posix_spawnp failed".
  repairNodePtySpawnHelpers(appDir);
  auditPackagedApp(appDir, { prune: true });
};
