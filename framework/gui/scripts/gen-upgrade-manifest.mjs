// SPDX-License-Identifier: Apache-2.0
// electron-builder beforePack entrypoint. The manifest is outside the bundled
// runtime tree so its own digest cannot make the runtime identity circular.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBundledUpgradeManifest } from '@kungfu-tech/product-kungfu/tooling/upgrade-manifest';

const guiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(guiDir, '..', '..');
const output = path.join(
  guiDir,
  'dist',
  'update',
  'kungfu-release-manifest.json',
);

const manifest = writeBundledUpgradeManifest({
  root,
  runtimeRoot: path.join(root, 'framework', 'core', 'dist', 'kungfu'),
  output,
});

console.log(
  `[upgrade-manifest] runtime=${manifest.runtimeBuildId} frontend=${manifest.frontendBuildId} -> ${output}`,
);
