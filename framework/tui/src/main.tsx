// SPDX-License-Identifier: Apache-2.0

import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import {
  type Profile,
  type QualificationLab,
  type QualificationLabEvent,
  type QualificationLabReport,
  type QualificationLabStartupRoute,
  type WorkLoop,
  openProfile,
  openQualificationLab,
  openWorkLoop,
  qualificationLabStartupSurface,
  qualificationRunProgressLabel,
} from '@kungfu-tech/api/capability';
import { Box, Text, render, useApp } from 'ink';
import React from 'react';

import { IncrementalTerminalOutput } from './incremental-terminal-output.js';
import { loadTuiKfxPlan } from './kfx-plan.js';
import { boundedIndex, decodeShellKey } from './navigation.js';
import {
  ProfileShell,
  type ProfileShellModel,
  type TerminalDimensions,
} from './profile-shell.js';
import {
  QualificationLabView,
  type TuiQualificationFocus,
  type TuiQualificationMode,
  type TuiQualificationNextPrompt,
  type TuiQualificationReportDetail,
  isQualificationReportReturnInput,
  nextQualificationFocus,
  qualificationEventLines,
  qualificationEventRunningSession,
  qualificationNextModePrompt,
} from './qualification-lab-view.js';
import { terminalCanvasRows } from './terminal-canvas.js';
import {
  TerminalLifecycle,
  describeCliFailure,
  resolveTuiRuntimeDir,
} from './terminal-lifecycle.js';
import {
  degradedWorkControlModel,
  loadWorkControlContribution,
} from './work-control-contribution.js';
import { workLoopShellModel } from './work-loop-contribution.js';

const nodeRequire = createRequire(import.meta.url);

function cliEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // This process is running inside embedded libnode. Child `kungfu` calls must
  // re-enter the ordinary CLI instead of recursively selecting the Node host.
  env.KUNGFU_AS_VARIANT = undefined;
  return env;
}

function runtimePaths() {
  const kungfuDir =
    process.env.KUNGFU_DIR ||
    path.join(
      path.dirname(nodeRequire.resolve('@kungfu-tech/core/package.json')),
      'dist',
      'kungfu',
    );
  const packagedBin = path.join(
    kungfuDir,
    process.platform === 'win32' ? 'kungfu.exe' : 'kungfu',
  );
  return {
    runtimeDir: resolveTuiRuntimeDir({
      env: process.env,
      cwd: process.cwd(),
      contractPath: path.join(
        kungfuDir,
        'config',
        'kungfu-config.contract.json',
      ),
    }),
    bin:
      process.env.KUNGFU_CLI_BIN ||
      process.env.KUNGFU_BIN ||
      (fs.existsSync(packagedBin) ? packagedBin : 'kungfu'),
    repoRoot: process.env.KF_WORKSPACE_ROOT || process.cwd(),
  };
}

function openTuiProfile(): Profile {
  const paths = runtimePaths();
  return openProfile({
    runtimeDir: paths.runtimeDir,
    bin: paths.bin,
    env: cliEnvironment(),
    execFileSync: (file, args, options) => execFileSync(file, args, options),
    execFile: (file, args, options) =>
      new Promise<string>((resolve, reject) => {
        execFile(file, args, options, (error, stdout, stderr) => {
          if (error)
            reject(new Error(describeCliFailure(error, stdout, stderr)));
          else resolve(stdout);
        });
      }),
  });
}

