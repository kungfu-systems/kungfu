// SPDX-License-Identifier: Apache-2.0

import { Box, Text } from 'ink';
import React from 'react';

type ResizeListener = (...args: unknown[]) => void;

export type WritableTerminal = {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  write: (value: string) => unknown;
  on: (event: 'resize', listener: ResizeListener) => unknown;
  off: (event: 'resize', listener: ResizeListener) => unknown;
};

const CURSOR_HOME = '\u001b[H';
const ERASE_LINE = '\u001b[2K';
export const BEGIN_SYNCHRONIZED_UPDATE = '\u001b[?2026h';
export const END_SYNCHRONIZED_UPDATE = '\u001b[?2026l';

export type IncrementalTerminalOutputOptions = {
  synchronizedOutput?: boolean;
};

export function synchronizedTerminalOutputEnabled(
  env: Record<string, string | undefined>,
): boolean {
  const setting = env.KUNGFU_TUI_SYNCHRONIZED_OUTPUT?.trim().toLowerCase();
  return (
    env.TERM !== 'dumb' &&
    setting !== '0' &&
    setting !== 'false' &&
    setting !== 'off'
  );
}

function isCursorVisibilityOnly(value: string): boolean {
  return (
    value.length > 0 &&
    value.replaceAll('\u001b[?25l', '').replaceAll('\u001b[?25h', '') === ''
  );
}

/**
 * Ink clears the entire terminal whenever rendered output is at least as tall
 * as stdout.rows. The alternate-screen owner keeps one row unused so ordinary
 * state updates can use incremental line erasure instead of a visible full
 * screen flash.
 */
export function terminalCanvasRows(rows: number): number {
  return Math.max(1, rows - 1);
}

type InkColor = React.ComponentProps<typeof Text>['color'];

function clippedBorderText(value: string, width: number): string {
  if (width <= 0) return '';
  if (value.length <= width) return value.padEnd(width);
  if (width === 1) return '…';
  return `${value.slice(0, width - 1)}…`;
}

export function titledBorderWindowLines({
  columns,
  title,
  content,
  paddingX = 1,
}: {
  columns: number;
  title: string;
  content: readonly string[];
  paddingX?: number;
}): string[] {
  const width = Math.max(4, Math.floor(columns));
  const innerWidth = width - 2;
  const horizontalPadding = Math.max(
    0,
    Math.min(Math.floor(paddingX), Math.floor(innerWidth / 2)),
  );
  const contentWidth = Math.max(0, innerWidth - horizontalPadding * 2);
  const titleText = `─ ${title} `;
  const top =
    titleText.length <= innerWidth
      ? `${titleText}${'─'.repeat(innerWidth - titleText.length)}`
      : clippedBorderText(titleText, innerWidth);
  const pad = ' '.repeat(horizontalPadding);
  return [
    `╭${top}╮`,
    ...content.map(
      (row) => `│${pad}${clippedBorderText(row, contentWidth)}${pad}│`,
    ),
    `╰${'─'.repeat(innerWidth)}╯`,
  ];
}

function titledBorderRowKey(row: React.ReactNode, index: number): string {
  const identity =
    React.isValidElement(row) && row.key !== null
      ? String(row.key)
      : typeof row === 'string' || typeof row === 'number'
        ? String(row)
        : 'titled-border-row';
  return `${index}:${identity}`;
}

export function TitledBorderWindow({
  columns,
  title,
  rows,
  borderColor = 'cyan',
  titleColor = borderColor,
  paddingX = 1,
}: {
  columns: number;
  title: string;
  rows: readonly React.ReactNode[];
  borderColor?: InkColor;
  titleColor?: InkColor;
  paddingX?: number;
}): React.ReactElement {
  const width = Math.max(4, Math.floor(columns));
  const innerWidth = width - 2;
  const horizontalPadding = Math.max(
    0,
    Math.min(Math.floor(paddingX), Math.floor(innerWidth / 2)),
  );
  const contentWidth = Math.max(0, innerWidth - horizontalPadding * 2);
  const [top, bottom] = titledBorderWindowLines({
    columns: width,
    title,
    content: [],
    paddingX: horizontalPadding,
  });
  const pad = ' '.repeat(horizontalPadding);
  return React.createElement(
    Box,
    { width, flexDirection: 'column', overflow: 'hidden' },
    React.createElement(
      Text,
      { key: 'top', bold: true, color: titleColor, wrap: 'truncate-end' },
      top,
    ),
    ...rows.map((row, index) =>
      React.createElement(
        Box,
        {
          key: titledBorderRowKey(row, index),
          width,
          height: 1,
          flexDirection: 'row',
          overflow: 'hidden',
        },
        React.createElement(Text, { color: borderColor }, `│${pad}`),
        React.createElement(
          Box,
          { width: contentWidth, height: 1, overflow: 'hidden' },
          typeof row === 'string' || typeof row === 'number'
            ? React.createElement(Text, null, row)
            : row,
        ),
        React.createElement(Text, { color: borderColor }, `${pad}│`),
      ),
    ),
    React.createElement(
      Text,
      { key: 'bottom', color: borderColor, wrap: 'truncate-end' },
      bottom,
    ),
  );
}

