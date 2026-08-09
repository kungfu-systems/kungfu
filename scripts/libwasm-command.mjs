// SPDX-License-Identifier: Apache-2.0

import { cmdCommand } from './run-shifu-lifecycle.mjs';

export function spawnSpecification(
  command,
  args,
  platform = process.platform,
  env = process.env,
) {
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    return {
      command: cmdCommand(command, args),
      args: [],
      shell: env.ComSpec || env.COMSPEC || 'cmd.exe',
    };
  }
  return { command, args, shell: undefined };
}

export function selectCommandPath(output, platform = process.platform) {
  const candidates = output.trim().split(/\r?\n/).filter(Boolean);
  if (platform === 'win32') {
    return (
      candidates.find((candidate) => /\.(?:exe|cmd|bat)$/i.test(candidate)) ||
      candidates[0]
    );
  }
  return candidates[0];
}
