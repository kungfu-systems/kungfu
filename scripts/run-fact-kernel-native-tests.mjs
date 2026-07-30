#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function factKernelNativeInvocation({
  platform = process.platform,
  baseEnv = process.env,
} = {}) {
  const core = path.join(ROOT, 'framework', 'core');
  const build = path.join(core, 'build');
  const release = path.join(build, 'Release');
  return {
    command: 'uv',
    args: [
      'run',
      '--project',
      core,
      '--frozen',
      'pytest',
      '-vv',
      path.join(core, 'tests', 'python', 'test_agent_work_profile_native.py'),
      path.join(
        core,
        'tests',
        'python',
        'test_fact_kernel_characterization.py',
      ),
    ],
    env: {
      ...baseEnv,
      KUNGFU_ALLOW_FOREIGN_RUNTIME: '1',
      PYTHONUNBUFFERED: '1',
      PATH: [release, build, baseEnv.PATH].filter(Boolean).join(path.delimiter),
      PYTHONPATH: [
        path.join(core, 'src', 'python'),
        release,
        build,
        baseEnv.PYTHONPATH,
      ]
        .filter(Boolean)
        .join(platform === 'win32' ? ';' : path.delimiter),
    },
    shell: platform === 'win32',
  };
}

export function runFactKernelNativeTests(options = {}) {
  const invocation = factKernelNativeInvocation(options);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: ROOT,
    env: invocation.env,
    shell: invocation.shell,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(runFactKernelNativeTests());
}
