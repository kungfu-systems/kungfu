// SPDX-License-Identifier: Apache-2.0

export type ListWindow = {
  start: number;
  end: number;
  count: number;
};

export function resolveListWindow({
  selected,
  itemCount,
  viewportRows,
}: {
  selected: number;
  itemCount: number;
  viewportRows: number;
}): ListWindow {
  const count = Math.min(Math.max(0, itemCount), Math.max(1, viewportRows));
  const boundedSelected = Math.max(0, Math.min(itemCount - 1, selected));
  const start = Math.min(
    Math.max(0, boundedSelected - count + 1),
    Math.max(0, itemCount - count),
  );
  return { start, end: start + count, count };
}

export function resolveMeasuredListWindow({
  selected,
  itemCount,
  viewportRows,
  rowCost,
}: {
  selected: number;
  itemCount: number;
  viewportRows: number;
  rowCost: (index: number, start: number) => number;
}): ListWindow {
  if (itemCount <= 0) return { start: 0, end: 0, count: 0 };
  const budget = Math.max(1, viewportRows);
  const boundedSelected = Math.max(0, Math.min(itemCount - 1, selected));
  const earliestStart = Math.max(0, boundedSelected - budget + 1);
  let start = boundedSelected;

  for (
    let candidate = earliestStart;
    candidate <= boundedSelected;
    candidate += 1
  ) {
    let usedRows = 0;
    let end = candidate;
    while (end < itemCount) {
      const cost = Math.max(1, rowCost(end, candidate));
      if (usedRows + cost > budget) break;
      usedRows += cost;
      end += 1;
    }
    if (end > boundedSelected) {
      start = candidate;
      break;
    }
  }

  let usedRows = 0;
  let end = start;
  while (end < itemCount) {
    const cost = Math.max(1, rowCost(end, start));
    if (usedRows + cost > budget) break;
    usedRows += cost;
    end += 1;
  }
  if (end === start) end = Math.min(itemCount, start + 1);
  return { start, end, count: end - start };
}

export function scrollListSelection({
  current,
  delta,
  itemCount,
}: {
  current: number;
  delta: number;
  itemCount: number;
}): number {
  return Math.max(0, Math.min(itemCount - 1, current + delta));
}