function openTuiQualificationLab(): QualificationLab {
  const paths = runtimePaths();
  return openQualificationLab({
    runtimeDir: paths.runtimeDir,
    bin: paths.bin,
    env: cliEnvironment(),
    execFileSync: (file, args, options) => execFileSync(file, args, options),
    execFile: (file, args, options) =>
      new Promise<string>((resolve, reject) => {
        execFile(file, args, options, (error, stdout, stderr) => {
          if (error)
            reject(new Error(describeCliFailure(error, stdout, stderr)));
          else resolve(stdout);
        });
      }),
    execFileEvents: (file, args, options, onLine) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(file, args, {
          env: options.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdoutBuffer = '';
        let stderr = '';
        let outputSize = 0;
        let settled = false;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          child.kill();
          reject(error);
        };
        const emitLine = (line: string) => {
          if (!line.trim()) return true;
          try {
            onLine(line);
            return true;
          } catch (reason) {
            fail(
              reason instanceof Error
                ? reason
                : new Error(`invalid qualification event: ${String(reason)}`),
            );
            return false;
          }
        };
        child.stdout.on('data', (chunk) => {
          const text = String(chunk);
          outputSize += text.length;
          if (outputSize > options.maxBuffer) {
            fail(new Error('qualification event stream exceeded maxBuffer'));
            return;
          }
          stdoutBuffer += text;
          const lines = stdoutBuffer.split(/\r?\n/);
          stdoutBuffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!emitLine(line)) return;
          }
        });
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.once('error', fail);
        child.once('close', (code, signal) => {
          if (settled) return;
          if (!emitLine(stdoutBuffer)) return;
          if (code !== 0) {
            fail(
              new Error(
                stderr.trim() ||
                  `qualification event stream exited ${code ?? signal ?? 'unknown'}`,
              ),
            );
            return;
          }
          settled = true;
          resolve();
        });
      }),
  });
}

function openTuiWorkLoop(): WorkLoop {
  const paths = runtimePaths();
  return openWorkLoop({
    runtimeDir: paths.runtimeDir,
    repoRoot: paths.repoRoot,
    bin: paths.bin,
    env: cliEnvironment(),
    execFile: (file, args, options) =>
      new Promise<string>((resolve, reject) => {
        execFile(file, args, options, (error, stdout, stderr) => {
          if (error)
            reject(new Error(describeCliFailure(error, stdout, stderr)));
          else resolve(stdout);
        });
      }),
  });
}

