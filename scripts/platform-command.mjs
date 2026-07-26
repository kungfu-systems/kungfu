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

export function pythonCommand(
  platform = process.platform,
  configured = process.env.PYTHON,
) {
  return configured || (platform === 'win32' ? 'uv' : 'python3');
}

export function pythonCommandArgs(
  args,
  {
    platform = process.platform,
    configured = process.env.PYTHON,
    project = '',
  } = {},
) {
  if (platform !== 'win32' || configured) return args;
  if (!project)
    throw new Error(
      'a pinned uv project is required for the Windows Python command',
    );
  return ['run', '--project', project, '--frozen', 'python', ...args];
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
