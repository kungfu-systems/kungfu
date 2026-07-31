// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { Box, Text, useApp } from 'ink';
import React from 'react';

import { copyTextToClipboard } from '../clipboard/index.js';
import {
  resolveListWindow,
  scrollListSelection,
} from '../list-window/index.js';
import { boundedIndex } from '../navigation.js';
import type { TerminalDimensions } from '../profile-shell.js';
import {
  projectFileTreeIndexAtPoint,
  projectFileTreeLabel,
  projectFileTreeParentIndex,
  readProjectFileTree,
  toggleProjectFileTreeEntry,
} from '../project-file-tree/index.js';
import { terminalCanvasRows } from '../terminal-canvas.js';
import { decodeTerminalMouseInput } from '../terminal-lifecycle.js';

type DimensionSource = {
  get(): TerminalDimensions;
  subscribe(listener: (dimensions: TerminalDimensions) => void): () => void;
};

export function ProjectFilesHost({
  root,
  dimensions,
  workCount,
  isInputCaptured,
  onOpenWork,
  onOpenProjects,
  onOpenLab,
  onWorkspacePointer,
}: {
  root: string;
  dimensions: DimensionSource;
  workCount?: number;
  isInputCaptured: () => boolean;
  onOpenWork: () => void;
  onOpenProjects: () => void;
  onOpenLab: () => void;
  onWorkspacePointer: () => void;
}) {
  const { exit } = useApp();
  const [size, setSize] = React.useState(dimensions.get());
  const [selected, setSelected] = React.useState(0);
  const [expandedPaths, setExpandedPaths] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [message, setMessage] = React.useState(
    'Read-only Project preview · Enter copies a file path.',
  );
  const [copyNotice, setCopyNotice] = React.useState<{
    path: string;
    ok: boolean;
    detail: string;
  }>();
  const canvasRows = terminalCanvasRows(size.rows);
  const navigationWidth = Math.min(
    24,
    Math.max(18, Math.floor(size.columns * 0.2)),
  );
  const treeRows = Math.max(1, canvasRows - 8);
  const entries = React.useMemo(
    () => readProjectFileTree(root, { expandedPaths }),
    [expandedPaths, root],
  );
  const treeWindow = resolveListWindow({
    selected,
    itemCount: entries.length,
    viewportRows: treeRows,
  });
  const visibleEntries = entries.slice(treeWindow.start, treeWindow.end);
  const projectName = path.basename(root) || root;
  const copyPanelWidth = Math.max(20, Math.min(72, size.columns - 6));
  const copyPanelColumns = Math.max(1, copyPanelWidth - 2);
  const copyPanelLine = (value: string) =>
    ` ${value}`.slice(0, copyPanelColumns).padEnd(copyPanelColumns);

  React.useEffect(() => dimensions.subscribe(setSize), [dimensions]);
  React.useEffect(() => {
    setSelected((current) =>
      Math.min(current, Math.max(0, entries.length - 1)),
    );
  }, [entries.length]);
  React.useEffect(() => {
    if (!copyNotice) return;
    const timeout = setTimeout(() => setCopyNotice(undefined), 3500);
    return () => clearTimeout(timeout);
  }, [copyNotice]);

  const activate = React.useCallback(
    (index: number) => {
      const entry = entries[index];
      if (!entry) return;
      if (entry.kind === 'directory') {
        if (!entry.expandable) {
          setMessage(`${entry.name}/ is excluded from recursive preview.`);
          return;
        }
        setExpandedPaths((current) =>
          toggleProjectFileTreeEntry(current, entry),
        );
        setMessage(
          `${entry.name}/ ${entry.collapsed ? 'expanded' : 'collapsed'} in the read-only preview.`,
        );
        return;
      }
      const absolutePath = path.resolve(root, entry.relativePath);
      const receipt = copyTextToClipboard(absolutePath, {
        exec: (file, args, options) =>
          execFileSync(file, args, {
            ...options,
            encoding: 'utf8',
          }),
      });
      setCopyNotice({
        path: absolutePath,
        ok: receipt.ok,
        detail: receipt.ok ? `Copied with ${receipt.method}.` : receipt.error,
      });
      setMessage(
        receipt.ok
          ? 'The selected file path is in the clipboard.'
          : receipt.error,
      );
    },
    [entries, root],
  );

  React.useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      const input = String(chunk);
      const mouseEvents = decodeTerminalMouseInput(input);
      if (mouseEvents.length > 0) {
        for (const event of mouseEvents) {
          if (
            event.kind === 'press' &&
            event.button === 'left' &&
            event.column <= navigationWidth + 2 &&
            event.row === 8
          ) {
            onWorkspacePointer();
            onOpenWork();
            continue;
          }
          const insideTree =
            event.column > navigationWidth + 2 &&
            event.column <= size.columns &&
            event.row >= 5 &&
            event.row <= canvasRows - 1;
          if (!insideTree) continue;
          onWorkspacePointer();
          if (event.kind === 'wheel') {
            const delta = event.button === 'wheel-up' ? -1 : 1;
            setSelected((current) =>
              scrollListSelection({
                current,
                delta,
                itemCount: entries.length,
              }),
            );
            continue;
          }
          if (event.kind !== 'press' || event.button !== 'left') continue;
          const index = projectFileTreeIndexAtPoint({
            column: event.column,
            row: event.row,
            firstColumn: navigationWidth + 3,
            lastColumn: size.columns,
            windowStart: treeWindow.start,
            visibleCount: visibleEntries.length,
            topOffset: 1,
          });
          if (index === null) continue;
          setSelected(index);
          if (entries[index]?.kind === 'directory') activate(index);
        }
        return;
      }
      if (isInputCaptured()) return;
      if (input === 'q' || input === '\u0003') return exit();
      if (input === 'w' || input === 't' || input === '\u001b') {
        return onOpenWork();
      }
      if (input === 'p') return onOpenProjects();
      if (input === 'a') return onOpenLab();
      if (input === 'j' || input === '\u001b[B') {
        setSelected((current) => boundedIndex(current, 1, entries.length));
        return;
      }
      if (input === 'k' || input === '\u001b[A') {
        setSelected((current) => boundedIndex(current, -1, entries.length));
        return;
      }
      const entry = entries[selected];
      if (input === '\r' || input === '\n') return activate(selected);
      if (input === 'l' || input === '\u001b[C') {
        if (entry?.kind === 'directory' && entry.collapsed) {
          activate(selected);
        } else if (entry && entries[selected + 1]?.depth === entry.depth + 1) {
          setSelected(selected + 1);
        }
        return;
      }
      if (input === 'h' || input === '\u001b[D') {
        if (entry?.kind === 'directory' && !entry.collapsed) {
          activate(selected);
        } else {
          setSelected(projectFileTreeParentIndex(entries, selected));
        }
      }
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [
    activate,
    canvasRows,
    entries,
    exit,
    isInputCaptured,
    navigationWidth,
    onOpenLab,
    onOpenProjects,
    onOpenWork,
    onWorkspacePointer,
    selected,
    size.columns,
    treeWindow.start,
    visibleEntries.length,
  ]);

  return (
    <Box
      width={size.columns}
      height={canvasRows}
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      position="relative"
      overflow="hidden"
    >
      <Text bold color="cyan" wrap="truncate-end">
        PROJECT · {projectName}
      </Text>
      <Text dimColor wrap="truncate-end">
        {root}
      </Text>
      <Box flexGrow={1} overflow="hidden">
        <Box
          width={navigationWidth}
          flexDirection="column"
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
        >
          <Text bold>PROJECT</Text>
          <Text bold color="cyan">
            › Files
          </Text>
          <Text>
            {'  '}Work {workCount ?? '…'}
          </Text>
          <Text> </Text>
          <Text dimColor>[w/t/Esc] Work</Text>
          <Text dimColor>[Enter] expand/copy</Text>
        </Box>
        <Box
          flexGrow={1}
          flexDirection="column"
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          overflow="hidden"
        >
          <Text bold color="cyan" wrap="truncate-end">
            FILES · READ ONLY ·{' '}
            {entries.length > visibleEntries.length
              ? `${treeWindow.start + 1}–${treeWindow.end}/${entries.length}`
              : entries.length}
          </Text>
          {visibleEntries.length > 0 ? (
            visibleEntries.map((entry, offset) => {
              const index = treeWindow.start + offset;
              return (
                <Text
                  key={entry.relativePath}
                  color={index === selected ? 'cyan' : undefined}
                  bold={index === selected}
                  wrap="truncate-end"
                >
                  {index === selected ? '› ' : '  '}
                  {projectFileTreeLabel(entry)}
                </Text>
              );
            })
          ) : (
            <Text dimColor>No visible files</Text>
          )}
        </Box>
      </Box>
      <Text dimColor wrap="truncate-end">
        {message} · Files are never opened or edited here.
      </Text>
      {copyNotice ? (
        <Box
          position="absolute"
          width={copyPanelWidth}
          height={5}
          marginTop={Math.max(2, Math.floor((canvasRows - 5) / 2))}
          marginLeft={Math.max(
            2,
            Math.floor((size.columns - copyPanelWidth) / 2),
          )}
          flexDirection="column"
          borderStyle="double"
          borderColor={copyNotice.ok ? 'green' : 'red'}
          overflow="hidden"
        >
          <Text
            bold
            color={copyNotice.ok ? 'black' : 'white'}
            backgroundColor={copyNotice.ok ? 'green' : 'red'}
          >
            {copyPanelLine(
              copyNotice.ok ? 'FILE PATH COPIED' : 'COPY PATH FAILED',
            )}
          </Text>
          <Text color="white" backgroundColor="blue">
            {copyPanelLine(copyNotice.path)}
          </Text>
          <Text color="white" backgroundColor="blue">
            {copyPanelLine(`${copyNotice.detail} · closes in 3.5 seconds`)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
