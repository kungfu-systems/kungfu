// Window placement for per-session OS windows (KF-ADR-019f86da-4f90-7153-a6c1-ab7a0a3cf481 stage 2, F7). Pure
// geometry: it decides which currently-visible display a saved window belongs
// on and clamps its rectangle into that display's usable area. No electron
// import — the caller (session-windows) turns Electron `screen` displays into
// the abstract DisplayInfo below and applies the result — so this stays a
// contract-testable pure module, the same split terminal-host uses.
//
// F7 in one sentence: a window whose saved display is gone falls back to the
// primary, and an off-screen window is pulled back onto a visible display —
// realized here because we always resolve a present target display and then
// clamp the saved bounds into its work area, so a stale off-screen origin can
// never survive.

export type Rect = { x: number; y: number; width: number; height: number };

// A display as this module needs it: a stable identity plus the usable area
// (Electron's workArea excludes the menu bar / dock, so a restored window never
// lands under them). The caller derives `id` with displayKey below.
export type DisplayInfo = { id: string; workArea: Rect };

// A stable display identifier (F7). Electron's numeric Display.id is not stable
// across reconnects/reboots, so we prefer the human label (e.g. "Built-in Retina
// Display") and fall back to the physical bounds signature, which stays the same
// for the same monitor at the same resolution/position. The numeric id is the
// last resort so the key is always non-empty. Kept pure (takes only the fields
// it reads) so both the glue and any check can call it.
export function displayKey(display: {
  label?: string;
  id?: number;
  bounds: Rect;
}): string {
  const label = display.label?.trim();
  if (label) return `label:${label}`;
  const b = display.bounds;
  return `bounds:${b.x},${b.y},${b.width},${b.height}`;
}

function clampRange(value: number, min: number, max: number): number {
  // max can fall below min when the window is wider/taller than the work area;
  // in that case we already shrank the size to fit, so min wins (top-left align).
  if (max < min) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// Shrink to fit, then move fully inside: a window larger than the work area is
// capped to it, and its origin is pulled in so the whole rectangle is visible.
export function clampToWorkArea(bounds: Rect, workArea: Rect): Rect {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  const x = clampRange(
    bounds.x,
    workArea.x,
    workArea.x + workArea.width - width,
  );
  const y = clampRange(
    bounds.y,
    workArea.y,
    workArea.y + workArea.height - height,
  );
  return { x, y, width, height };
}

// Center a default-sized rectangle in a work area, for a brand-new pop-out
// window that has no saved placement. Shrinks to fit a small work area.
export function centeredBounds(
  workArea: Rect,
  width: number,
  height: number,
): Rect {
  const w = Math.min(width, workArea.width);
  const h = Math.min(height, workArea.height);
  return {
    x: Math.round(workArea.x + (workArea.width - w) / 2),
    y: Math.round(workArea.y + (workArea.height - h) / 2),
    width: w,
    height: h,
  };
}

export type Placement = { displayId: string; bounds: Rect };

// Place a saved window onto a currently-connected display (F7):
//   - saved display present  → clamp the saved bounds into its work area;
//   - saved display gone      → fall back to the primary, clamp into it;
//   - no displays at all      → return the saved placement unchanged (headless;
//                               a real machine always has at least one display).
// The returned displayId is the display the window actually landed on, so the
// caller persists the resolved identity, not the stale saved one.
export function placeWindow(
  saved: Placement,
  displays: DisplayInfo[],
  primaryId: string,
): Placement {
  if (displays.length === 0) return saved;
  const target =
    displays.find((d) => d.id === saved.displayId) ??
    displays.find((d) => d.id === primaryId) ??
    displays[0];
  return {
    displayId: target.id,
    bounds: clampToWorkArea(saved.bounds, target.workArea),
  };
}
