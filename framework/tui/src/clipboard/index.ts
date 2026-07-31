// SPDX-License-Identifier: Apache-2.0

export type ClipboardReceipt =
  | { ok: true; method: string }
  | { ok: false; error: string };

type ClipboardExec = (
  file: string,
  args: string[],
  options: {
    input: string;
    stdio: ['pipe', 'ignore', 'ignore'];
  },
) => unknown;

function clipboardCommands(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Array<{ file: string; args: string[]; method: string }> {
  if (platform === 'darwin') {
    return [{ file: '/usr/bin/pbcopy', args: [], method: 'pbcopy' }];
  }
  if (platform === 'win32') {
    return [{ file: 'clip.exe', args: [], method: 'Windows clipboard' }];
  }
  if (platform === 'linux') {
    return [
      ...(env.WAYLAND_DISPLAY
        ? [{ file: 'wl-copy', args: [], method: 'Wayland clipboard' }]
        : []),
      {
        file: 'xclip',
        args: ['-selection', 'clipboard'],
        method: 'X11 clipboard',
      },
      {
        file: 'xsel',
        args: ['--clipboard', '--input'],
        method: 'X11 clipboard',
      },
    ];
  }
  return [];
}

export function copyTextToClipboard(
  value: string,
  {
    platform = process.platform,
    env = process.env,
    exec,
  }: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    exec: ClipboardExec;
  },
): ClipboardReceipt {
  const commands = clipboardCommands(platform, env);
  for (const command of commands) {
    try {
      exec(command.file, command.args, {
        input: value,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      return { ok: true, method: command.method };
    } catch {
      // Try the next platform-native clipboard command.
    }
  }
  return {
    ok: false,
    error:
      commands.length > 0
        ? 'No supported clipboard command is available.'
        : `Clipboard copy is not supported on ${platform}.`,
  };
}