export function playbackBorderLines({
  columns,
  label,
  status,
  hint,
}: {
  columns: number;
  label: string;
  status: string;
  hint: string;
}): [string, string, string] {
  return titledBorderWindowLines({
    columns,
    title: `${label}  ▶ ${status}`,
    content: [hint],
  }) as [string, string, string];
}

export function splitHorizontalPointerActionAtPoint<Action extends string>({
  actions,
  column,
  row,
  targetRow,
  width,
  startColumn = 1,
  endPadding = 1,
  gap = 1,
}: {
  actions: readonly { action: Action; label: string }[];
  column: number;
  row: number;
  targetRow: number;
  width: number;
  startColumn?: number;
  endPadding?: number;
  gap?: number;
}): Action | undefined {
  if (
    row !== targetRow ||
    actions.length === 0 ||
    column < startColumn ||
    column > width
  ) {
    return undefined;
  }
  const trailing = actions.at(-1);
  if (!trailing) return undefined;
  const trailingEnd = Math.max(startColumn, width - endPadding);
  const trailingStart = Math.max(
    startColumn,
    trailingEnd - trailing.label.length + 1,
  );
  if (column >= trailingStart && column <= trailingEnd) {
    return trailing.action;
  }

  const leadingEnd = trailingStart - gap - 1;
  let start = startColumn;
  for (const action of actions.slice(0, -1)) {
    const end = Math.min(start + action.label.length - 1, leadingEnd);
    if (end >= start && column >= start && column <= end) {
      return action.action;
    }
    start += action.label.length + gap;
    if (start > leadingEnd) break;
  }
  return undefined;
}

/**
 * Ink's debug renderer exposes each complete frame without log-update's
 * erase-and-repaint cycle. This adapter turns those frames into small terminal
 * patches so stable Session content remains physically untouched.
 */
export class IncrementalTerminalOutput {
  private previousLines: string[] | undefined;

  constructor(
    private readonly terminal: WritableTerminal,
    private readonly options: IncrementalTerminalOutputOptions = {},
  ) {}

  get isTTY(): boolean | undefined {
    return this.terminal.isTTY;
  }

  get columns(): number | undefined {
    return this.terminal.columns;
  }

  get rows(): number | undefined {
    return this.terminal.rows;
  }

  write(value: string): boolean {
    const frame = String(value);
    if (isCursorVisibilityOnly(frame)) {
      return this.terminal.write(frame) !== false;
    }
    const nextLines = frame.split('\n');

    if (this.previousLines === undefined) {
      this.previousLines = nextLines;
      return this.writeFrame(`${CURSOR_HOME}${frame}`);
    }

    const previousLines = this.previousLines;
    const height = Math.max(previousLines.length, nextLines.length);
    let patch = '';
    for (let index = 0; index < height; index += 1) {
      const previous = previousLines[index] ?? '';
      const next = nextLines[index] ?? '';
      if (previous === next) continue;
      patch += `\u001b[${index + 1};1H${ERASE_LINE}${next}`;
    }
    this.previousLines = nextLines;
    return patch ? this.writeFrame(patch) : true;
  }

  private writeFrame(frame: string): boolean {
    const output = this.options.synchronizedOutput
      ? `${BEGIN_SYNCHRONIZED_UPDATE}${frame}${END_SYNCHRONIZED_UPDATE}`
      : frame;
    return this.terminal.write(output) !== false;
  }

  on(event: 'resize', listener: ResizeListener): unknown {
    return this.terminal.on(event, listener);
  }

  off(event: 'resize', listener: ResizeListener): unknown {
    return this.terminal.off(event, listener);
  }
}

export type TerminalDimensions = { columns: number; rows: number };

export type TerminalAnimationCell = {
  glyph: string;
  color?: string;
};

export type TerminalAnimationFrame = TerminalAnimationCell[][];

export type TerminalAnimationSizePolicy = {
  widthRatio: number;
  heightRatio: number;
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  gap?: number;
  maxCellCount?: number;
  minimumTextWidth?: number;
};

