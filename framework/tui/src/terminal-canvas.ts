// SPDX-License-Identifier: Apache-2.0

/**
 * Ink clears the entire terminal whenever rendered output is at least as tall
 * as stdout.rows. The alternate-screen owner keeps one row unused so ordinary
 * state updates can use incremental line erasure instead of a visible full
 * screen flash.
 */
export function terminalCanvasRows(rows: number): number {
  return Math.max(1, rows - 1);
}
