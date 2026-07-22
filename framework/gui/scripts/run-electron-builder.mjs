// SPDX-License-Identifier: Apache-2.0
// Cross-platform electron-builder launcher.
//
// electron-builder needs --config.electronDist pointing at the local electron
// install because pnpm does not hoist electron to a path electron-builder can
// guess. The pack/dist scripts used to compute it with a POSIX `$(node -p …)`
// command substitution, which cmd.exe does not understand, so `pnpm run dist`
// failed on Windows (electron-builder got the literal `$(…)` string). Resolve it
// in node here and invoke electron-builder's JS bin directly (args as an array,
// no shell), so pack/dist work identically on macOS, Linux, and Windows.
//
// Any extra args (e.g. `--dir` for pack) are forwarded before the computed
// electronDist override.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const electronDist = `${dirname(require.resolve('electron'))}/dist`;

const ebPkgPath = require.resolve('electron-builder/package.json');
const ebPkg = require(ebPkgPath);
const ebBin = join(dirname(ebPkgPath), ebPkg.bin['electron-builder']);

export function normalizeBuilderArgs(args, resolvedElectronDist) {
  const hasPublishMode = args.some(
    (arg) => arg === '--publish' || arg.startsWith('--publish='),
  );
  return [
    ...args,
    ...(hasPublishMode ? [] : ['--publish=never']),
    `--config.electronDist=${resolvedElectronDist}`,
  ];
}

function main() {
  const args = [
    ebBin,
    ...normalizeBuilderArgs(process.argv.slice(2), electronDist),
  ];
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main();
}