export type TerminalAnimationPattern = {
  id: string;
  frameCount: number;
  intervalMs: number;
  sizePolicy?: TerminalAnimationSizePolicy;
  render: (
    frame: number,
    size: { width: number; height: number },
  ) => TerminalAnimationFrame;
};

export type CircularParticlePatternOptions = {
  id: string;
  palette: readonly [string, string, string, string, string];
  intervalMs?: number;
  seed?: number;
};

export type NebulaPatternOptions = {
  id: string;
  palette: readonly [string, string, string, string, string];
  intervalMs?: number;
  seed?: number;
  sizePolicy?: TerminalAnimationSizePolicy;
  variant?: 'drift' | 'spiral';
};

const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);
const DISABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

function normalizedSetting(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

export function terminalAnimationsEnabled(
  env: Record<string, string | undefined>,
): boolean {
  const explicit = normalizedSetting(env.KUNGFU_TUI_ANIMATION);
  if (FALSE_VALUES.has(explicit)) return false;
  if (explicit && !FALSE_VALUES.has(explicit)) return true;
  return !DISABLED_VALUES.has(normalizedSetting(env.NO_ANIMATION));
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function angularDistance(left: number, right: number): number {
  return Math.abs(Math.atan2(Math.sin(left - right), Math.cos(left - right)));
}

function particleNoise(x: number, y: number, seed: number): number {
  const raw = Math.sin((x + seed * 17) * 12.9898 + (y + seed * 31) * 78.233);
  return raw - Math.floor(raw);
}

function gaussianBlob(
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  spreadX: number,
  spreadY: number,
): number {
  return Math.exp(
    -(
      ((x - centerX) * (x - centerX)) / spreadX +
      ((y - centerY) * (y - centerY)) / spreadY
    ),
  );
}

export function createCircularParticlePattern({
  id,
  palette,
  intervalMs = 90,
  seed = 1,
}: CircularParticlePatternOptions): TerminalAnimationPattern {
  return {
    id,
    frameCount: 72,
    intervalMs,
    render(frame, { width, height }) {
      const phase = ((frame % 72) / 72) * Math.PI * 2;
      const centerX = (width - 1) / 2;
      const centerY = (height - 1) / 2;
      const radiusX = Math.max(1, width / 2);
      const radiusY = Math.max(1, height / 2);
      return Array.from({ length: height }, (_, y) =>
        Array.from({ length: width }, (_, x): TerminalAnimationCell => {
          const normalizedX = (x - centerX) / radiusX;
          const normalizedY = (y - centerY) / radiusY;
          const radius = Math.sqrt(
            normalizedX * normalizedX + normalizedY * normalizedY,
          );
          if (radius > 1) return { glyph: ' ' };

          const angle = Math.atan2(normalizedY, normalizedX);
          const orbitHead = Math.exp(
            -((angularDistance(angle, phase) / 0.5) ** 2),
          );
          const counterOrbit = Math.exp(
            -((angularDistance(angle, phase + Math.PI * 1.15) / 0.8) ** 2),
          );
          const radialWave =
            0.5 + 0.5 * Math.sin(phase * 2 - radius * 7 + angle * 2);
          const edge = clamp(1 - Math.abs(radius - 0.78) / 0.34);
          const noise = particleNoise(x, y, seed);
          const intensity = clamp(
            0.08 +
              (1 - radius) * 0.22 +
              radialWave * 0.2 +
              edge * (orbitHead * 0.62 + counterOrbit * 0.25) +
              noise * 0.16,
          );

          if (radius > 0.88 && intensity < 0.22 && noise > 0.45) {
            return { glyph: ' ' };
          }
          const level =
            intensity > 0.78
              ? 4
              : intensity > 0.58
                ? 3
                : intensity > 0.38
                  ? 2
                  : intensity > 0.2
                    ? 1
                    : 0;
          return {
            glyph: ['·', ':', '•', '●', '●'][level] ?? '·',
            color: palette[level],
          };
        }),
      );
    },
  };
}

export const KUNGFU_CIRCULAR_STARTUP_PATTERN = createCircularParticlePattern({
  id: 'kungfu-circular-startup',
  palette: ['#164e63', '#0e7490', '#0891b2', '#22d3ee', '#facc15'],
  seed: 7,
});

export function createNebulaPattern({
  id,
  palette,
  intervalMs = 110,
  seed = 1,
  sizePolicy,
  variant = 'drift',
}: NebulaPatternOptions): TerminalAnimationPattern {
  return {
    id,
    frameCount: 96,
    intervalMs,
    sizePolicy,
    render(frame, { width, height }) {
      const phase = ((frame % 96) / 96) * Math.PI * 2;
      const centerX = (width - 1) / 2;
      const centerY = (height - 1) / 2;
      const radiusX = Math.max(1, width / 2);
      const radiusY = Math.max(1, height / 2);
      return Array.from({ length: height }, (_, y) =>
        Array.from({ length: width }, (_, x): TerminalAnimationCell => {
          const normalizedX = (x - centerX) / radiusX;
          const normalizedY = (y - centerY) / radiusY;
          const noise = particleNoise(x, y, seed);
          const starNoise = particleNoise(x + 41, y + 73, seed + 11);
          const warpedX =
            normalizedX +
            Math.sin(normalizedY * 4.5 + phase) * 0.1 +
            Math.sin(normalizedY * 9 - phase * 0.7) * 0.035;
          const warpedY =
            normalizedY + Math.cos(normalizedX * 3.5 - phase * 0.8) * 0.08;

          const filament =
            (0.5 +
              0.5 *
                Math.sin(warpedX * 7 + warpedY * 5 + phase * 1.4 + noise * 2)) *
            0.12;
          let density: number;
          let threshold: number;
          if (variant === 'spiral') {
            const radius = Math.sqrt(warpedX * warpedX + warpedY * warpedY);
            const angle = Math.atan2(warpedY, warpedX);
            const envelope = Math.exp(-(radius * radius) / 0.62);
            const spiralArms =
              Math.exp(
                -(Math.sin(angle * 2 - radius * 5.2 + phase * 0.28) ** 2) /
                  0.16,
              ) *
              envelope *
              0.54;
            const core = gaussianBlob(warpedX, warpedY, 0, 0, 0.1, 0.11) * 0.74;
            const offCenterVoid =
              gaussianBlob(warpedX, warpedY, 0.12, -0.08, 0.045, 0.055) * 0.38;
            density =
              spiralArms +
              core -
              offCenterVoid +
              filament * 0.65 +
              noise * 0.15;
            threshold = 0.28 + noise * 0.1;
          } else {
            const leadingCloud =
              gaussianBlob(warpedX, warpedY, -0.36, 0.08, 0.24, 0.18) * 0.84;
            const trailingCloud =
              gaussianBlob(warpedX, warpedY, 0.34, 0.18, 0.2, 0.3) * 0.66;
            const crown =
              gaussianBlob(warpedX, warpedY, 0.06, -0.4, 0.18, 0.11) * 0.52;
            const lowerWisp =
              gaussianBlob(warpedX, warpedY, -0.14, 0.46, 0.32, 0.08) * 0.34;
            const darkPocket =
              gaussianBlob(warpedX, warpedY, 0.02, 0.03, 0.11, 0.1) * 0.58;
            const trailingPocket =
              gaussianBlob(warpedX, warpedY, 0.42, 0.14, 0.045, 0.08) * 0.28;
            density =
              leadingCloud +
              trailingCloud +
              crown -
              darkPocket +
              lowerWisp -
              trailingPocket +
              filament +
              noise * 0.13;
            threshold = 0.36 + noise * 0.12;
          }

          if (density < threshold) {
            return starNoise > 0.985
              ? { glyph: '·', color: palette[0] }
              : { glyph: ' ' };
          }

          const intensity = clamp((density - threshold) * 1.75);
          const pulse =
            0.5 +
            0.5 *
              Math.sin(phase * 2.2 + normalizedX * 4 - normalizedY * 3 + noise);
          const level =
            intensity > 0.78 && starNoise > 0.94
              ? 4
              : intensity + pulse * 0.1 > 0.66
                ? 3
                : intensity > 0.4
                  ? 2
                  : intensity > 0.2
                    ? 1
                    : 0;
          return {
            glyph: ['·', ':', '•', '●', '✦'][level] ?? '·',
            color: palette[level],
          };
        }),
      );
    },
  };
}

export const KUNGFU_STARTUP_NEBULA_PATTERN = createNebulaPattern({
  id: 'kungfu-startup-spiral-nebula',
  palette: ['#164e63', '#0e7490', '#0891b2', '#22d3ee', '#facc15'],
  seed: 37,
  variant: 'spiral',
  sizePolicy: {
    widthRatio: 0.5,
    heightRatio: 0.76,
    minWidth: 23,
    maxWidth: 49,
    minHeight: 9,
    maxHeight: 17,
  },
});

export const KUNGFU_PROJECT_DISCOVERY_PATTERN = createNebulaPattern({
  id: 'kungfu-project-discovery-nebula',
  palette: ['#312e81', '#4338ca', '#7c3aed', '#22d3ee', '#facc15'],
  seed: 23,
  sizePolicy: {
    widthRatio: 0.44,
    heightRatio: 0.72,
    minWidth: 21,
    maxWidth: 45,
    minHeight: 9,
    maxHeight: 17,
  },
});

export const KUNGFU_WORK_DISCOVERY_PATTERN = createNebulaPattern({
  id: 'kungfu-work-discovery-nebula',
  palette: ['#164e63', '#0e7490', '#0891b2', '#22d3ee', '#facc15'],
  seed: 71,
  variant: 'drift',
  sizePolicy: {
    widthRatio: 0.48,
    heightRatio: 0.74,
    minWidth: 21,
    maxWidth: 73,
    minHeight: 9,
    maxHeight: 23,
  },
});

export const KUNGFU_EMPTY_WORK_NEBULA_PATTERN = createNebulaPattern({
  id: 'kungfu-empty-work-nebula',
  palette: ['#111827', '#1f2937', '#334155', '#475569', '#64748b'],
  intervalMs: 180,
  seed: 59,
  variant: 'spiral',
  sizePolicy: {
    widthRatio: 0.78,
    heightRatio: 0.78,
    minWidth: 9,
    maxWidth: 201,
    minHeight: 5,
    maxHeight: 51,
    gap: 0,
    maxCellCount: 6000,
    minimumTextWidth: 0,
  },
});

export const KUNGFU_EMPTY_WORK_NAV_NEBULA_PATTERN = createNebulaPattern({
  id: 'kungfu-empty-work-navigation-nebula',
  palette: ['#0f172a', '#172554', '#1e3a5f', '#1d4ed8', '#38bdf8'],
  intervalMs: 210,
  seed: 83,
  variant: 'drift',
  sizePolicy: {
    widthRatio: 0.9,
    heightRatio: 0.66,
    minWidth: 9,
    maxWidth: 23,
    minHeight: 5,
    maxHeight: 17,
    gap: 0,
    minimumTextWidth: 0,
  },
});

export function useTerminalAnimationFrame({
  active,
  enabled,
  pattern,
}: {
  active: boolean;
  enabled: boolean;
  pattern: TerminalAnimationPattern;
}): number {
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    if (!active || !enabled) return undefined;
    const timer = setInterval(
      () => setFrame((current) => (current + 1) % pattern.frameCount),
      pattern.intervalMs,
    );
    return () => clearInterval(timer);
  }, [active, enabled, pattern]);
  return enabled ? frame : 0;
}

