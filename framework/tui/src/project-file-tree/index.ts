// SPDX-License-Identifier: Apache-2.0

export {
  type ProjectFileTreeEntry,
  projectFileTreeLabel,
  projectFileTreeParentIndex,
  readProjectFileTree,
  toggleProjectFileTreeEntry,
} from '@kungfu-tech/api/capability';

export function projectFileTreeIndexAtPoint({
  column,
  row,
  firstColumn,
  lastColumn,
  windowStart,
  visibleCount,
  topOffset = 0,
}: {
  column: number;
  row: number;
  firstColumn: number;
  lastColumn: number;
  windowStart: number;
  visibleCount: number;
  topOffset?: number;
}): number | null {
  if (column < firstColumn || column > lastColumn) return null;
  const offset = row - (topOffset + 6);
  if (offset < 0 || offset >= visibleCount) return null;
  return windowStart + offset;
}
