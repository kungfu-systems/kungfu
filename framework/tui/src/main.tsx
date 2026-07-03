// Kungfu reference TUI — the platform's second reference surface (ADR-0007),
// consuming the capability SDK (ADR-0011).
//
// A plain Node process loads the kungfu_node binding in-process — no
// renderer, no IPC boundary — injects it into the capability SDK, and
// renders recorded runs plus the merged ledger event stream. A non-DOM
// consumer of the same SDK the GUI uses is the proof that the capability
// surface is UI-agnostic.
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  type Ledger,
  type LedgerRecord,
  openLedger,
} from '@kungfu-tech/api/capability';
import { Box, Text, render, useApp, useInput, useStdin } from 'ink';
import React from 'react';

const nodeRequire = createRequire(import.meta.url);

function boot() {
  const kfcDir =
    process.env.KFC_DIR ||
    path.join(
      path.dirname(nodeRequire.resolve('@kungfu-tech/core/package.json')),
      'dist',
      'kungfu',
    );
  const runtimeDir =
    process.env.KF_RUNTIME_DIR || path.join(process.cwd(), 'demo-runtime');
  const binding = nodeRequire(path.join(kfcDir, 'kungfu_node.node'));
  const ledger = openLedger({
    binding,
    locator: { runtimeDir },
    join: { name: 'reference_tui' },
  });
  return { ledger, exportCount: Object.keys(binding).length };
}

function App({ ledger, exportCount }: { ledger: Ledger; exportCount: number }) {
  const { exit } = useApp();
  const [tail, setTail] = React.useState<LedgerRecord[]>([]);
  const [total, setTotal] = React.useState(0);
  const [live, setLive] = React.useState(false);
  const [runs, setRuns] = React.useState(0);

  const { isRawModeSupported } = useStdin();
  useInput(
    (input) => {
      if (input === 'q') exit();
    },
    // ink only skips raw mode on a strict `false`; isRawModeSupported is
    // undefined when stdin is not a TTY, so coerce explicitly.
    { isActive: isRawModeSupported === true },
  );

  React.useEffect(() => {
    const subscription = ledger.subscribe((fresh) => {
      setTotal((count) => count + fresh.length);
      setTail((rows) => [...rows, ...fresh].slice(-12));
    });
    const timer = setInterval(() => {
      setLive(ledger.health().live);
      setRuns(ledger.replayAnchors().length);
    }, 2000);
    return () => {
      subscription.stop();
      clearInterval(timer);
    };
  }, [ledger]);

  return (
    <Box flexDirection="column">
      <Box gap={2}>
        <Text bold>Kungfu v4 reference TUI</Text>
        <Text color="green">● in-process binding · {exportCount} exports</Text>
        <Text color={live ? 'green' : 'gray'}>
          {live ? '● live (master connected)' : '○ offline'}
        </Text>
      </Box>
      <Text dimColor>
        runtime home: {ledger.runtimeDir} · runs: {runs} · press q to quit
      </Text>
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text dimColor>
          LEDGER · {total} events · tail {tail.length} · via capability SDK
        </Text>
        {tail.length === 0 ? (
          <Text dimColor>
            no journal frames yet — start a master against this runtime home
          </Text>
        ) : null}
        {tail.map((record, index) => (
          <Text key={`${record.genTime}-${index}`}>
            <Text dimColor>{ledger.formatNanos(record.genTime)}</Text>
            {'  '}
            <Text color="cyan">msg {String(record.msgType).padStart(5)}</Text>
            {'  '}
            <Text color="yellow">
              {record.source.toString(16).padStart(8, '0')} →{' '}
              {record.dest.toString(16).padStart(8, '0')}
            </Text>
            {'  '}
            <Text dimColor>{record.dataLength} B</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}

const booted = boot();
// Non-TTY stdin (CI, piped output) cannot enter raw mode; without it Ctrl+C
// arrives as a normal SIGINT anyway, so only let Ink take over in a real TTY.
render(<App ledger={booted.ledger} exportCount={booted.exportCount} />, {
  exitOnCtrlC: process.stdin.isTTY === true,
});
