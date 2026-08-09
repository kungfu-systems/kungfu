// SPDX-License-Identifier: Apache-2.0

/**
 * Split dynamic command arguments without reordering them. A single argument
 * larger than the budget remains executable as its own batch.
 *
 * @param {string[]} args
 * @param {number} maxChars
 * @returns {string[][]}
 */
export function commandArgumentBatches(args, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return [args];

  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const arg of args) {
    const argChars = arg.length + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && currentChars + argChars > maxChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(arg);
    currentChars += arg.length + (current.length > 1 ? 1 : 0);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
