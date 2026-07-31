// SPDX-License-Identifier: Apache-2.0

import { Box, Text } from 'ink';
import React from 'react';

import type { TerminalDimensions } from './profile-shell.js';

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

export function TerminalAnimation({
  pattern,
  dimensions,
  active = true,
  animate = terminalAnimationsEnabled(process.env),
}: {
  pattern: TerminalAnimationPattern;
  dimensions: TerminalDimensions;
  active?: boolean;
  animate?: boolean;
}) {
  const frame = useTerminalAnimationFrame({
    active,
    enabled: animate,
    pattern,
  });
  const patternSize = terminalAnimationPatternSize(dimensions, pattern);
  const cells = pattern.render(frame, patternSize);
  return (
    <Box flexDirection="column" width={patternSize.width}>
      {cells.map((line, row) => (
        <Text key={`${pattern.id}-${row}`}>
          {line.map((cell, column) => (
            <Text key={`${pattern.id}-${row}-${column}`} color={cell.color}>
              {cell.glyph}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

export function TerminalAmbientScene({
  dimensions,
  pattern = KUNGFU_EMPTY_WORK_NEBULA_PATTERN,
  animate,
}: {
  dimensions: TerminalDimensions;
  pattern?: TerminalAnimationPattern;
  animate?: boolean;
}) {
  return (
    <Box
      width={dimensions.columns}
      height={dimensions.rows}
      alignItems="center"
      justifyContent="center"
      overflow="hidden"
    >
      <TerminalAnimation
        pattern={pattern}
        dimensions={dimensions}
        animate={animate}
      />
    </Box>
  );
}

export function TerminalLoadingScene({
  dimensions,
  title,
  status,
  detail,
  pattern = KUNGFU_CIRCULAR_STARTUP_PATTERN,
  animate,
}: {
  dimensions: TerminalDimensions;
  title: string;
  status: string;
  detail?: string;
  pattern?: TerminalAnimationPattern;
  animate?: boolean;
}) {
  const compact = dimensions.columns < 58 || dimensions.rows < 15;
  const animationEnabled = animate ?? terminalAnimationsEnabled(process.env);
  const patternSize = terminalAnimationPatternSize(dimensions, pattern);
  return (
    <Box
      width={dimensions.columns}
      height={dimensions.rows}
      alignItems="center"
      justifyContent="center"
      overflow="hidden"
    >
      <Box flexDirection="row" alignItems="center" gap={compact ? 1 : 3}>
        <TerminalAnimation
          pattern={pattern}
          dimensions={dimensions}
          animate={animationEnabled}
        />
        <Box
          flexDirection="column"
          width={Math.max(
            8,
            Math.min(
              44,
              dimensions.columns - patternSize.width - (compact ? 1 : 3),
            ),
          )}
        >
          <Text bold color="cyan">
            {title}
          </Text>
          <Text>{status}</Text>
          {!compact && detail ? <Text dimColor>{detail}</Text> : null}
          <Text dimColor>
            {animationEnabled ? 'Loading · live' : 'Loading'}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
