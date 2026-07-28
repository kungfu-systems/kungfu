// SPDX-License-Identifier: Apache-2.0

import type {
  ProductSearchDocument,
  ProductSearchResult,
} from '@kungfu-tech/api/capability';
import { Box, Text } from 'ink';
import React from 'react';
import { boundedIndex } from './navigation.js';
import { terminalCanvasRows } from './terminal-canvas.js';
import type { WorkLoopShellModel } from './work-loop-contribution.js';

export type TerminalDimensions = { columns: number; rows: number };

export type ProfileShellCard = {
  id: string;
  title: string;
  status: string;
  summary: string;
};

export type ProfileShellModel = {
  profile: {
    id: string;
    title: string;
    version: string;
    suiteRoot: string;
    qualified: boolean;
    qualificationLabel?: string;
  };
  subject: { id: string; title: string; subtitle: string };
  navigation: Array<{ id: string; label: string; status: string }>;
  cards: ProfileShellCard[];
  evidence: Array<{ label: string; value: string }>;
  workLoop?: WorkLoopShellModel;
  workLoopError?: string;
  notice?: string;
};

export type ProfileShellLayout = {
  mode: 'one-column' | 'two-column' | 'three-column';
  navigationWidth: number;
  evidenceWidth: number;
};

export function resolveProfileShellLayout(
  dimensions: TerminalDimensions,
): ProfileShellLayout {
  if (dimensions.columns >= 140 && dimensions.rows >= 32) {
    return { mode: 'three-column', navigationWidth: 24, evidenceWidth: 38 };
  }
  if (dimensions.columns >= 100 && dimensions.rows >= 28) {
    return { mode: 'two-column', navigationWidth: 28, evidenceWidth: 0 };
  }
  return { mode: 'one-column', navigationWidth: 0, evidenceWidth: 0 };
}

