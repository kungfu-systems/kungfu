// SPDX-License-Identifier: Apache-2.0

import type { KungfuOnboardingState } from '@kungfu-tech/api/capability';
import { Box, Text, useApp } from 'ink';
import React from 'react';

import type { TerminalDimensions } from './profile-shell.js';
import { TitledBorderWindow } from './titled-border-window.js';

function wrapText(value: string, width: number): string[] {
  const words = value
    .split(/\s+/u)
    .flatMap((word) =>
      word.length <= width
        ? [word]
        : Array.from({ length: Math.ceil(word.length / width) }, (_, index) =>
            word.slice(index * width, (index + 1) * width),
          ),
    );
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (!line) line = word;
    else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export type TuiOnboardingAction =
  | 'agent'
  | 'lab'
  | 'tour'
  | 'continue'
  | 'dismiss';

export function AgentFirstOnboardingView({
  dimensions,
  state,
  command,
  prompt,
  notice = '',
  onAction,
}: {
  dimensions: TerminalDimensions;
  state: KungfuOnboardingState;
  command: string;
  prompt: string;
  notice?: string;
  onAction: (action: TuiOnboardingAction) => void;
}) {
  const { exit } = useApp();
  React.useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      const value = String(chunk);
      if (value === 'q' || value === 'Q' || value === '\u0003') exit();
      else if (value === '1' || value === '\r' || value === '\n')
        onAction('agent');
      else if (value === '2') onAction('lab');
      else if (value === '3') onAction('tour');
      else if (value === 'w') onAction('continue');
      else if (value === 's') onAction('dismiss');
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [exit, onAction]);

  return (
    <Box
      width={dimensions.columns}
      height={dimensions.rows}
      paddingX={1}
      flexDirection="column"
      overflow="hidden"
    >
      <Text color="green" bold>
        KUNGFU · AGENT-FIRST ENTRY
      </Text>
      <Text bold>Keep your agent. Give it durable Work.</Text>
      <Text wrap="wrap">
        Kungfu does not require a new chat or daily workspace. Start by teaching
        the agent you already use how to preserve Projects, Work, attempts,
        review, and settlement across sessions.
      </Text>
      <TitledBorderWindow
        columns={Math.max(20, dimensions.columns - 2)}
        title="1 · COPY THIS TO YOUR EXISTING AGENT"
        borderColor="green"
        paddingX={1}
        rows={[
          ...wrapText(prompt, Math.max(16, dimensions.columns - 8)),
          '',
          ...wrapText(
            `Exact local command: ${command}`,
            Math.max(16, dimensions.columns - 8),
          ),
          '[1/Enter] I’ll use my Agent',
        ]}
      />
      <Text>
        Optional: [2] Agent Work Lab · [3] Guided Project Tour · [w] Work now ·
        [s] Don’t show again
      </Text>
      <Text dimColor>
        Keep using kungfu run codex|claude|opencode|amp. GUI/TUI are optional
        control surfaces. Current route: {state.route}.
      </Text>
      {notice ? <Text color="yellow">{notice}</Text> : null}
    </Box>
  );
}
