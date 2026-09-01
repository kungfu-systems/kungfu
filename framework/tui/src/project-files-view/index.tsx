// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { Box, Text, useApp } from 'ink';
import React from 'react';

import {
  type ClipboardReceipt,
  copyTextToClipboard,
} from '../clipboard/index.js';
import {
  resolveListWindow,
  scrollListSelection,
} from '../list-window/index.js';
import { boundedIndex } from '../navigation.js';
import type { TerminalDimensions } from '../profile-shell.js';
import {
  KUNGFU_EMPTY_WORK_NAV_NEBULA_PATTERN,
  KUNGFU_PROJECT_DISCOVERY_PATTERN,
  TerminalAmbientScene,
} from '../profile-shell.js';
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

export type ProjectNavigationTab = 'work' | 'files';

export type ProjectPathCopyNotice = {
  path: string;
  ok: boolean;
  detail: string;
};

export function projectPathCopyNotice(
  absolutePath: string,
  receipt: ClipboardReceipt,
): ProjectPathCopyNotice {
  return {
    path: absolutePath,
    ok: receipt.ok,
    detail: receipt.ok ? `Copied with ${receipt.method}.` : receipt.error,
  };
}

export function ProjectPathCopyOverlay({
  notice,
  dimensions,
}: {
  notice: ProjectPathCopyNotice;
  dimensions: TerminalDimensions;
}) {
  const canvasRows = terminalCanvasRows(dimensions.rows);
  const panelWidth = Math.max(12, Math.min(72, dimensions.columns - 4));
  const panelColumns = Math.max(1, panelWidth - 2);
  const panelLine = (value: string) =>
    ` ${value}`.slice(0, panelColumns).padEnd(panelColumns);
  return (
    <Box
      position="absolute"
      width={panelWidth}
      height={5}
      marginTop={Math.max(1, Math.floor((canvasRows - 5) / 2))}
      marginLeft={Math.max(
        1,
        Math.floor((dimensions.columns - panelWidth) / 2),
      )}
      flexDirection="column"
      borderStyle="double"
      borderColor={notice.ok ? 'green' : 'red'}
      overflow="hidden"
    >
      <Text
        bold
        color={notice.ok ? 'black' : 'white'}
        backgroundColor={notice.ok ? 'green' : 'red'}
      >
        {panelLine(notice.ok ? 'FILE PATH COPIED' : 'COPY PATH FAILED')}
      </Text>
      <Text color="white" backgroundColor="blue">
        {panelLine(notice.path)}
      </Text>
      <Text color="white" backgroundColor="blue">
        {panelLine(`${notice.detail} · closes in 3.5 seconds`)}
      </Text>
    </Box>
  );
}

export function projectNavigationWidth(dimensions: TerminalDimensions): number {
  return Math.min(28, Math.max(22, Math.floor(dimensions.columns * 0.22)));
}

export function projectWorkAmbientRows(dimensions: TerminalDimensions): number {
  return Math.max(5, terminalCanvasRows(dimensions.rows) - 12);
}

export function projectNavigationTabLabels({
  navigationWidth,
  workCount,
}: {
  navigationWidth: number;
  workCount?: number;
}): {
  work: string;
  files: string;
  workWidth: number;
  filesWidth: number;
} {
  const contentWidth = Math.max(2, navigationWidth - 4);
  const filesWidth = Math.floor(contentWidth / 2);
  const workWidth = contentWidth - filesWidth;
  const boundedCount =
    workCount === undefined ? '…' : workCount > 99 ? '99+' : String(workCount);
  const fit = (value: string, width: number) =>
    ` ${value} `.slice(0, width).padEnd(width);
  return {
    work: fit(`Work ${boundedCount}`, workWidth),
    files: fit('Files', filesWidth),
    workWidth,
    filesWidth,
  };
}

export function projectNavigationTabAtPoint({
  column,
  row,
  topOffset,
  navigationWidth,
}: {
  column: number;
  row: number;
  topOffset: number;
  navigationWidth: number;
}): ProjectNavigationTab | null {
  if (row !== topOffset + 1) return null;
  const contentColumn = column - 3;
  const contentWidth = Math.max(2, navigationWidth - 4);
  if (contentColumn < 0 || contentColumn >= contentWidth) return null;
  return contentColumn < Math.floor(contentWidth / 2) ? 'files' : 'work';
}

function ProjectNavigationTabs({
  active,
  navigationWidth,
  workCount,
}: {
  active: ProjectNavigationTab;
  navigationWidth: number;
  workCount?: number;
}) {
  const labels = projectNavigationTabLabels({
    navigationWidth,
    workCount,
  });
  return (
    <Box flexDirection="row">
      <Text
        bold
        color={active === 'files' ? 'black' : 'gray'}
        backgroundColor={active === 'files' ? 'cyan' : undefined}
      >
        {labels.files}
      </Text>
      <Text
        bold
        color={active === 'work' ? 'black' : 'gray'}
        backgroundColor={active === 'work' ? 'cyan' : undefined}
      >
        {labels.work}
      </Text>
    </Box>
  );
}

