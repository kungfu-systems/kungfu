// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { resolveTuiRuntimeDir } from './terminal-lifecycle.js';

export function resolveTuiRuntimePaths({
  env,
  cwd,
  platform,
  resolveCorePackagePath,
}: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform: NodeJS.Platform;
  resolveCorePackagePath: () => string;
}) {
  const configuredKungfuDir = env.KUNGFU_DIR;
  const coreDir = configuredKungfuDir
    ? path.dirname(path.resolve(configuredKungfuDir))
    : path.dirname(resolveCorePackagePath());
  const kungfuDir = configuredKungfuDir
    ? path.resolve(configuredKungfuDir)
    : path.join(coreDir, 'dist', 'kungfu');
  const packagedBin = path.join(
    kungfuDir,
    platform === 'win32' ? 'kungfu.exe' : 'kungfu',
  );
  const configuredBin = env.KUNGFU_CLI_BIN || env.KUNGFU_BIN || '';
  const packagedBinPresent = fs.existsSync(packagedBin);
  return {
    coreDir,
    runtimeDir: resolveTuiRuntimeDir({
      env,
      cwd,
      contractPath: path.join(
        kungfuDir,
        'config',
        'kungfu-config.contract.json',
      ),
    }),
    configHome: env.KF_CONFIG_HOME || path.join(homedir(), '.kungfu-config'),
    bin: configuredBin || (packagedBinPresent ? packagedBin : 'kungfu'),
    sourceCliFallback: !configuredBin && !packagedBinPresent,
  };
}