function oddSizeAtMost(value: number, maximum: number): number {
  const bounded = Math.max(1, Math.min(Math.round(value), maximum));
  return bounded % 2 === 0 && bounded > 1 ? bounded - 1 : bounded;
}

export function terminalAnimationPatternSize(
  dimensions: TerminalDimensions,
  pattern?: TerminalAnimationPattern,
): {
  width: number;
  height: number;
} {
  const policy = pattern?.sizePolicy;
  if (policy) {
    const compact = dimensions.columns < 58 || dimensions.rows < 15;
    const gap = policy.gap ?? (compact ? 1 : 3);
    const minimumTextWidth =
      policy.minimumTextWidth ?? (dimensions.columns < 40 ? 8 : 16);
    const maximumWidth = Math.max(
      1,
      dimensions.columns - gap - minimumTextWidth,
    );
    const maximumHeight = Math.max(1, dimensions.rows - 1);
    const preferredWidth = Math.max(
      policy.minWidth,
      Math.min(
        policy.maxWidth,
        Math.round(dimensions.columns * policy.widthRatio),
      ),
    );
    const preferredHeight = Math.max(
      policy.minHeight,
      Math.min(
        policy.maxHeight,
        Math.round(dimensions.rows * policy.heightRatio),
      ),
    );
    let width = oddSizeAtMost(preferredWidth, maximumWidth);
    let height = oddSizeAtMost(preferredHeight, maximumHeight);
    if (policy.maxCellCount && width * height > policy.maxCellCount) {
      const scale = Math.sqrt(policy.maxCellCount / (width * height));
      width = oddSizeAtMost(width * scale, width);
      height = oddSizeAtMost(height * scale, height);
    }
    return { width, height };
  }
  if (dimensions.columns < 40 || dimensions.rows < 12) {
    return { width: 9, height: 5 };
  }
  if (dimensions.columns < 58 || dimensions.rows < 15) {
    return { width: 13, height: 7 };
  }
  return { width: 21, height: 11 };
}
