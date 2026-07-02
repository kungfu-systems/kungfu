// Kungfu reference TUI — the platform's second reference surface (ADR-0007).
//
// A plain Node process that requires the kungfu_node binding in-process:
// no renderer, no IPC boundary, zero-copy by construction. It renders the
// same runtime facts as the reference GUI — recorded runs and the merged
// ledger event stream — proving the capability surface is UI-agnostic.
import { createRequire } from 'node:module';
import path from 'node:path';
import { Box, Text, render, useApp, useInput, useStdin } from 'ink';
import React from 'react';

const nodeRequire = createRequire(import.meta.url);

type KfFrame = {
  genTime: () => bigint;
  msgType: () => number;
  source: () => number;
  dest: () => number;
  dataLength: () => number;
};

type Kfe = {
  SessionStore: new (
    location: Record<string, string>,
    runtimeDir: string,
  ) => { getAllSessions: () => unknown };
  Watcher: new (
    runtimeDir: string,
    name: string,
    bypassRestore: boolean,
    bypassAccounting: boolean,
    bypassTradingData: boolean,
    refreshTradingDataBeforeSync: boolean,
    bypassRefreshBook: boolean,
    millisecondsSleepAfterStep: number,
  ) => { isLive: () => boolean; isStarted: () => boolean; start: () => void };
  Assemble: new (
    runtimeDirs: string[],
  ) => {
    dataAvailable: () => boolean;
    next: () => void;
    currentFrame: () => KfFrame;
  };
  formatTime?: (nano: bigint, format?: string) => string;
};

const APP_LOCATION = {
  category: 'system',
  group: 'node',
  name: 'reference_tui',
  mode: 'live',
};

function resolveKfcDir(): string {
  if (process.env.KFC_DIR) return process.env.KFC_DIR;
  const corePkg = nodeRequire.resolve('@kungfu-tech/core/package.json');
  return path.join(path.dirname(corePkg), 'dist', 'kfc');
}

function boot() {
  const kfcDir = resolveKfcDir();
  const runtimeDir =
    process.env.KF_RUNTIME_DIR || path.join(process.cwd(), 'demo-runtime');
  const kfe = nodeRequire(path.join(kfcDir, 'kungfu_node.node')) as Kfe;
  let watcher: ReturnType<typeof make> | null = null;
  function make() {
    return new kfe.Watcher(
      runtimeDir,
      APP_LOCATION.name,
      true,
      true,
      true,
      false,
      true,
      50,
    );
  }
  try {
    watcher = make();
    if (!watcher.isStarted()) watcher.start();
  } catch {
    watcher = null;
  }
  return { kfe, runtimeDir, exportCount: Object.keys(kfe).length, watcher };
}

type EventRow = {
  genTime: string;
  msgType: number;
  source: string;
  dest: string;
  length: number;
};

function useLedger(kfe: Kfe, runtimeDir: string) {
  const [events, setEvents] = React.useState<EventRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    const formatNano = (nano: bigint) => {
      try {
        if (kfe.formatTime) return kfe.formatTime(nano, '%H:%M:%S.%N');
      } catch {
        // fall through to raw nanoseconds
      }
      return String(nano);
    };
    const scan = () => {
      try {
        const asm = new kfe.Assemble([runtimeDir]);
        const rows: EventRow[] = [];
        let count = 0;
        while (asm.dataAvailable() && count < 100000) {
          const frame = asm.currentFrame();
          rows.push({
            genTime: formatNano(frame.genTime()),
            msgType: frame.msgType(),
            source: frame.source().toString(16).padStart(8, '0'),
            dest: frame.dest().toString(16).padStart(8, '0'),
            length: frame.dataLength(),
          });
          if (rows.length > 12) rows.shift();
          count += 1;
          asm.next();
        }
        setEvents(rows);
        setTotal(count);
        setError('');
      } catch (e) {
        setError((e as Error).message);
      }
    };
    scan();
    const timer = setInterval(scan, 2000);
    return () => clearInterval(timer);
  }, [kfe, runtimeDir]);

  return { events, total, error };
}

function App({ booted }: { booted: ReturnType<typeof boot> }) {
  const { kfe, runtimeDir, exportCount, watcher } = booted;
  const { exit } = useApp();
  const { events, total, error } = useLedger(kfe, runtimeDir);
  const [live, setLive] = React.useState(false);

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
    const timer = setInterval(() => {
      try {
        setLive(watcher ? watcher.isLive() : false);
      } catch {
        setLive(false);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [watcher]);

  const sessions = React.useMemo(() => {
    try {
      const store = new kfe.SessionStore(APP_LOCATION, runtimeDir);
      const all = store.getAllSessions();
      return Array.isArray(all) ? all.length : Object.keys(all ?? {}).length;
    } catch {
      return 0;
    }
  }, [kfe, runtimeDir]);

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
        runtime home: {runtimeDir} · runs: {sessions} · press q to quit
      </Text>
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text dimColor>
          LEDGER · {total} events · tail {events.length} · refresh 2s
        </Text>
        {error ? <Text color="red">{error}</Text> : null}
        {events.length === 0 && !error ? (
          <Text dimColor>
            no journal frames yet — start a master against this runtime home
          </Text>
        ) : null}
        {events.map((event, index) => (
          <Text key={`${event.genTime}-${index}`}>
            <Text dimColor>{event.genTime}</Text>
            {'  '}
            <Text color="cyan">msg {String(event.msgType).padStart(5)}</Text>
            {'  '}
            <Text color="yellow">
              {event.source} → {event.dest}
            </Text>
            {'  '}
            <Text dimColor>{event.length} B</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}

// Non-TTY stdin (CI, piped output) cannot enter raw mode; without it Ctrl+C
// arrives as a normal SIGINT anyway, so only let Ink take over in a real TTY.
render(<App booted={boot()} />, { exitOnCtrlC: process.stdin.isTTY === true });
