// SPDX-License-Identifier: Apache-2.0

import type {
  QualificationLabEvent,
  QualificationLabReport,
} from '@kungfu-tech/api/capability';
import { Box, Text } from 'ink';
import React from 'react';
import type { TerminalDimensions } from './profile-shell.js';
import { terminalCanvasRows } from './terminal-canvas.js';

export type TuiQualificationMode =
  | 'offline-demo'
  | 'same-agent'
  | 'cross-agent';

export type TuiQualificationFocus =
  | 'session-1'
  | 'session-2'
  | 'correct'
  | 'failed';

export type TuiQualificationReportDetail = 'correct' | 'failed';

export type TuiQualificationNextPrompt = {
  title: string;
  instruction: string;
};

export type TuiQualificationLine = {
  session: 1 | 2;
  source:
    | 'kungfu'
    | 'task'
    | 'agent/guide'
    | 'agent/live'
    | 'tool/live'
    | 'evidence';
  text: string;
  tone: 'normal' | 'running' | 'good' | 'bad' | 'dim';
};

const FOCUS_ORDER: TuiQualificationFocus[] = [
  'session-1',
  'session-2',
  'correct',
  'failed',
];

const CHECK_COPY: Record<string, { title: string; meaning: string }> = {
  'distinct-fresh-processes': {
    title: 'Two genuinely fresh processes',
    meaning: 'Session 2 did not reuse the Session 1 provider process.',
  },
  'first-attempt-ended-partial': {
    title: 'Session 1 stopped at a bounded partial result',
    meaning:
      'The first process left durable evidence instead of pretending to finish.',
  },
  'second-attempt-no-transcript-or-explanation': {
    title: 'Session 2 received no copied chat',
    meaning:
      'Continuation came from governed Work, not hidden transcript transfer.',
  },
  'second-attempt-recognized-partial-state': {
    title: 'Session 2 recovered the partial state',
    meaning: 'The fresh process found what was done and what remained.',
  },
  'fixture-completed': {
    title: 'The original Work was completed',
    meaning:
      'The second process continued the same identity to its expected result.',
  },
};

export function nextQualificationFocus(
  current: TuiQualificationFocus,
  reportAvailable: boolean,
): TuiQualificationFocus {
  const available = reportAvailable ? FOCUS_ORDER : FOCUS_ORDER.slice(0, 2);
  const currentIndex = Math.max(0, available.indexOf(current));
  return available[(currentIndex + 1) % available.length];
}

export function qualificationNextModePrompt(
  mode: TuiQualificationMode,
): TuiQualificationNextPrompt {
  if (mode === 'offline-demo') {
    return {
      title: 'Offline complete · now test your real agent',
      instruction:
        'Press x to test same-agent continuity with your selected agent.',
    };
  }
  if (mode === 'same-agent') {
    return {
      title: 'Same-agent complete · now test a handoff',
      instruction:
        'Choose a different target with [ or ], then press m to test handoff.',
    };
  }
  return {
    title: 'Handoff complete · inspect the evidence',
    instruction:
      'Tab to CORRECT or FAILED, then press Enter to open its details.',
  };
}

