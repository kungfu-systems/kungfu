#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guiRequire = createRequire(
  path.join(root, 'framework', 'gui', 'package.json'),
);
const tsxCli = guiRequire.resolve('tsx/cli');
const result = spawnSync(
  process.execPath,
  [
    tsxCli,
    '--test',
    path.join(root, 'framework/gui/src/main/update-controller.test.ts'),
    path.join(root, 'framework/gui/src/main/update-state-store.test.ts'),
    path.join(root, 'framework/gui/src/main/runtime-upgrade-cli.test.ts'),
    path.join(root, 'framework/gui/src/main/electron-updater-adapter.test.ts'),
    path.join(root, 'framework/gui/src/main/desktop-update-provider.test.ts'),
    path.join(root, 'framework/gui/src/main/release-manifest-resolver.test.ts'),
    path.join(root, 'product/scripts/upgrade-manifest.test.mjs'),
    path.join(root, 'framework/gui/scripts/before-pack.test.cjs'),
    path.join(root, 'framework/gui/scripts/sign-macos.test.mjs'),
  ],
  {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