class DimensionStore {
  private listeners = new Set<(dimensions: TerminalDimensions) => void>();
  constructor(private current: TerminalDimensions) {}
  get() {
    return this.current;
  }
  update(dimensions: TerminalDimensions) {
    this.current = dimensions;
    for (const listener of this.listeners) listener(dimensions);
  }
  subscribe(listener: (dimensions: TerminalDimensions) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function WorkControlHost({
  profile,
  workLoop,
  dimensions,
  onOpenLab,
}: {
  profile: Profile;
  workLoop: WorkLoop;
  dimensions: DimensionStore;
  onOpenLab: () => void;
}) {
  const { exit } = useApp();
  const kfxPlan = React.useMemo(() => loadTuiKfxPlan(process.env), []);
  const [size, setSize] = React.useState(dimensions.get());
  const [model, setModel] = React.useState<ProfileShellModel>(() =>
    degradedWorkControlModel('loading public Profile projection'),
  );
  const [busy, setBusy] = React.useState(true);
  const [selectedCard, setSelectedCard] = React.useState(0);
  const [activeRegion, setActiveRegion] = React.useState(1);
  const refreshGeneration = React.useRef(0);

  const refresh = React.useCallback(
    async (initiativeId = '') => {
      const generation = ++refreshGeneration.current;
      setBusy(true);
      try {
        const next = await loadWorkControlContribution(
          profile,
          kfxPlan,
          initiativeId,
        );
        let loopProjection: ProfileShellModel['workLoop'];
        let loopError = '';
        if (next.profile.qualified) {
          try {
            const [inspection, recovery] = await Promise.all([
              workLoop.inspect(),
              workLoop.recover(),
            ]);
            loopProjection = workLoopShellModel(inspection, recovery);
          } catch (error) {
            loopError = error instanceof Error ? error.message : String(error);
          }
        }
        if (generation === refreshGeneration.current) {
          setModel({
            ...next,
            workLoop: loopProjection,
            workLoopError: loopError || undefined,
          });
          setSelectedCard(0);
        }
      } catch (error) {
        if (generation === refreshGeneration.current) {
          setModel(degradedWorkControlModel(error));
        }
      } finally {
        if (generation === refreshGeneration.current) setBusy(false);
      }
    },
    [profile, workLoop, kfxPlan],
  );

  React.useEffect(() => dimensions.subscribe(setSize), [dimensions]);
  React.useEffect(
    () => () => {
      refreshGeneration.current += 1;
    },
    [],
  );
  React.useEffect(() => {
    void refresh(process.env.KF_INITIATIVE_ID || '');
  }, [refresh]);
  React.useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      const key = decodeShellKey(String(chunk));
      if (key === 'quit') return exit();
      if (key === 'qualification-lab') return onOpenLab();
      if (key === 'refresh') return void refresh(model.subject.id);
      if (key === 'next-card') {
        setSelectedCard((current) =>
          boundedIndex(current, 1, model.cards.length),
        );
      } else if (key === 'previous-card') {
        setSelectedCard((current) =>
          boundedIndex(current, -1, model.cards.length),
        );
      } else if (key === 'next-region') {
        setActiveRegion((current) => boundedIndex(current, 1, 3));
      } else if (key === 'previous-region') {
        setActiveRegion((current) => boundedIndex(current, -1, 3));
      } else if (key === 'next-subject' || key === 'previous-subject') {
        const current = model.navigation.findIndex(
          (row) => row.id === model.subject.id,
        );
        const delta = key === 'next-subject' ? 1 : -1;
        const next =
          model.navigation[
            boundedIndex(current, delta, model.navigation.length)
          ];
        if (next) void refresh(next.id);
      }
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [exit, model, onOpenLab, refresh]);

  return (
    <ProfileShell
      model={model}
      dimensions={size}
      selectedCard={selectedCard}
      activeRegion={activeRegion}
      busy={busy}
    />
  );
}

function QualificationLabHost({
  lab,
  startup,
  dimensions,
  onOpenWork,
}: {
  lab: QualificationLab;
  startup: QualificationLabStartupRoute;
  dimensions: DimensionStore;
  onOpenWork?: () => void;
}) {
  const { exit } = useApp();
  const [size, setSize] = React.useState(dimensions.get());
  const [agents, setAgents] = React.useState<
    Awaited<ReturnType<QualificationLab['discoverAgents']>> | undefined
  >();
  const [mode, setMode] = React.useState<TuiQualificationMode>('offline-demo');
  const [selected, setSelected] = React.useState(0);
  const [target, setTarget] = React.useState(0);
  const [report, setReport] = React.useState<QualificationLabReport>();
  const [lines, setLines] = React.useState<
    ReturnType<typeof qualificationEventLines>
  >([]);
  const [activeFocus, setActiveFocus] =
    React.useState<TuiQualificationFocus>('session-1');
  const [reportDetail, setReportDetail] =
    React.useState<TuiQualificationReportDetail>();
  const [nextPrompt, setNextPrompt] =
    React.useState<TuiQualificationNextPrompt>();
  const [scrollBack, setScrollBack] = React.useState<Record<1 | 2, number>>({
    1: 0,
    2: 0,
  });
  const [showHelp, setShowHelp] = React.useState(false);
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const [runProgress, setRunProgress] = React.useState<{
    startedAt: number;
    lastEventAt: number;
    eventCount: number;
    phase: 'running' | 'assessing';
  }>();
  const [runningSession, setRunningSession] = React.useState<1 | 2>();
  const [progressNow, setProgressNow] = React.useState(() => Date.now());
  const playbackGeneration = React.useRef(0);
  const profiles = React.useMemo(
    () =>
      Array.from(
        new Map(
          [
            ...(agents?.configured ?? []),
            ...(agents?.discovered.map((row) => row.profile) ?? []),
          ].map((profile) => [profile.id, profile]),
        ).values(),
      ),
    [agents],
  );
  const discover = React.useCallback(async () => {
    setBusy('discovering agents');
    try {
      setAgents(await lab.discoverAgents());
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy('');
    }
  }, [lab]);
  React.useEffect(() => {
    void discover();
  }, [discover]);
  React.useEffect(
    () => dimensions.subscribe((next) => setSize(next)),
    [dimensions],
  );
  React.useEffect(() => {
    if (!runProgress) return undefined;
    setProgressNow(Date.now());
    const timer = setInterval(() => setProgressNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [runProgress]);
  React.useEffect(() => {
    if (!nextPrompt) return undefined;
    const timer = setTimeout(() => setNextPrompt(undefined), 5000);
    return () => clearTimeout(timer);
  }, [nextPrompt]);
  const runQualification = React.useCallback(
    (
      nextMode: TuiQualificationMode,
      label: string,
      execute: (
        onEvent: Parameters<QualificationLab['runDemo']>[0],
      ) => Promise<QualificationLabReport>,
    ) => {
      const generation = playbackGeneration.current + 1;
      playbackGeneration.current = generation;
      setMode(nextMode);
      setBusy(label);
      setReport(undefined);
      setLines([]);
      setActiveFocus('session-1');
      setReportDetail(undefined);
      setNextPrompt(undefined);
      setScrollBack({ 1: 0, 2: 0 });
      setError('');
      const startedAt = Date.now();
      setProgressNow(startedAt);
      setRunProgress({
        startedAt,
        lastEventAt: startedAt,
        eventCount: 0,
        phase: 'running',
      });
      setRunningSession(1);
      let queue = Promise.resolve();
      const receiveEvent = (event: QualificationLabEvent) => {
        queue = queue.then(
          () =>
            new Promise<void>((resolve) => {
              setTimeout(resolve, 1000);
            }),
        );
        queue = queue.then(() => {
          if (playbackGeneration.current !== generation) return;
          const eventSession = qualificationEventRunningSession(event);
          if (eventSession) setRunningSession(eventSession);
          setLines((current) => [
            ...current,
            ...qualificationEventLines(event),
          ]);
          setRunProgress((current) =>
            current
              ? {
                  ...current,
                  lastEventAt: Date.now(),
                  eventCount: current.eventCount + 1,
                }
              : current,
          );
        });
      };
      void execute(receiveEvent)
        .then(async (value) => {
          await queue;
          setRunProgress((current) =>
            current ? { ...current, phase: 'assessing' } : current,
          );
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 520);
          });
          if (playbackGeneration.current !== generation) return;
          setReport(value);
          setActiveFocus('correct');
          setNextPrompt(qualificationNextModePrompt(nextMode));
          setError('');
        })
        .catch((reason) => {
          if (playbackGeneration.current !== generation) return;
          setError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (playbackGeneration.current === generation) {
            setBusy('');
            setRunProgress(undefined);
            setRunningSession(undefined);
          }
        });
    },
    [],
  );
  React.useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      const input = String(chunk);
      if (reportDetail && isQualificationReportReturnInput(input)) {
        return setReportDetail(undefined);
      }
      const key = decodeShellKey(input);
      if (key === 'quit') return exit();
      if (input === '\t')
        return setActiveFocus((current) =>
          nextQualificationFocus(current, Boolean(report)),
        );
      if (
        report &&
        (input === '\r' || input === '\n') &&
        (activeFocus === 'correct' || activeFocus === 'failed')
      ) {
        return setReportDetail(activeFocus);
      }
      const focusedSession =
        activeFocus === 'session-1'
          ? 1
          : activeFocus === 'session-2'
            ? 2
            : undefined;
      if (input === '\u001b[A' && focusedSession)
        return setScrollBack((current) => ({
          ...current,
          [focusedSession]: current[focusedSession] + 1,
        }));
      if (input === '\u001b[B' && focusedSession)
        return setScrollBack((current) => ({
          ...current,
          [focusedSession]: Math.max(0, current[focusedSession] - 1),
        }));
      if (input === '?') return setShowHelp((current) => !current);
      if (key === 'next-card')
        return setSelected((current) =>
          boundedIndex(current, 1, profiles.length),
        );
      if (key === 'previous-card')
        return setSelected((current) =>
          boundedIndex(current, -1, profiles.length),
        );
      if (input === ']')
        return setTarget((current) =>
          boundedIndex(current, 1, profiles.length),
        );
      if (input === '[')
        return setTarget((current) =>
          boundedIndex(current, -1, profiles.length),
        );
      if (input === 'w' && onOpenWork) return onOpenWork();
      if (input === 'd' && !busy) {
        return runQualification(
          'offline-demo',
          'running two fresh demo sessions',
          (onEvent) => lab.runDemo(onEvent),
        );
      }
      if (input === 'x' && !busy && profiles[selected]) {
        return runQualification(
          'same-agent',
          'running selected agent twice',
          (onEvent) => lab.runAgent(profiles[selected].id, onEvent),
        );
      }
      if (
        input === 'm' &&
        !busy &&
        profiles[selected] &&
        profiles[target] &&
        selected !== target
      ) {
        return runQualification(
          'cross-agent',
          'running cross-provider handoff',
          (onEvent) =>
            lab.runMigration(
              profiles[selected].id,
              profiles[target].id,
              onEvent,
            ),
        );
      }
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [
    busy,
    activeFocus,
    exit,
    lab,
    onOpenWork,
    profiles,
    report,
    reportDetail,
    selected,
    target,
    runQualification,
  ]);
  const sourceLabel =
    mode === 'offline-demo' ? '' : profiles[selected]?.label || '';
  const targetLabel =
    mode === 'offline-demo'
      ? ''
      : mode === 'same-agent'
        ? sourceLabel
        : profiles[target]?.label || '';
  const progress = runProgress
    ? qualificationRunProgressLabel({
        elapsedMs: progressNow - runProgress.startedAt,
        quietMs: progressNow - runProgress.lastEventAt,
        eventCount: runProgress.eventCount,
        phase: runProgress.phase,
      })
    : '';
  return (
    <QualificationLabView
      dimensions={size}
      mode={mode}
      sourceLabel={sourceLabel}
      targetLabel={targetLabel}
      lines={lines}
      report={report}
      busy={busy}
      progress={progress}
      error={
        error ||
        (startup.route === 'diagnostic'
          ? `${startup.state} · ${startup.reasonCode}`
          : '')
      }
      activeFocus={activeFocus}
      scrollBack={scrollBack}
      showHelp={showHelp}
      activityFrame={
        runProgress
          ? Math.floor((progressNow - runProgress.startedAt) / 1000)
          : 0
      }
      runningSession={runningSession}
      nextPrompt={nextPrompt}
      reportDetail={reportDetail}
    />
  );
}

