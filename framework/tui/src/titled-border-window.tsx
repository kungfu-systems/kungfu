// SPDX-License-Identifier: Apache-2.0

import { Box, Text } from 'ink';
import { isValidElement } from 'react';
import type { ComponentProps, ReactNode } from 'react';

type InkColor = ComponentProps<typeof Text>['color'];

function clipped(value: string, width: number): string {
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
      : clipped(titleText, innerWidth);
  const pad = ' '.repeat(horizontalPadding);
  return [
    `╭${top}╮`,
    ...content.map((row) => `│${pad}${clipped(row, contentWidth)}${pad}│`),
    `╰${'─'.repeat(innerWidth)}╯`,
  ];
}

function rowKey(row: ReactNode, index: number): string {
  const identity =
    isValidElement(row) && row.key !== null
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
  rows: readonly ReactNode[];
  borderColor?: InkColor;
  titleColor?: InkColor;
  paddingX?: number;
}) {
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
  return (
    <Box width={width} flexDirection="column" overflow="hidden">
      <Text bold color={titleColor} wrap="truncate-end">
        {top}
      </Text>
      {rows.map((row, index) => {
        const content =
          typeof row === 'string' || typeof row === 'number' ? (
            <Text>{row}</Text>
          ) : (
            row
          );
        return (
          <Box
            key={rowKey(row, index)}
            width={width}
            height={1}
            flexDirection="row"
            overflow="hidden"
          >
            <Text color={borderColor}>│{pad}</Text>
            <Box width={contentWidth} height={1} overflow="hidden">
              {content}
            </Box>
            <Text color={borderColor}>{pad}│</Text>
          </Box>
        );
      })}
      <Text color={borderColor} wrap="truncate-end">
        {bottom}
      </Text>
    </Box>
  );
}
