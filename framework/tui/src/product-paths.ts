// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const nodeRequire = createRequire(import.meta.url);

export function resolveTuiProductPaths({
  env,
  resolveCorePackage = () =>
    nodeRequire.resolve('@kungfu-tech/core/package.json'),
  existsSync = fs.existsSync,
}: {
  env: NodeJS.ProcessEnv;
  resolveCorePackage?: () => string;
  existsSync?: (candidate: string) => boolean;
}) {
  let coreDir: string | undefined;
  const requireCoreDir = () => {
    coreDir ??= path.dirname(resolveCorePackage());
    return coreDir;
  };
  const kungfuDir = env.KUNGFU_DIR
    ? path.resolve(env.KUNGFU_DIR)
    : path.join(requireCoreDir(), 'dist', 'kungfu');
  const packagedBin = path.join(
    kungfuDir,
    process.platform === 'win32' ? 'kungfu.exe' : 'kungfu',
  );
  const configuredBin = env.KUNGFU_CLI_BIN || env.KUNGFU_BIN || '';
  const sourceCliFallback = !configuredBin && !existsSync(packagedBin);
  if (sourceCliFallback) requireCoreDir();
  return {
    coreDir: coreDir ?? '',
    kungfuDir,
    bin: configuredBin || (existsSync(packagedBin) ? packagedBin : 'kungfu'),
    sourceCliFallback,
  };
}
