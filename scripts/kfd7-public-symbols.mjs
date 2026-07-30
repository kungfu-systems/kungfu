// SPDX-License-Identifier: Apache-2.0

export function parseDumpbinExports(output) {
  return output
    .split('\n')
    .map(
      (line) =>
        line.trim().match(/^\d+\s+[0-9A-F]+\s+[0-9A-F]+\s+(\S+)(?:\s|$)/i)?.[1],
    )
    .filter(Boolean);
}
