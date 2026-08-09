export type PaneLayoutMode =
  | 'single'
  | 'columns-2'
  | 'rows-2'
  | 'columns-3'
  | 'rows-3';

export type PaneLayoutAxis = 'columns' | 'rows';

export const DEFAULT_PANE_LAYOUT: PaneLayoutMode = 'single';

export function paneCountForLayout(mode: PaneLayoutMode): 1 | 2 | 3 {
  if (mode.endsWith('-3')) return 3;
  if (mode.endsWith('-2')) return 2;
  return 1;
}

export function paneAxisForLayout(mode: PaneLayoutMode): PaneLayoutAxis {
  return mode.startsWith('rows') ? 'rows' : 'columns';
}

export function normalizePaneSizes(
  sizes: readonly number[],
  count: number,
): number[] {
  if (count <= 0) return [];
  const usable =
    sizes.length === count &&
    sizes.every((value) => value > 0 && Number.isFinite(value))
      ? [...sizes]
      : Array.from({ length: count }, () => 1);
  const total = usable.reduce((sum, value) => sum + value, 0);
  return usable.map((value) => value / total);
}

export function resizeAdjacentPanes(
  sizes: readonly number[],
  dividerIndex: number,
  deltaRatio: number,
  minimumRatio: number,
): number[] {
  const normalized = normalizePaneSizes(sizes, sizes.length);
  if (
    dividerIndex < 0 ||
    dividerIndex >= normalized.length - 1 ||
    !Number.isFinite(deltaRatio)
  ) {
    return normalized;
  }

  const pairTotal = normalized[dividerIndex] + normalized[dividerIndex + 1];
  const safeMinimum = Math.max(0, Math.min(minimumRatio, pairTotal / 2));
  const nextLeft = Math.max(
    safeMinimum,
    Math.min(pairTotal - safeMinimum, normalized[dividerIndex] + deltaRatio),
  );
  const next = [...normalized];
  next[dividerIndex] = nextLeft;
  next[dividerIndex + 1] = pairTotal - nextLeft;
  return next;
}
