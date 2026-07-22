// SPDX-License-Identifier: Apache-2.0

import { Box, Text } from 'ink';
import React from 'react';

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
  };
  subject: { id: string; title: string; subtitle: string };
  navigation: Array<{ id: string; label: string; status: string }>;
  cards: ProfileShellCard[];
  evidence: Array<{ label: string; value: string }>;
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
}: {
  model: ProfileShellModel;
  selectedCard: number;
  active: boolean;
}) {
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
      {model.cards.map((card, index) => (
        <Box
          key={card.id}
          flexDirection="column"
          marginTop={index === 0 ? 1 : 0}
        >
          <Text color={index === selectedCard ? 'cyan' : undefined} bold>
            {index === selectedCard ? '› ' : '  '}
            {index + 1}. {card.title}{' '}
            <Text color={card.status === 'degraded' ? 'yellow' : 'green'}>
              [{card.status}]
            </Text>
          </Text>
          <Text wrap="truncate-end"> {card.summary}</Text>
        </Box>
      ))}
    </Box>
  );
}

function EvidencePanel({
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
      <Text bold>Exact-root evidence</Text>
      {model.evidence.map((row) => (
        <Box key={row.label} flexDirection="column">
          <Text dimColor>{row.label}</Text>
          <Text>{shortRoot(row.value || '—')}</Text>
        </Box>
      ))}
      <Text color={model.profile.qualified ? 'green' : 'yellow'}>
        KFD-3 {model.profile.qualified ? 'qualified' : 'not qualified'}
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
        KFD-3 {model.profile.qualified ? 'qualified' : 'not qualified'} · proof{' '}
        {shortRoot(proof?.value ?? '—')}
        {model.notice ? ` · ${model.notice}` : ''}
      </Text>
    </>
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
  const bodyHeight = Math.max(6, dimensions.rows - 4);
  const evidence = <EvidencePanel model={model} active={activeRegion === 2} />;
  const navigation = (
    <NavigationPanel model={model} active={activeRegion === 0} />
  );
  const cards = (
    <CardPanel
      model={model}
      selectedCard={selectedCard}
      active={activeRegion === 1}
    />
  );

  return (
    <Box
      width={dimensions.columns}
      height={dimensions.rows}
      flexDirection="column"
    >
      <Box justifyContent="space-between" paddingX={1}>
        <Text bold>{model.profile.title}</Text>
        <Text dimColor>
          {model.profile.version} · {layout.mode} ·{' '}
          {busy ? 'refreshing' : 'read-only'}
        </Text>
      </Box>
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
          ↑↓/jk answer · ←→/hl subject · tab region · r refresh · q quit
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
  const lines = [
    clipped(
      `${model.profile.title} · ${model.profile.version} · ${layout.mode} · read-only`,
      dimensions.columns,
    ),
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
      `KFD-3 ${model.profile.qualified ? 'qualified' : 'not qualified'}${model.notice ? ` · ${model.notice}` : ''}`,
      dimensions.columns,
    ),
    clipped(
      '↑↓/jk answer · ←→/hl subject · tab region · r refresh · q quit',
      dimensions.columns,
    ),
  ];
  while (lines.length < dimensions.rows)
    lines.push(' '.repeat(dimensions.columns));
  return lines.slice(0, dimensions.rows).join('\n');
}
