// SPDX-License-Identifier: Apache-2.0

export type ShellKey =
  | 'quit'
  | 'refresh'
  | 'next-card'
  | 'previous-card'
  | 'next-subject'
  | 'previous-subject'
  | 'next-region'
  | 'previous-region'
  | 'none';

export function decodeShellKey(input: string): ShellKey {
  if (input === 'q' || input === '\u0003' || input === '\u001b') return 'quit';
  if (input === 'r') return 'refresh';
  if (input === 'j' || input === '\u001b[B') return 'next-card';
  if (input === 'k' || input === '\u001b[A') return 'previous-card';
  if (input === 'l' || input === '\u001b[C') return 'next-subject';
  if (input === 'h' || input === '\u001b[D') return 'previous-subject';
  if (input === '\t') return 'next-region';
  if (input === '\u001b[Z') return 'previous-region';
  return 'none';
}

export function boundedIndex(
  current: number,
  delta: number,
  length: number,
): number {
  if (length <= 0) return 0;
  return (current + delta + length) % length;
}