export function ProjectFileTreeNavigation({
  root,
  dimensions,
  workCount,
  focused,
  isInputCaptured,
  onFocus,
  onOpenWork,
  onOpenProjects,
  onOpenLab,
  onWorkspacePointer,
  onCopyNotice,
  topOffset = 3,
}: {
  root: string;
  dimensions: DimensionSource;
  workCount?: number;
  focused: boolean;
  isInputCaptured: () => boolean;
  onFocus: () => void;
  onOpenWork: () => void;
  onOpenProjects: () => void;
  onOpenLab: () => void;
  onWorkspacePointer: () => void;
  onCopyNotice: (notice: ProjectPathCopyNotice) => void;
  topOffset?: number;
}) {
  const { exit } = useApp();
  const [size, setSize] = React.useState(dimensions.get());
  const [selected, setSelected] = React.useState(0);
  const [expandedPaths, setExpandedPaths] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [message, setMessage] = React.useState(
    'Enter expands a folder or copies a file path.',
  );
  const navigationWidth = projectNavigationWidth(size);
  const entries = React.useMemo(
    () => readProjectFileTree(root, { expandedPaths }),
    [expandedPaths, root],
  );
  const treeRows = Math.max(3, terminalCanvasRows(size.rows) - 11);
  const treeWindow = resolveListWindow({
    selected,
    itemCount: entries.length,
    viewportRows: treeRows,
  });
  const visibleEntries = entries.slice(treeWindow.start, treeWindow.end);

  React.useEffect(() => dimensions.subscribe(setSize), [dimensions]);
  React.useEffect(() => {
    setSelected((current) =>
      Math.min(current, Math.max(0, entries.length - 1)),
    );
  }, [entries.length]);

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
          `${entry.name}/ ${entry.collapsed ? 'expanded' : 'collapsed'}.`,
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
      onCopyNotice(projectPathCopyNotice(absolutePath, receipt));
      setMessage(
        receipt.ok
          ? `Copied · ${entry.name}`
          : `Copy failed · ${receipt.error}`,
      );
    },
    [entries, onCopyNotice, root],
  );

  const handleProjectFileMouse = React.useCallback(
    (mouseEvents: ReturnType<typeof decodeTerminalMouseInput>) => {
      for (const event of mouseEvents) {
        if (
          event.column < 1 ||
          event.column > navigationWidth + 2 ||
          event.row < topOffset ||
          event.row > terminalCanvasRows(size.rows)
        ) {
          continue;
        }
        onWorkspacePointer();
        const tab = projectNavigationTabAtPoint({
          column: event.column,
          row: event.row,
          topOffset,
          navigationWidth,
        });
        if (tab) {
          if (event.kind === 'press' && event.button === 'left') {
            if (tab === 'work') onOpenWork();
            else onFocus();
          }
          continue;
        }
        if (!focused) continue;
        onFocus();
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
        const rangeVisible = entries.length > visibleEntries.length;
        const firstTreeRow = topOffset + 2 + (rangeVisible ? 1 : 0);
        const offset = event.row - firstTreeRow;
        if (offset < 0 || offset >= visibleEntries.length) continue;
        const index = treeWindow.start + offset;
        setSelected(index);
        if (entries[index]?.kind === 'directory') activate(index);
      }
    },
    [
      activate,
      entries,
      focused,
      navigationWidth,
      onFocus,
      onOpenWork,
      onWorkspacePointer,
      size.rows,
      topOffset,
      treeWindow.start,
      visibleEntries.length,
    ],
  );
  const handleProjectFileKeyboard = React.useCallback(
    (input: string) => {
      if (!focused || isInputCaptured()) return;
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
    },
    [
      activate,
      entries,
      exit,
      focused,
      isInputCaptured,
      onOpenLab,
      onOpenProjects,
      onOpenWork,
      selected,
    ],
  );
  React.useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      const input = String(chunk);
      const mouseEvents = decodeTerminalMouseInput(input);
      if (mouseEvents.length > 0) {
        handleProjectFileMouse(mouseEvents);
        return;
      }
      handleProjectFileKeyboard(input);
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [handleProjectFileKeyboard, handleProjectFileMouse]);

  return (
    <Box
      width={navigationWidth}
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? 'cyan' : undefined}
      paddingX={1}
      flexShrink={0}
      overflow="hidden"
    >
      <ProjectNavigationTabs
        active={focused ? 'files' : 'work'}
        navigationWidth={navigationWidth}
        workCount={workCount}
      />
      {focused ? (
        <>
          {entries.length > visibleEntries.length ? (
            <Text dimColor>
              {treeWindow.start + 1}–{treeWindow.end}/{entries.length}
            </Text>
          ) : null}
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
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
                    {index === selected ? '›' : ' '}
                    {projectFileTreeLabel(entry)}
                  </Text>
                );
              })
            ) : (
              <Text dimColor>No visible files</Text>
            )}
          </Box>
          <Text dimColor wrap="truncate-end">
            {message}
          </Text>
        </>
      ) : (
        <>
          <Box flexGrow={1} alignItems="center" justifyContent="center">
            {workCount === undefined || workCount === 0 ? (
              <TerminalAmbientScene
                dimensions={{
                  columns: Math.max(1, navigationWidth - 4),
                  rows: projectWorkAmbientRows(size),
                }}
                pattern={
                  workCount === undefined
                    ? KUNGFU_PROJECT_DISCOVERY_PATTERN
                    : KUNGFU_EMPTY_WORK_NAV_NEBULA_PATTERN
                }
              />
            ) : (
              <Box flexDirection="column" alignItems="center">
                <Text bold color="cyan">
                  {workCount}
                </Text>
                <Text dimColor>retained Work</Text>
              </Box>
            )}
          </Box>
          <Text dimColor wrap="truncate-end">
            {workCount === undefined
              ? 'Discovering Work…'
              : workCount === 0
                ? 'No retained Work'
                : 'Work opens in the main panel'}
          </Text>
        </>
      )}
    </Box>
  );
}

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