const PENDING_STARTUP: QualificationLabStartupRoute = {
  schema: 'kungfu.qualification-lab.startup-route/v1',
  state: 'verified-empty',
  route: 'qualification-lab',
  reasonCode: 'startup-inspection-pending',
  message: 'Kungfu is reading local Work and Profile roots.',
  runtimeDir: '',
  workGraphPresent: null,
  evidence: [],
  writeOccurred: false,
};

function StartingHost({
  dimensions,
  onOpenLab,
}: {
  dimensions: DimensionStore;
  onOpenLab: () => void;
}) {
  const { exit } = useApp();
  const [size, setSize] = React.useState(dimensions.get());
  React.useEffect(() => dimensions.subscribe(setSize), [dimensions]);
  React.useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      const key = decodeShellKey(String(chunk));
      if (key === 'quit') exit();
      if (key === 'qualification-lab') onOpenLab();
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [exit, onOpenLab]);
  return (
    <Box
      width={size.columns}
      height={terminalCanvasRows(size.rows)}
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan">
        KUNGFU
      </Text>
      <Text>Terminal product is open.</Text>
      <Text dimColor>
        Reading local Work and exact Profile evidence in the background…
      </Text>
      <Text dimColor>a qualification lab · q quit</Text>
    </Box>
  );
}