export function isQualificationReportReturnInput(input: string): boolean {
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

export function qualificationEventRunningSession(
  event: QualificationLabEvent,
): 1 | 2 | undefined {
  if (event.step.includes('session-1')) return 1;
  if (event.step.includes('session-2')) return 2;
  return undefined;
}

function eventSession(event: QualificationLabEvent): 1 | 2 {
  return event.step.includes('session-1') ? 1 : 2;
}

export function qualificationEventLines(
  event: QualificationLabEvent,
): TuiQualificationLine[] {
  if (event.publicActivity) {
    return [
      {
        session: eventSession(event),
        source:
          event.publicActivity.kind === 'agent' ? 'agent/live' : 'tool/live',
        text: event.publicActivity.text,
        tone: event.publicActivity.phase === 'completed' ? 'good' : 'running',
      },
    ];
  }
  if (event.step === 'plan') {
    return [
      {
        session: 1,
        source: 'kungfu',
        text: 'One governed task identity was sealed before either process started.',
        tone: 'normal',
      },
    ];
  }
  if (event.step.endsWith('-start')) {
    const session = eventSession(event);
    return [
      {
        session,
        source: 'task',
        text:
          session === 1
            ? 'Start bounded work and stop after a provable partial result.'
            : 'Continue the same Work without Session 1 chat.',
        tone: 'normal',
      },
      {
        session,
        source: 'agent/guide',
        text:
          session === 1
            ? 'I’m starting fresh. I’ll inspect governed state before changing it.'
            : 'I’m a fresh process. I’ll recover state instead of guessing.',
        tone: 'running',
      },
      {
        session,
        source: 'kungfu',
        text: `Fresh provider process ${session} started in the isolated workspace.`,
        tone: 'running',
      },
    ];
  }
  if (event.step === 'session-1' || event.step === 'session-2') {
    const session = eventSession(event);
    const good =
      session === 1
        ? ['partial', 'ended-partial', 'partial-first-attempt'].includes(
            event.status,
          )
        : ['complete', 'ended-complete', 'continuation-completed'].includes(
            event.status,
          );
    return [
      ...(event.publicOutput?.lines ?? []).map((text) => ({
        session,
        source: 'agent/live' as const,
        text,
        tone: good ? ('good' as const) : ('bad' as const),
      })),
      {
        session,
        source: 'evidence',
        text: `Governed state observed: ${event.status}.`,
        tone: good ? 'good' : 'bad',
      },
      {
        session,
        source: 'kungfu',
        text:
          session === 1
            ? 'Verified the expected partial handoff state.'
            : 'Verified continuation from the recorded partial state.',
        tone: good ? 'good' : 'bad',
      },
    ];
  }
  if (event.step === 'assessment') {
    return [
      {
        session: 2,
        source: 'kungfu',
        text: 'Continuity oracle compared process identity and governed state.',
        tone: 'normal',
      },
      {
        session: 2,
        source: 'evidence',
        text: `Assessment: ${event.status}.`,
        tone: event.status === 'failed' ? 'bad' : 'good',
      },
    ];
  }
  return [];
}

function lineColor(tone: TuiQualificationLine['tone']) {
  if (tone === 'running') return 'yellow';
  if (tone === 'good') return 'green';
  if (tone === 'bad') return 'red';
  if (tone === 'dim') return 'gray';
  return undefined;
}

export function qualificationSessionTitleBar({
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

export function qualificationPromptRows(
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

function opaquePromptLine(value: string, columns: number): string {
  return value.slice(0, columns).padEnd(columns);
}

function SessionPane({
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
  lines: TuiQualificationLine[];
  active: boolean;
  scrollBack: number;
  viewportRows: number;
  running: boolean;
  titleBarColumns: number;
  activityFrame: number;
}) {
  const sessionLines = lines.filter((line) => line.session === session);
  const lastStart = Math.max(0, sessionLines.length - viewportRows);
  const start = Math.max(0, lastStart - scrollBack);
  const visible = sessionLines.slice(start, start + viewportRows);
  return (
    <Box
      width="50%"
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      overflow="hidden"
    >
      <Text
        bold
        color={active ? 'black' : 'white'}
        backgroundColor={active ? 'cyan' : 'gray'}
        wrap="truncate-end"
      >
        {qualificationSessionTitleBar({
          session,
          title,
          active,
          running,
          columns: titleBarColumns,
          activityFrame,
        })}
      </Text>
      <Box paddingX={1}>
        <Text dimColor>
          PUBLIC STATUS · PRIVATE REASONING + RAW OUTPUT HIDDEN
        </Text>
      </Box>
      <Box
        flexDirection="column"
        height={viewportRows}
        overflow="hidden"
        paddingX={1}
      >
        {visible.length === 0 ? (
          <Text dimColor>Agent activity will appear one event at a time.</Text>
        ) : null}
        {visible.map((line, index) => (
          <Text
            key={`${start + index}-${line.source}-${line.text}`}
            color={lineColor(line.tone)}
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

function reportChecks(report: QualificationLabReport | undefined): {
  passed: number;
  failed: number;
} {
  const checks = Array.isArray(report?.assessment?.oracleChecks)
    ? report.assessment.oracleChecks
    : [];
  return {
    passed: checks.filter(
      (check) =>
        check &&
        typeof check === 'object' &&
        (check as Record<string, unknown>).passed === true,
    ).length,
    failed: checks.filter(
      (check) =>
        check &&
        typeof check === 'object' &&
        (check as Record<string, unknown>).passed === false,
    ).length,
  };
}

function reportCheckRows(
  report: QualificationLabReport | undefined,
  detail: TuiQualificationReportDetail,
): Array<{ id: string; passed: boolean; title: string; meaning: string }> {
  const checks = Array.isArray(report?.assessment?.oracleChecks)
    ? report.assessment.oracleChecks
    : [];
  return checks.flatMap((check) => {
    if (!check || typeof check !== 'object') return [];
    const row = check as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.passed !== 'boolean')
      return [];
    if ((detail === 'correct') !== row.passed) return [];
    const copy = CHECK_COPY[row.id] ?? {
      title: row.id.replaceAll('-', ' '),
      meaning: 'This check came from the canonical continuity assessment.',
    };
    return [{ id: row.id, passed: row.passed, ...copy }];
  });
}

function ReportDetailPage({
  dimensions,
  report,
  detail,
}: {
  dimensions: TerminalDimensions;
  report: QualificationLabReport;
  detail: TuiQualificationReportDetail;
}) {
  const rows = reportCheckRows(report, detail);
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
      <Text dimColor>
        Canonical continuity oracle details · private reasoning remains hidden
      </Text>
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

function ResultCard({
  kind,
  count,
  active,
  available,
}: {
  kind: TuiQualificationReportDetail;
  count: number;
  active: boolean;
  available: boolean;
}) {
  const correct = kind === 'correct';
  const label = correct ? 'CORRECT' : 'FAILED';
  const tone = correct || count === 0 ? 'green' : 'red';
  const cardColor = !available ? 'gray' : active ? 'cyan' : tone;
  return (
    <Box
      width="50%"
      height={3}
      borderStyle="round"
      borderColor={cardColor}
      paddingX={1}
      overflow="hidden"
    >
      <Text bold color={cardColor} wrap="truncate-end">
        {active ? '> ' : '  '}
        {correct ? '✓' : '×'} {count} {label}
        {available ? ' · Enter details' : ' · waiting'}
      </Text>
    </Box>
  );
}

export function QualificationLabView({
  dimensions,
  mode,
  sourceLabel,
  targetLabel,
  lines,
  report,
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
}: {
  dimensions: TerminalDimensions;
  mode: TuiQualificationMode;
  sourceLabel: string;
  targetLabel: string;
  lines: TuiQualificationLine[];
  report?: QualificationLabReport;
  busy: string;
  progress: string;
  error: string;
  activeFocus: TuiQualificationFocus;
  scrollBack: Record<1 | 2, number>;
  showHelp: boolean;
  activityFrame: number;
  runningSession?: 1 | 2;
  nextPrompt?: TuiQualificationNextPrompt;
  reportDetail?: TuiQualificationReportDetail;
}) {
  if (report && reportDetail) {
    return (
      <ReportDetailPage
        dimensions={dimensions}
        report={report}
        detail={reportDetail}
      />
    );
  }
  const paneTitleColumns = Math.max(1, Math.floor(dimensions.columns / 2) - 2);
  const paneTextColumns = Math.max(1, paneTitleColumns - 2);
  const wrappedRows = (text: string) =>
    Math.max(1, Math.ceil(text.length / paneTextColumns));
  const chromeRows =
    3 +
    (showHelp ? 1 : 0) +
    6 +
    2 +
    1 +
    wrappedRows('PUBLIC STATUS · PRIVATE REASONING + RAW OUTPUT HIDDEN') +
    wrappedRows('↑↓ scroll focused Session · Tab switch · 999 lines back');
  const viewportRows = Math.max(
    4,
    terminalCanvasRows(dimensions.rows) - chromeRows,
  );
  const checks = reportChecks(report);
  const passed = Boolean(report && report.status !== 'failed');
  const promptWidth = Math.min(
    dimensions.columns,
    Math.min(68, Math.max(24, dimensions.columns - 8)),
  );
  const promptColumns = Math.max(1, promptWidth - 2);
  const promptRows = nextPrompt
    ? qualificationPromptRows(
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
          AGENT QUALIFICATION LAB
        </Text>
        <Text>{mode}</Text>
      </Box>
      <Text wrap="truncate-end">
        S1 {sourceLabel || 'Bundled Demo Agent'} → governed evidence → S2{' '}
        {targetLabel || 'Fresh Demo Agent'}
      </Text>
      <Text dimColor wrap="truncate-end">
        [d] demo [j/k] source [brackets] target [x] same [m] handoff [Tab] focus
        [?] explain [w] Work [q] quit
      </Text>
      {showHelp ? (
        <Text dimColor wrap="truncate-end">
          Good: fresh Session 2 finds the same Work and continues. Bad: restart,
          copied chat, lost identity. Live labels are admitted provider events;
          guide labels are Kungfu previews.
        </Text>
      ) : null}
      <Box flexGrow={1} minHeight={0}>
        <SessionPane
          session={1}
          title={sourceLabel || 'Bundled Demo Agent'}
          lines={lines}
          active={activeFocus === 'session-1'}
          scrollBack={scrollBack[1]}
          viewportRows={viewportRows}
          running={Boolean(progress) && runningSession === 1}
          titleBarColumns={paneTitleColumns}
          activityFrame={activityFrame}
        />
        <SessionPane
          session={2}
          title={targetLabel || 'Fresh Demo Agent'}
          lines={lines}
          active={activeFocus === 'session-2'}
          scrollBack={scrollBack[2]}
          viewportRows={viewportRows}
          running={Boolean(progress) && runningSession === 2}
          titleBarColumns={paneTitleColumns}
          activityFrame={activityFrame}
        />
      </Box>
      <Box
        height={6}
        borderStyle="round"
        borderColor={report ? (passed ? 'green' : 'red') : 'gray'}
        paddingX={1}
        flexDirection="column"
        overflow="hidden"
      >
        <Text
          color={report ? (passed ? 'green' : 'red') : 'yellow'}
          bold
          wrap="truncate-end"
        >
          {report
            ? passed
              ? 'CONTINUITY PROVED'
              : 'CONTINUITY NOT PROVED'
            : error ||
              busy ||
              progress ||
              'Ready · choose demo, same-agent, or handoff'}
        </Text>
        <Box>
          <ResultCard
            kind="correct"
            count={checks.passed}
            active={activeFocus === 'correct'}
            available={Boolean(report)}
          />
          <ResultCard
            kind="failed"
            count={checks.failed}
            active={activeFocus === 'failed'}
            available={Boolean(report)}
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
            {opaquePromptLine(' WHAT TO TRY NEXT', promptColumns)}
          </Text>
          {promptRows.map((row, index) => (
            <Text key={`${index}-${row}`} color="white" backgroundColor="blue">
              {opaquePromptLine(` ${row}`, promptColumns)}
            </Text>
          ))}
          <Text color="white" backgroundColor="blue">
            {opaquePromptLine(
              ' Closes automatically in 5 seconds.',
              promptColumns,
            )}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