function shortRoot(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 7)}…${value.slice(-10)}`;
}

function qualificationState(model: ProfileShellModel): string {
  if ((model.profile.qualificationLabel ?? 'KFD-3') === 'KFD-3') {
    return model.profile.qualified ? 'qualified' : 'not qualified';
  }
  return model.profile.qualified ? 'verified' : 'not verified';
}

function NavigationPanel({
  model,
  active,
}: { model: ProfileShellModel; active: boolean }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={active ? 'cyan' : undefined}
      paddingX={1}
      flexGrow={1}
    >
      <Text bold>Subjects</Text>
      {model.navigation.length === 0 ? (
        <Text dimColor>none admitted</Text>
      ) : null}
      {model.navigation.map((item) => (
        <Text
          key={item.id}
          color={item.id === model.subject.id ? 'cyan' : undefined}
        >
          {item.id === model.subject.id ? '› ' : '  '}
          {item.label} <Text dimColor>{item.status}</Text>
        </Text>
      ))}
    </Box>
  );
}

function CardPanel({
  model,
  selectedCard,
  active,
  maxRows,
}: {
  model: ProfileShellModel;
  selectedCard: number;
  active: boolean;
  maxRows: number;
}) {
  const visibleCount = Math.max(1, Math.floor((maxRows - 8) / 2));
  const start = Math.min(
    Math.max(0, selectedCard - visibleCount + 1),
    Math.max(0, model.cards.length - visibleCount),
  );
  const visibleCards = model.cards.slice(start, start + visibleCount);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={active ? 'cyan' : undefined}
      paddingX={1}
      flexGrow={1}
    >
      <Text bold>{model.subject.title}</Text>
      <Text dimColor>{model.subject.subtitle}</Text>
      {model.cards.length === 0 ? (
        <Text color="yellow">
          No Profile answers are available at this cut.
        </Text>
      ) : null}
      {model.cards.length > visibleCards.length ? (
        <Text dimColor>
          showing {start + 1}–{start + visibleCards.length} of{' '}
          {model.cards.length}
        </Text>
      ) : null}
      {visibleCards.map((card, offset) => {
        const index = start + offset;
        return (
          <Box
            key={card.id}
            flexDirection="column"
            marginTop={offset === 0 ? 1 : 0}
          >
            <Box>
              <Text color={index === selectedCard ? 'cyan' : undefined} bold>
                {index === selectedCard ? '› ' : '  '}
                {index + 1}. {card.title}
              </Text>
              <Text color={card.status === 'degraded' ? 'yellow' : 'green'}>
                {' '}
                [{card.status}]
              </Text>
            </Box>
            <Text wrap="truncate-end"> {card.summary}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function EvidencePanel({
  model,
  active,
}: { model: ProfileShellModel; active: boolean }) {
  const qualificationLabel = model.profile.qualificationLabel ?? 'KFD-3';
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={active ? 'cyan' : undefined}
      paddingX={1}
      flexGrow={1}
    >
      <Text bold>Exact-root evidence</Text>
      {model.evidence.map((row) => (
        <Box key={row.label} flexDirection="column">
          <Text dimColor>{row.label}</Text>
          <Text>{shortRoot(row.value || '—')}</Text>
        </Box>
      ))}
      <Text color={model.profile.qualified ? 'green' : 'yellow'}>
        {qualificationLabel} {qualificationState(model)}
      </Text>
      {model.notice ? <Text color="yellow">{model.notice}</Text> : null}
    </Box>
  );
}

function CompactContext({ model }: { model: ProfileShellModel }) {
  const activeIndex = model.navigation.findIndex(
    (item) => item.id === model.subject.id,
  );
  const subjectPosition = activeIndex < 0 ? 'none' : `${activeIndex + 1}`;
  const proof = model.evidence.find((row) => row.label === 'query proof');
  const qualificationLabel = model.profile.qualificationLabel ?? 'KFD-3';
  return (
    <>
      <Text wrap="truncate-end">
        Subject {subjectPosition}/{model.navigation.length || 0} ·{' '}
        {model.subject.id || 'none'}
      </Text>
      <Text
        color={model.profile.qualified ? 'green' : 'yellow'}
        wrap="truncate-end"
      >
        {qualificationLabel} {qualificationState(model)} · proof{' '}
        {shortRoot(proof?.value ?? '—')}
        {model.notice ? ` · ${model.notice}` : ''}
      </Text>
    </>
  );
}

function WorkLoopContext({ model }: { model: WorkLoopShellModel }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text wrap="truncate-end">
        Cut <Text color="cyan">{model.cutStatus}</Text> · Work{' '}
        <Text color="cyan">{model.status}</Text> · confidence{' '}
        <Text color="yellow">{model.confidence}</Text> · root{' '}
        {shortRoot(model.cutRoot || '—')}
      </Text>
      <Text wrap="truncate-end" dimColor>
        current {model.workId || 'none'} · recovery {model.recoveryAction} (
        {model.recoveryCode})
      </Text>
      <Text wrap="truncate-end" dimColor>
        gaps {model.gaps.join(', ') || 'none'} · next{' '}
        {model.nextActions.join(', ') || 'none'}
      </Text>
    </Box>
  );
}

function WorkLoopFailure({ message }: { message: string }) {
  return (
    <Box paddingX={1}>
      <Text color="yellow" wrap="truncate-end">
        Work Loop unavailable · {message} · no mutation attempted
      </Text>
    </Box>
  );
}

export function ProfileShell({
  model,
  dimensions,
  selectedCard = 0,
  activeRegion = 1,
  busy = false,
}: {
  model: ProfileShellModel;
  dimensions: TerminalDimensions;
  selectedCard?: number;
  activeRegion?: number;
  busy?: boolean;
}) {
  const layout = resolveProfileShellLayout(dimensions);
  const workLoopRows = model.workLoop ? 3 : model.workLoopError ? 1 : 0;
  const bodyHeight = Math.max(6, dimensions.rows - 4 - workLoopRows);
  const evidence = <EvidencePanel model={model} active={activeRegion === 2} />;
  const navigation = (
    <NavigationPanel model={model} active={activeRegion === 0} />
  );
  const cards = (
    <CardPanel
      model={model}
      selectedCard={selectedCard}
      active={activeRegion === 1}
      maxRows={bodyHeight}
    />
  );

  return (
    <Box
      width={dimensions.columns}
      height={terminalCanvasRows(dimensions.rows)}
      flexDirection="column"
    >
      <Box justifyContent="space-between" paddingX={1}>
        <Text bold>{model.profile.title}</Text>
        <Text dimColor>
          {model.profile.version} · {layout.mode} ·{' '}
          {busy ? 'refreshing' : 'read-only'}
        </Text>
      </Box>
      {model.workLoop ? <WorkLoopContext model={model.workLoop} /> : null}
      {model.workLoopError ? (
        <WorkLoopFailure message={model.workLoopError} />
      ) : null}
      {layout.mode === 'three-column' ? (
        <Box height={bodyHeight}>
          <Box width={layout.navigationWidth}>{navigation}</Box>
          <Box flexGrow={1}>{cards}</Box>
          <Box width={layout.evidenceWidth}>{evidence}</Box>
        </Box>
      ) : null}
      {layout.mode === 'two-column' ? (
        <Box height={bodyHeight}>
          <Box width={layout.navigationWidth}>{navigation}</Box>
          <Box flexDirection="column" flexGrow={1}>
            {cards}
            {evidence}
          </Box>
        </Box>
      ) : null}
      {layout.mode === 'one-column' ? (
        <Box height={bodyHeight} flexDirection="column">
          <CompactContext model={model} />
          <Box flexGrow={1}>{cards}</Box>
        </Box>
      ) : null}
      <Box paddingX={1}>
        <Text dimColor>
          ↑↓/jk answer · ←→/hl subject · tab region · [a] Agent Work Lab · r
          refresh · q quit
        </Text>
      </Box>
    </Box>
  );
}

function clipped(value: string, width: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= width) return normalized.padEnd(width);
  return `${normalized.slice(0, Math.max(0, width - 1))}…`;
}

/** A stable, ANSI-free renderer used for terminal-size qualification. */
export function renderProfileShellSnapshot(
  model: ProfileShellModel,
  dimensions: TerminalDimensions,
): string {
  const layout = resolveProfileShellLayout(dimensions);
  const qualificationLabel = model.profile.qualificationLabel ?? 'KFD-3';
  const lines = [
    clipped(
      `${model.profile.title} · ${model.profile.version} · ${layout.mode} · read-only`,
      dimensions.columns,
    ),
    ...(model.workLoop
      ? [
          clipped(
            `Cut ${model.workLoop.cutStatus} · Work ${model.workLoop.status} · confidence ${model.workLoop.confidence} · root ${shortRoot(model.workLoop.cutRoot || '—')}`,
            dimensions.columns,
          ),
          clipped(
            `current ${model.workLoop.workId || 'none'} · recovery ${model.workLoop.recoveryAction} (${model.workLoop.recoveryCode})`,
            dimensions.columns,
          ),
          clipped(
            `gaps ${model.workLoop.gaps.join(', ') || 'none'} · next ${model.workLoop.nextActions.join(', ') || 'none'}`,
            dimensions.columns,
          ),
        ]
      : []),
    ...(model.workLoopError
      ? [
          clipped(
            `Work Loop unavailable · ${model.workLoopError} · no mutation attempted`,
            dimensions.columns,
          ),
        ]
      : []),
    clipped(
      `${model.subject.title} — ${model.subject.subtitle}`,
      dimensions.columns,
    ),
    clipped(
      `subjects ${model.navigation.map((item) => `${item.label}[${item.status}]`).join(' · ') || 'none'}`,
      dimensions.columns,
    ),
    ...model.cards.flatMap((card, index) => [
      clipped(
        `${index + 1}. ${card.title} [${card.status}]`,
        dimensions.columns,
      ),
      clipped(`   ${card.summary}`, dimensions.columns),
    ]),
    clipped(
      `evidence ${model.evidence.map((row) => `${row.label}=${shortRoot(row.value)}`).join(' · ')}`,
      dimensions.columns,
    ),
    clipped(
      `${qualificationLabel} ${qualificationState(model)}${model.notice ? ` · ${model.notice}` : ''}`,
      dimensions.columns,
    ),
    clipped(
      '↑↓/jk answer · ←→/hl subject · tab region · [a] Agent Work Lab · r refresh · q quit',
      dimensions.columns,
    ),
  ];
  while (lines.length < dimensions.rows)
    lines.push(' '.repeat(dimensions.columns));
  return lines.slice(0, dimensions.rows).join('\n');
}

// Generic two-session workbench. Product adapters supply all domain copy,
// event interpretation, verdict meaning, and next-step policy.
export type PlaybackTiming = {
  eventIntervalMs: number;
  verdictIntervalMs: number;
};
export type IncrementalPlayback<TEvent> = {
  enqueue(event: TEvent): void;
  finish(): Promise<boolean>;
  cancel(): void;
};
export type WorkbenchFocus = 'session-1' | 'session-2' | 'correct' | 'failed';
export type WorkbenchReportDetail = 'correct' | 'failed';
export type WorkbenchNextPrompt = { title: string; instruction: string };
export type WorkbenchLine = {
  session: 1 | 2;
  source: string;
  text: string;
  tone: 'normal' | 'running' | 'good' | 'bad' | 'dim';
};
export type WorkbenchCheck = {
  id: string;
  passed: boolean;
  title: string;
  meaning: string;
};

export function createIncrementalPlayback<TEvent>({
  timing,
  onEvent,
  onAssessing,
  isCurrent = () => true,
  wait = (milliseconds) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
}: {
  timing: PlaybackTiming;
  onEvent: (event: TEvent) => void;
  onAssessing: () => void;
  isCurrent?: () => boolean;
  wait?: (milliseconds: number) => Promise<void>;
}): IncrementalPlayback<TEvent> {
  let active = true;
  let queue = Promise.resolve();
  return {
    enqueue(event) {
      queue = queue
        .then(() => wait(timing.eventIntervalMs))
        .then(() => {
          if (active && isCurrent()) onEvent(event);
        });
    },
    async finish() {
      await queue;
      if (!active || !isCurrent()) return false;
      onAssessing();
      await wait(timing.verdictIntervalMs);
      return active && isCurrent();
    },
    cancel() {
      active = false;
    },
  };
}

const WORKBENCH_FOCUS_ORDER: WorkbenchFocus[] = [
  'session-1',
  'session-2',
  'correct',
  'failed',
];

export function nextWorkbenchFocus(
  current: WorkbenchFocus,
  reportAvailable: boolean,
): WorkbenchFocus {
  const available = reportAvailable
    ? WORKBENCH_FOCUS_ORDER
    : WORKBENCH_FOCUS_ORDER.slice(0, 2);
  const currentIndex = Math.max(0, available.indexOf(current));
  return available[(currentIndex + 1) % available.length];
}

export function isWorkbenchReturnInput(input: string): boolean {
  return (
    input === '\r' ||
    input === '\n' ||
    input === '\u001b' ||
    input === '\u007f' ||
    input === '\b' ||
    input === 'b' ||
    input === 'B' ||
    input === '\u001b[D'
  );
}

export function sessionTitleBar({
  session,
  title,
  active,
  running,
  columns,
  activityFrame = 0,
}: {
  session: 1 | 2;
  title: string;
  active: boolean;
  running: boolean;
  columns: number;
  activityFrame?: number;
}): string {
  const prefix = `${active ? '>' : ' '} S${session} · `;
  const spinner = ['◐', '◓', '◑', '◒'][activityFrame % 4];
  const status = running ? `${spinner} RUNNING` : 'READY';
  const titleColumns = Math.max(0, columns - prefix.length - status.length - 1);
  const compactTitle =
    title.length <= titleColumns
      ? title
      : titleColumns > 1
        ? `${title.slice(0, titleColumns - 1)}…`
        : '';
  const left = `${prefix}${compactTitle}`;
  const gap = ' '.repeat(Math.max(1, columns - left.length - status.length));
  return `${left}${gap}${status}`.padEnd(columns).slice(0, columns);
}

export function boundedPromptRows(
  value: string,
  columns: number,
  maxRows = 2,
): string[] {
  const width = Math.max(1, columns);
  const rows: string[] = [];
  let remaining = value.trim();
  while (remaining && rows.length < maxRows) {
    if (remaining.length <= width) {
      rows.push(remaining);
      remaining = '';
      break;
    }
    const space = remaining.lastIndexOf(' ', width);
    const cut = space > 0 ? space : width;
    rows.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining && rows.length > 0) {
    const last = rows.length - 1;
    rows[last] = `${rows[last].slice(0, Math.max(0, width - 1))}…`;
  }
  while (rows.length < maxRows) rows.push('');
  return rows;
}

function workbenchLineColor(tone: WorkbenchLine['tone']) {
  if (tone === 'running') return 'yellow';
  if (tone === 'good') return 'green';
  if (tone === 'bad') return 'red';
  if (tone === 'dim') return 'gray';
  return undefined;
}

function WorkbenchSessionPane({
  session,
  title,
  lines,
  active,
  scrollBack,
  viewportRows,
  running,
  titleBarColumns,
  activityFrame,
}: {
  session: 1 | 2;
  title: string;
  lines: WorkbenchLine[];
  active: boolean;
  scrollBack: number;
  viewportRows: number;
  running: boolean;
  titleBarColumns: number;
  activityFrame: number;
}) {
  const sessionLines = lines.filter((line) => line.session === session);
  const liveStart = Math.max(0, sessionLines.length - viewportRows);
  const start = Math.max(0, liveStart - scrollBack);
  const visible = sessionLines.slice(start, start + viewportRows);
  return (
    <Box
      width="50%"
      flexDirection="column"
      borderStyle="round"
      borderColor={active ? 'cyan' : 'gray'}
      overflow="hidden"
    >
      <Text
        bold
        color={active ? 'black' : 'white'}
        backgroundColor={active ? 'cyan' : 'gray'}
        wrap="truncate-end"
      >
        {sessionTitleBar({
          session,
          title,
          active,
          running,
          columns: titleBarColumns,
          activityFrame,
        })}
      </Text>
      <Box paddingX={1}>
        <Text dimColor>PUBLIC ACTIVITY · SENSITIVE INTERNALS HIDDEN</Text>
      </Box>
      <Box
        flexDirection="column"
        height={viewportRows}
        overflow="hidden"
        paddingX={1}
      >
        {visible.length === 0 ? (
          <Text dimColor>Activity will appear one event at a time.</Text>
        ) : null}
        {visible.map((line, index) => (
          <Text
            key={`${start + index}-${line.source}-${line.text}`}
            color={workbenchLineColor(line.tone)}
            wrap="truncate-end"
          >
            {String(start + index + 1).padStart(2, '0')}{' '}
            {line.source.padEnd(11)} {line.text}
          </Text>
        ))}
      </Box>
      <Box paddingX={1}>
        <Text dimColor>
          ↑↓ scroll focused Session · Tab switch ·{' '}
          {scrollBack > 0 ? `${scrollBack} lines back` : 'following live'}
        </Text>
      </Box>
    </Box>
  );
}

function WorkbenchReportDetail({
  dimensions,
  checks,
  detail,
  caption,
}: {
  dimensions: TerminalDimensions;
  checks: WorkbenchCheck[];
  detail: WorkbenchReportDetail;
  caption: string;
}) {
  const rows = checks.filter(
    (check) => (detail === 'correct') === check.passed,
  );
  const correct = detail === 'correct';
  return (
    <Box
      width={dimensions.columns}
      height={terminalCanvasRows(dimensions.rows)}
      flexDirection="column"
      borderStyle="double"
      borderColor={correct ? 'green' : 'red'}
      paddingX={1}
      overflow="hidden"
    >
      <Text bold color={correct ? 'green' : 'red'}>
        {correct ? '✓ CORRECT CHECKS' : '× FAILED CHECKS'} · {rows.length}
      </Text>
      <Text dimColor>{caption}</Text>
      <Box flexDirection="column" flexGrow={1} minHeight={0} marginTop={1}>
        {rows.length === 0 ? (
          <Text color={correct ? 'yellow' : 'green'}>
            {correct
              ? 'No correct checks were recorded.'
              : 'No failed checks. This is the expected result.'}
          </Text>
        ) : null}
        {rows.map((row, index) => (
          <Box key={row.id} flexDirection="column" marginBottom={1}>
            <Text bold color={row.passed ? 'green' : 'red'}>
              {String(index + 1).padStart(2, '0')} {row.passed ? '✓' : '×'}{' '}
              {row.title}
            </Text>
            <Text dimColor>{row.meaning}</Text>
          </Box>
        ))}
      </Box>
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan" wrap="truncate-end">
          ← RETURN TO RESULT CARDS · Esc / Enter / Backspace / b
        </Text>
      </Box>
    </Box>
  );
}

function WorkbenchResultCard({
  kind,
  count,
  active,
  available,
  emphasized,
}: {
  kind: WorkbenchReportDetail;
  count: number;
  active: boolean;
  available: boolean;
  emphasized: boolean;
}) {
  const correct = kind === 'correct';
  const tone = correct || count === 0 ? 'green' : 'red';
  const cardColor = !available ? 'gray' : active || emphasized ? 'cyan' : tone;
  return (
    <Box
      width="50%"
      height={3}
      borderStyle={emphasized ? 'double' : 'round'}
      borderColor={cardColor}
      paddingX={1}
      overflow="hidden"
    >
      <Text bold color={cardColor} wrap="truncate-end">
        {active ? '> ' : '  '}
        {correct ? '✓' : '×'} {count} {correct ? 'CORRECT' : 'FAILED'}
        {available ? ' · Enter details' : ' · waiting'}
      </Text>
    </Box>
  );
}

function opaqueWorkbenchLine(value: string, columns: number): string {
  return value.slice(0, columns).padEnd(columns);
}

export type SessionWorkbenchProps = {
  dimensions: TerminalDimensions;
  heading: string;
  collectionLabel: string;
  caseLabel: string;
  relationship: string;
  controls: string;
  help: string;
  sourceLabel: string;
  targetLabel: string;
  lines: WorkbenchLine[];
  checks: WorkbenchCheck[];
  reportAvailable: boolean;
  reportPassed: boolean;
  verdictSuccess: string;
  verdictFailure: string;
  detailCaption: string;
  busy: string;
  progress: string;
  error: string;
  activeFocus: WorkbenchFocus;
  scrollBack: Record<1 | 2, number>;
  showHelp: boolean;
  activityFrame: number;
  runningSession?: 1 | 2;
  nextPrompt?: WorkbenchNextPrompt;
  reportDetail?: WorkbenchReportDetail;
  emphasizedResult?: WorkbenchReportDetail;
};

export function SessionWorkbench(props: SessionWorkbenchProps) {
  const {
    dimensions,
    heading,
    collectionLabel,
    caseLabel,
    relationship,
    controls,
    help,
    sourceLabel,
    targetLabel,
    lines,
    checks,
    reportAvailable,
    reportPassed,
    verdictSuccess,
    verdictFailure,
    detailCaption,
    busy,
    progress,
    error,
    activeFocus,
    scrollBack,
    showHelp,
    activityFrame,
    runningSession,
    nextPrompt,
    reportDetail,
    emphasizedResult,
  } = props;
  if (reportAvailable && reportDetail) {
    return (
      <WorkbenchReportDetail
        dimensions={dimensions}
        checks={checks}
        detail={reportDetail}
        caption={detailCaption}
      />
    );
  }
  const titleColumns = Math.max(1, Math.floor(dimensions.columns / 2) - 2);
  const textColumns = Math.max(1, titleColumns - 2);
  const wrappedRows = (text: string) =>
    Math.max(1, Math.ceil(text.length / textColumns));
  const chromeRows =
    4 +
    (showHelp ? 1 : 0) +
    6 +
    2 +
    1 +
    wrappedRows('PUBLIC ACTIVITY · SENSITIVE INTERNALS HIDDEN') +
    wrappedRows('↑↓ scroll focused Session · Tab switch · 999 lines back');
  const viewportRows = Math.max(
    4,
    terminalCanvasRows(dimensions.rows) - chromeRows,
  );
  const passedCount = checks.filter((check) => check.passed).length;
  const failedCount = checks.length - passedCount;
  const promptWidth = Math.min(
    dimensions.columns,
    Math.min(68, Math.max(24, dimensions.columns - 8)),
  );
  const promptColumns = Math.max(1, promptWidth - 2);
  const promptRows = nextPrompt
    ? boundedPromptRows(
        `${nextPrompt.title} · ${nextPrompt.instruction}`,
        Math.max(1, promptColumns - 2),
      )
    : [];
  return (
    <Box
      width={dimensions.columns}
      height={terminalCanvasRows(dimensions.rows)}
      flexDirection="column"
      overflow="hidden"
    >
      <Box paddingX={1} justifyContent="space-between">
        <Text bold color="cyan">
          {heading.toUpperCase()}
        </Text>
        <Text>
          {collectionLabel} · {caseLabel}
        </Text>
      </Box>
      <Text wrap="truncate-end">
        S1 {sourceLabel} {relationship} S2 {targetLabel}
      </Text>
      <Text dimColor wrap="truncate-end">
        {controls}
      </Text>
      {showHelp ? (
        <Text dimColor wrap="truncate-end">
          {help}
        </Text>
      ) : null}
      <Box flexGrow={1} minHeight={0}>
        <WorkbenchSessionPane
          session={1}
          title={sourceLabel}
          lines={lines}
          active={activeFocus === 'session-1'}
          scrollBack={scrollBack[1]}
          viewportRows={viewportRows}
          running={Boolean(progress) && runningSession === 1}
          titleBarColumns={titleColumns}
          activityFrame={activityFrame}
        />
        <WorkbenchSessionPane
          session={2}
          title={targetLabel}
          lines={lines}
          active={activeFocus === 'session-2'}
          scrollBack={scrollBack[2]}
          viewportRows={viewportRows}
          running={Boolean(progress) && runningSession === 2}
          titleBarColumns={titleColumns}
          activityFrame={activityFrame}
        />
      </Box>
      <Box
        height={6}
        borderStyle="round"
        borderColor={
          reportAvailable ? (reportPassed ? 'green' : 'red') : 'gray'
        }
        paddingX={1}
        flexDirection="column"
        overflow="hidden"
      >
        <Text
          color={reportAvailable ? (reportPassed ? 'green' : 'red') : 'yellow'}
          bold
          wrap="truncate-end"
        >
          {reportAvailable
            ? reportPassed
              ? verdictSuccess
              : verdictFailure
            : error || busy || progress || 'Ready · choose a test case'}
        </Text>
        <Box>
          <WorkbenchResultCard
            kind="correct"
            count={passedCount}
            active={activeFocus === 'correct'}
            available={reportAvailable}
            emphasized={emphasizedResult === 'correct'}
          />
          <WorkbenchResultCard
            kind="failed"
            count={failedCount}
            active={activeFocus === 'failed'}
            available={reportAvailable}
            emphasized={emphasizedResult === 'failed'}
          />
        </Box>
      </Box>
      {nextPrompt ? (
        <Box
          position="absolute"
          width={promptWidth}
          height={6}
          marginTop={Math.max(4, Math.floor(dimensions.rows / 2) - 2)}
          marginLeft={Math.max(
            2,
            Math.floor((dimensions.columns - promptWidth) / 2),
          )}
          borderStyle="double"
          borderColor="yellow"
          flexDirection="column"
          overflow="hidden"
        >
          <Text bold color="yellow" backgroundColor="blue">
            {opaqueWorkbenchLine(' WHAT TO TRY NEXT', promptColumns)}
          </Text>
          {promptRows.map((row, index) => (
            <Text key={`${index}-${row}`} color="white" backgroundColor="blue">
              {opaqueWorkbenchLine(` ${row}`, promptColumns)}
            </Text>
          ))}
          <Text color="white" backgroundColor="blue">
            {opaqueWorkbenchLine(
              ' Closes automatically in 5 seconds.',
              promptColumns,
            )}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export type ControlPlaneMode =
  | 'closed'
  | 'help'
  | 'commands'
  | 'search'
  | 'detail';

export type ControlPlaneState = {
  mode: ControlPlaneMode;
  focus: 'input' | 'workspace';
  query: string;
  selected: number;
  notice?: string;
  detail?: ProductSearchDocument;
};

export type ControlPlaneUpdate = {
  handled: boolean;
  state: ControlPlaneState;
  activate?: boolean;
  quit?: boolean;
  workspaceNavigation?: 'next-focus';
};

export type ControlPlaneInputFence = {
  captureCurrentEmission: () => void;
  isCaptured: () => boolean;
};

export function createControlPlaneInputFence(
  isOpen: () => boolean,
): ControlPlaneInputFence {
  let capturedCurrentEmission = false;
  return {
    captureCurrentEmission: () => {
      capturedCurrentEmission = true;
      queueMicrotask(() => {
        capturedCurrentEmission = false;
      });
    },
    isCaptured: () => capturedCurrentEmission || isOpen(),
  };
}

export type QuickCommand<Action extends string = string> = {
  id: string;
  command: `/${string}`;
  title: string;
  summary: string;
  action: Action;
};

export type ProductQuickCommandAction =
  | 'help'
  | 'search'
  | 'health'
  | 'work'
  | 'lab'
  | 'home'
  | 'quit';

export const QUICK_COMMANDS: QuickCommand<ProductQuickCommandAction>[] = [
  {
    id: 'help',
    command: '/help',
    title: 'Open Help',
    summary:
      'Explain the input bar, shortcuts, search sources, and safety boundary.',
    action: 'help',
  },
  {
    id: 'search',
    command: '/search',
    title: 'Search Kungfu',
    summary: 'Find Help, Commands, Work, and product views.',
    action: 'search',
  },
  {
    id: 'health',
    command: '/health',
    title: 'Inspect Health',
    summary:
      'Describe the read-only runtime, Peer, storage, and Episode health command.',
    action: 'health',
  },
  {
    id: 'work',
    command: '/work',
    title: 'Open Work',
    summary: 'Open the current read-only Work Control projection.',
    action: 'work',
  },
  {
    id: 'lab',
    command: '/lab',
    title: 'Open Lab',
    summary: 'Open the installed identity-neutral work experiment suite.',
    action: 'lab',
  },
  {
    id: 'home',
    command: '/home',
    title: 'Open startup home',
    summary: 'Return to the surface selected from current Work evidence.',
    action: 'home',
  },
  {
    id: 'quit',
    command: '/quit',
    title: 'Quit Kungfu',
    summary: 'Leave the TUI and restore the terminal.',
    action: 'quit',
  },
];

export const CLOSED_CONTROL_PLANE: ControlPlaneState = {
  mode: 'closed',
  focus: 'input',
  query: '',
  selected: 0,
};

export function quickCommandMatches(
  query: string,
  commands: QuickCommand[] = QUICK_COMMANDS,
): QuickCommand[] {
  const needle = query.replace(/^\//, '').trim().toLocaleLowerCase();
  if (!needle) return commands;
  const prefixMatches = commands.filter(
    (command) =>
      command.command.slice(1).startsWith(needle) ||
      command.title.toLocaleLowerCase().startsWith(needle),
  );
  if (prefixMatches.length > 0) return prefixMatches;
  return commands.filter((command) =>
    `${command.command} ${command.title} ${command.summary}`
      .toLocaleLowerCase()
      .includes(needle),
  );
}

function openedControlPlane(
  mode: Exclude<ControlPlaneMode, 'closed' | 'detail'>,
  query = '',
): ControlPlaneState {
  return { mode, focus: 'input', query, selected: 0 };
}

export function reduceControlPlaneInput(
  current: ControlPlaneState,
  input: string,
  itemCount: number,
): ControlPlaneUpdate {
  if (input === '\u0003') {
    return { handled: true, state: current, quit: true };
  }
  if (input === '\u000b') {
    return {
      handled: true,
      state: openedControlPlane(
        'search',
        current.mode === 'closed' && current.focus === 'input'
          ? current.query
          : '',
      ),
    };
  }
  if (current.mode === 'closed') {
    if (current.focus === 'workspace') {
      if (input === 'i') {
        return {
          handled: true,
          state: { ...current, focus: 'input', notice: undefined },
        };
      }
      if (input === '?') {
        return { handled: true, state: openedControlPlane('help') };
      }
      if (input === '/') {
        return {
          handled: true,
          state: openedControlPlane('commands', '/'),
        };
      }
      return { handled: false, state: current };
    }
    if (input === '\u001b') {
      if (current.query) {
        return {
          handled: true,
          state: { ...current, query: '', notice: undefined },
        };
      }
      return {
        handled: true,
        state: { ...current, focus: 'workspace', notice: undefined },
      };
    }
    if (input === '\t' && !current.query) {
      return {
        handled: true,
        state: { ...current, focus: 'workspace', notice: undefined },
        workspaceNavigation: 'next-focus',
      };
    }
    if (input === '\u007f' || input === '\b') {
      return {
        handled: true,
        state: {
          ...current,
          query: [...current.query].slice(0, -1).join(''),
          notice: undefined,
        },
      };
    }
    if ((input === '\r' || input === '\n') && current.query) {
      return {
        handled: true,
        state: {
          ...current,
          notice:
            'Free-form Agent conversation is coming soon. Use / commands or Ctrl+K search.',
        },
      };
    }
    if (input === '?' && !current.query) {
      return { handled: true, state: openedControlPlane('help') };
    }
    if (input === '/' && !current.query) {
      return {
        handled: true,
        state: openedControlPlane('commands', '/'),
      };
    }
    if (/^[\x20-\x7e]+$/.test(input)) {
      return {
        handled: true,
        state: {
          ...current,
          query: `${current.query}${input}`.slice(0, 160),
          notice: undefined,
        },
      };
    }
    return { handled: true, state: current };
  }
  if (input === '\u001b') {
    return { handled: true, state: CLOSED_CONTROL_PLANE };
  }
  if (current.mode === 'help' || current.mode === 'detail') {
    if (
      input === '?' ||
      input === '\r' ||
      input === '\n' ||
      input === '\u007f'
    ) {
      return { handled: true, state: CLOSED_CONTROL_PLANE };
    }
    if (input === '/') {
      return {
        handled: true,
        state: openedControlPlane('commands', '/'),
      };
    }
    return { handled: true, state: current };
  }
  if (input === '\u001b[A') {
    return {
      handled: true,
      state: {
        ...current,
        selected: boundedIndex(current.selected, -1, itemCount),
      },
    };
  }
  if (input === '\u001b[B' || input === '\t') {
    return {
      handled: true,
      state: {
        ...current,
        selected: boundedIndex(current.selected, 1, itemCount),
      },
    };
  }
  if (input === '\r' || input === '\n') {
    return { handled: true, state: current, activate: itemCount > 0 };
  }
  if (input === '\u007f' || input === '\b') {
    const next = [...current.query].slice(0, -1).join('');
    if (current.mode === 'commands' && next === '') {
      return { handled: true, state: CLOSED_CONTROL_PLANE };
    }
    return {
      handled: true,
      state: { ...current, query: next, selected: 0 },
    };
  }
  if (/^[\x20-\x7e]+$/.test(input)) {
    return {
      handled: true,
      state: {
        ...current,
        query: `${current.query}${input}`,
        selected: 0,
      },
    };
  }
  return { handled: true, state: current };
}

function controlPlaneKindColor(kind: ProductSearchDocument['kind']): string {
  if (kind === 'work') return 'green';
  if (kind === 'command') return 'yellow';
  if (kind === 'view') return 'magenta';
  return 'cyan';
}

function ControlPlaneResultRows({
  rows,
  selected,
  height,
}: {
  rows: Array<ProductSearchDocument | ProductSearchResult>;
  selected: number;
  height: number;
}) {
  const visibleCount = Math.max(1, height);
  const start = Math.min(
    Math.max(0, selected - visibleCount + 1),
    Math.max(0, rows.length - visibleCount),
  );
  const visible = rows.slice(start, start + visibleCount);
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0}>
      {visible.length === 0 ? (
        <Text color="yellow">No matching results.</Text>
      ) : null}
      {visible.map((row, index) => {
        const absoluteIndex = start + index;
        return (
          <Box key={row.id} flexDirection="column">
            <Text
              bold={absoluteIndex === selected}
              color={
                absoluteIndex === selected
                  ? 'black'
                  : controlPlaneKindColor(row.kind)
              }
              backgroundColor={absoluteIndex === selected ? 'cyan' : undefined}
              wrap="truncate-end"
            >
              {absoluteIndex === selected ? '›' : ' '}{' '}
              {row.kind.toUpperCase().padEnd(7)} {row.title}
            </Text>
            <Text dimColor wrap="truncate-end">
              {'  '}
              {row.summary}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function QuickCommandRows({
  rows,
  selected,
  height,
}: {
  rows: QuickCommand[];
  selected: number;
  height: number;
}) {
  const visibleCount = Math.max(1, height);
  const start = Math.min(
    Math.max(0, selected - visibleCount + 1),
    Math.max(0, rows.length - visibleCount),
  );
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0}>
      {rows.length === 0 ? (
        <Text color="yellow">No matching quick action.</Text>
      ) : null}
      {rows.slice(start, start + visibleCount).map((row, index) => {
        const absoluteIndex = start + index;
        return (
          <Box key={row.id} flexDirection="column">
            <Text
              bold={absoluteIndex === selected}
              color={absoluteIndex === selected ? 'black' : 'yellow'}
              backgroundColor={absoluteIndex === selected ? 'cyan' : undefined}
            >
              {absoluteIndex === selected ? '›' : ' '} {row.command.padEnd(10)}{' '}
              {row.title}
            </Text>
            <Text dimColor wrap="truncate-end">
              {'  '}
              {row.summary}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function ControlPlaneOverlay({
  dimensions,
  state,
  searchResults,
  quickCommands,
  catalogStatus,
}: {
  dimensions: TerminalDimensions;
  state: ControlPlaneState;
  searchResults: ProductSearchResult[];
  quickCommands: QuickCommand[];
  catalogStatus: string;
}) {
  if (state.mode === 'closed') return null;
  const height = terminalCanvasRows(dimensions.rows);
  const width = Math.max(24, dimensions.columns);
  const panelWidth = Math.max(20, width - 4);
  const panelHeight = Math.max(8, height - 2);
  const rowBudget = Math.max(1, Math.floor((panelHeight - 7) / 2));
  const title =
    state.mode === 'help'
      ? 'HELP'
      : state.mode === 'commands'
        ? 'QUICK ACTIONS'
        : state.mode === 'detail'
          ? 'RESULT DETAILS'
          : 'SEARCH KUNGFU';
  return (
    <Box
      position="absolute"
      width={width}
      height={height}
      flexDirection="column"
      overflow="hidden"
    >
      <Box width={width} height={height} flexDirection="column">
        {Array.from(
          { length: height },
          (_, index) => `backdrop-row-${index + 1}`,
        ).map((rowId) => (
          <Text key={rowId} backgroundColor="black">
            {' '.repeat(width)}
          </Text>
        ))}
      </Box>
      <Box
        position="absolute"
        marginLeft={2}
        marginTop={1}
        width={panelWidth}
        height={panelHeight}
        flexDirection="column"
        borderStyle="double"
        borderColor="cyan"
        paddingX={1}
        overflow="hidden"
      >
        <Text bold color="cyan">
          KUNGFU · {title}
        </Text>
        {state.mode === 'help' ? (
          <>
            <Text>? Help · / Quick actions · Ctrl+K Search · Esc return</Text>
            <Text dimColor>
              The focused input accepts text, but free-form Agent conversation
              is not available yet.
            </Text>
            <Text dimColor>
              Search covers system Help, the full governed Kungfu Command
              catalog, global Work, and available product views.
            </Text>
            <Box marginTop={1} flexDirection="column">
              {quickCommands.slice(0, Math.max(1, rowBudget)).map((command) => (
                <Text key={command.id} color="yellow" wrap="truncate-end">
                  {command.command.padEnd(10)} {command.title}
                </Text>
              ))}
            </Box>
          </>
        ) : null}
        {state.mode === 'commands' ? (
          <>
            <Text dimColor>
              Enter runs the selected bounded action · ↑↓ choose · Esc cancel
            </Text>
            <QuickCommandRows
              rows={quickCommands}
              selected={state.selected}
              height={rowBudget}
            />
          </>
        ) : null}
        {state.mode === 'search' ? (
          <>
            <Text dimColor>
              {catalogStatus} · Enter opens or explains · ↑↓ choose · Esc cancel
            </Text>
            <ControlPlaneResultRows
              rows={searchResults}
              selected={state.selected}
              height={rowBudget}
            />
          </>
        ) : null}
        {state.mode === 'detail' && state.detail ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color={controlPlaneKindColor(state.detail.kind)}>
              {state.detail.kind.toUpperCase()} · {state.detail.title}
            </Text>
            <Text>{state.detail.summary}</Text>
            {state.detail.section ? (
              <Text dimColor>Section · {state.detail.section}</Text>
            ) : null}
            {state.detail.action.kind === 'describe-command' ? (
              <Text color="yellow">
                Inspect only · run `{state.detail.action.command} --help` in a
                shell. Search did not execute it.
              </Text>
            ) : null}
            <Text dimColor>Enter / Esc / Backspace returns.</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

function inputCursor(active: boolean) {
  return active ? (
    <Text inverse color="cyan">
      {' '}
    </Text>
  ) : null;
}

export function ControlPlaneBar({
  dimensions,
  state,
  resultCount,
  surfaceLabel = 'Kungfu',
  controlsLabel = 'VIEW CONTROLS',
  controlsHint = 'Workspace shortcuts active',
}: {
  dimensions: TerminalDimensions;
  state: ControlPlaneState;
  resultCount: number;
  surfaceLabel?: string;
  controlsLabel?: string;
  controlsHint?: string;
}) {
  const modalOpen = state.mode !== 'closed';
  const inputFocused = modalOpen || state.focus === 'input';
  const value =
    state.mode === 'commands' || state.mode === 'search' || !modalOpen
      ? state.query
      : '';
  const prompt =
    state.mode === 'help'
      ? 'Help is open'
      : state.mode === 'detail'
        ? 'Result details are open'
        : value ||
          (!modalOpen
            ? inputFocused
              ? 'Type a message…'
              : 'Keyboard shortcuts are active'
            : '');
  const modeLabel = modalOpen
    ? 'KUNGFU'
    : inputFocused
      ? 'INPUT'
      : controlsLabel;
  const hint =
    state.notice ??
    (state.mode === 'commands'
      ? `${resultCount} bounded action${resultCount === 1 ? '' : 's'} · Enter run · Esc cancel`
      : state.mode === 'search'
        ? `${resultCount} result${resultCount === 1 ? '' : 's'} · Enter open · Esc cancel`
        : state.mode === 'help' || state.mode === 'detail'
          ? 'Esc returns to the input'
          : state.focus === 'workspace'
            ? `${controlsHint} · i Input · ? Help · / Actions · Ctrl+K Search`
            : 'Text entry is active · Esc Controls · Tab next focus · ? Help · / Actions · Ctrl+K Search');
  const tone = inputFocused ? 'cyan' : 'gray';
  return (
    <Box
      position="absolute"
      marginTop={Math.max(0, terminalCanvasRows(dimensions.rows) - 4)}
      width={dimensions.columns}
      height={4}
      flexDirection="column"
      borderStyle="round"
      borderColor={tone}
      paddingX={1}
      overflow="hidden"
    >
      <Text color={tone} wrap="truncate-end">
        <Text
          bold
          color={inputFocused ? 'black' : 'white'}
          backgroundColor={inputFocused ? 'cyan' : 'gray'}
        >
          {' '}
          {modeLabel} · {surfaceLabel}{' '}
        </Text>{' '}
        <Text bold>{modalOpen ? '›' : inputFocused ? '›' : '◆'}</Text> {prompt}
        {!modalOpen ? inputCursor(inputFocused) : null}
      </Text>
      <Text
        color={state.notice ? 'yellow' : inputFocused ? 'white' : 'gray'}
        dimColor={!state.notice}
        wrap="truncate-end"
      >
        {hint}
      </Text>
    </Box>
  );
}
