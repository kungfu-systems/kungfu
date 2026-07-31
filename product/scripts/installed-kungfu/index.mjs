// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import path from 'node:path';

function exitLabel(status, signal) {
  return status == null ? `signal ${signal}` : String(status);
}

export function installedKungfuInvocation(
  kungfuBin,
  args,
  { platform = process.platform, comspec = process.env.ComSpec } = {},
) {
  if (platform !== 'win32') return { command: kungfuBin, args };
  return {
    command: comspec || 'cmd.exe',
    args: ['/d', '/s', '/c', 'call', kungfuBin, ...args],
  };
}

export function runInstalledKungfuCommand(
  { cli, args, env, cwd },
  {
    platform = process.platform,
    comspec = process.env.ComSpec,
    spawn = spawnSync,
  } = {},
) {
  const invocation = installedKungfuInvocation(cli, args, {
    platform,
    comspec,
  });
  const result = spawn(invocation.command, invocation.args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
  if (result.error) throw result.error;
  return result;
}

export function spawnInstalledKungfu(kungfuBin, args, options) {
  const invocation = installedKungfuInvocation(kungfuBin, args);
  return spawnSync(invocation.command, invocation.args, {
    ...options,
    shell: false,
  });
}

export function runInstalledTuiBootstrapSmoke(
  {
    installRoot,
    kungfuBin,
    runtimeEntry,
    tuiEntry,
    env,
    home = path.join(installRoot, '.tui-qualification-home'),
  },
  { spawn = spawnInstalledKungfu } = {},
) {
  const result = spawn(kungfuBin, [tuiEntry, '--agent-work-lab-demo'], {
    cwd: installRoot,
    env: {
      ...env,
      KUNGFU_AS_VARIANT: 'node',
      KUNGFU_DIR: path.dirname(runtimeEntry),
      KUNGFU_TUI_ENTRY: tuiEntry,
      KF_HOME: home,
      KF_RUNTIME_DIR: path.join(home, 'runtime'),
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `installed TUI bootstrap failed (exit ${exitLabel(result.status, result.signal)})`,
        result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : '',
        result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  if (
    !(result.stdout || '').includes(
      '"schema":"kungfu.agent-work-lab.report/v1"',
    )
  ) {
    throw new Error(
      'installed TUI bootstrap did not return the Agent Work Lab report',
    );
  }
}