function ProductHost({
  lab,
  dimensions,
}: {
  lab: QualificationLab;
  dimensions: DimensionStore;
}) {
  const [startup, setStartup] = React.useState<QualificationLabStartupRoute>();
  const [surface, setSurface] = React.useState<'auto' | 'lab' | 'work'>('auto');
  const profile = React.useMemo(() => openTuiProfile(), []);
  const workLoop = React.useMemo(() => openTuiWorkLoop(), []);
  React.useEffect(() => {
    let active = true;
    void lab
      .inspect()
      .then((value) => {
        if (active) setStartup(value);
      })
      .catch((error) => {
        if (!active) return;
        setStartup({
          schema: 'kungfu.qualification-lab.startup-route/v1',
          state: 'diagnostic',
          route: 'diagnostic',
          reasonCode: 'startup-inspection-failed',
          message: error instanceof Error ? error.message : String(error),
          runtimeDir: runtimePaths().runtimeDir,
          workGraphPresent: null,
          evidence: [],
          writeOccurred: false,
        });
      });
    return () => {
      active = false;
    };
  }, [lab]);
  if (!startup && surface !== 'lab') {
    return (
      <StartingHost
        dimensions={dimensions}
        onOpenLab={() => setSurface('lab')}
      />
    );
  }
  const resolvedStartup = startup ?? PENDING_STARTUP;
  const startupSurface = qualificationLabStartupSurface(resolvedStartup);
  const labOpen =
    surface === 'lab' ||
    (surface === 'auto' && startupSurface === 'qualification-lab');
  if (labOpen) {
    return (
      <QualificationLabHost
        lab={lab}
        startup={resolvedStartup}
        dimensions={dimensions}
        onOpenWork={
          startupSurface === 'work-graph' ? () => setSurface('work') : undefined
        }
      />
    );
  }
  return (
    <WorkControlHost
      profile={profile}
      workLoop={workLoop}
      dimensions={dimensions}
      onOpenLab={() => setSurface('lab')}
    />
  );
}

