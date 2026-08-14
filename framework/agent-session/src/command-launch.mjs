// SPDX-License-Identifier: Apache-2.0

const WINDOWS_COMMAND_WRAPPER = /\.(?:cmd|bat)$/iu;
const UNSAFE_COMMAND_TEXT = /[\0\r\n%]/u;

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function quoteWindowsCommandToken(value) {
  const text = requireText(value, 'Windows command token');
  if (UNSAFE_COMMAND_TEXT.test(text)) {
    throw new Error(
      'Windows command-wrapper launch contains text that cmd.exe could expand',
    );
  }
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * Convert an exact executable plus argv into the OS process boundary.
 *
 * Windows command wrappers are scripts, not CreateProcess executables. Keep
 * the wrapper itself as the reviewed Agent identity, but route only .cmd/.bat
 * through an explicit cmd.exe invocation. Provider names and versions never
 * participate in this decision.
 */
export function commandLaunchSpec({
  executable,
  argv,
  env = {},
  platform = process.platform,
  processEnv = process.env,
}) {
  requireText(executable, 'executable');
  if (
    !Array.isArray(argv) ||
    !argv.every((entry) => typeof entry === 'string')
  ) {
    throw new Error('argv must be an array of strings');
  }
  if (platform !== 'win32' || !WINDOWS_COMMAND_WRAPPER.test(executable)) {
    return {
      executable,
      argv: [...argv],
      commandWrapper: false,
      windowsVerbatimArguments: false,
    };
  }
  const comspec =
    env.ComSpec ??
    env.COMSPEC ??
    processEnv.ComSpec ??
    processEnv.COMSPEC ??
    'cmd.exe';
  requireText(comspec, 'ComSpec');
  const payload = `call ${[executable, ...argv]
    .map(quoteWindowsCommandToken)
    .join(' ')}`;
  return {
    executable: comspec,
    argv: ['/d', '/s', '/v:off', '/c', payload],
    commandWrapper: true,
    windowsVerbatimArguments: true,
  };
}
