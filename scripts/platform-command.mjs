// SPDX-License-Identifier: Apache-2.0

const WINDOWS_SHIMS = new Set(['npm', 'npx', 'pnpm']);

export function platformCommand(command, platform = process.platform) {
  return platform === 'win32' && WINDOWS_SHIMS.has(command)
    ? `${command}.cmd`
    : command;
}

export function platformCommandOptions(command, platform = process.platform) {
  return {
    shell: platform === 'win32' && WINDOWS_SHIMS.has(command),
  };
}

export function prependEnvironmentPath(
  environment,
  directory,
  platform = process.platform,
) {
  const result = { ...environment };
  const key =
    platform === 'win32'
      ? Object.keys(result).find((name) => name.toLowerCase() === 'path') ||
        'Path'
      : 'PATH';
  result[key] = [directory, result[key]]
    .filter(Boolean)
    .join(platform === 'win32' ? ';' : ':');
  return result;
}