function printNonInteractiveDiagnostic(): void {
  const paths = runtimePaths();
  process.stdout.write(
    `${JSON.stringify({
      schema: 'kungfu.tui.non-interactive/v1',
      status: 'not-started',
      reason: 'interactive terminal required',
      runtimeDir: paths.runtimeDir,
      next: 'run `kungfu` in a TTY',
    })}\n`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write(
      'Kungfu Work Control TUI\n\nRun in an interactive terminal.\nAgent brief: `kungfu agent brief`.\n',
    );
    return;
  }
  const lab = openTuiQualificationLab();
  if (process.argv.includes('--qualification-lab-demo')) {
    const report = await lab.runDemo();
    for (const event of report.events) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status === 'failed') process.exitCode = 1;
    return;
  }
  if (
    process.argv.includes('--diagnostic') ||
    process.stdin.isTTY !== true ||
    process.stdout.isTTY !== true
  ) {
    printNonInteractiveDiagnostic();
    return;
  }

  const lifecycle = new TerminalLifecycle(
    process.stdin,
    process.stdout,
    process,
  );
  const dimensions = new DimensionStore(lifecycle.dimensions());
  const terminalOutput = new IncrementalTerminalOutput(process.stdout);
  let instance: ReturnType<typeof render> | undefined;
  let terminating = false;
  await lifecycle.run(
    {
      onExit: (signal) => {
        terminating = true;
        if (signal) process.exitCode = 128 + osConstants.signals[signal];
        instance?.unmount();
      },
      onResize: (size) => dimensions.update(size),
    },
    async () => {
      if (terminating) return;
      instance = render(<ProductHost lab={lab} dimensions={dimensions} />, {
        stdin: process.stdin,
        stdout: terminalOutput as unknown as NodeJS.WriteStream,
        stderr: process.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
        debug: true,
      });
      await instance.waitUntilExit();
    },
  );
}

void main().catch((error) => {
  process.stderr.write(`Kungfu TUI failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
