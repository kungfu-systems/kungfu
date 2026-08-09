// SPDX-License-Identifier: Apache-2.0

/**
 * Node concatenates argv without quoting when a Windows batch file is spawned
 * through `shell: true`. Quote each batch argument so paths and task text stay
 * one argv item at the source-bound Xinfa entry.
 *
 * @param {string} binary
 * @param {string[]} args
 * @param {NodeJS.Platform} [platform]
 */
export function sourceCommandArguments(
  binary,
  args,
  platform = process.platform,
) {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(binary)) return args;
  return args.map((argument) => `"${argument.replaceAll('"', '\\"')}"`);
}
