// SPDX-License-Identifier: Apache-2.0

import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import {
  type ProductSearchDocument,
  type Profile,
  type QualificationLab,
  type QualificationLabStartupRoute,
  SYSTEM_HELP_DOCUMENTS,
  type WorkLoop,
  loadCliHelpSearchDocuments,
  openProfile,
  openQualificationLab,
  openWorkLoop,
  qualificationLabStartupSurface,
  searchProductDocuments,
} from '@kungfu-tech/api/capability';
import { Box, Text, render, useApp } from 'ink';
import React from 'react';

import { loadTuiKfxPlan } from './kfx-plan.js';
import { boundedIndex, decodeShellKey } from './navigation.js';
import {
  CLOSED_CONTROL_PLANE,
  ControlPlaneBar,
  ControlPlaneOverlay,
  type ControlPlaneState,
  ProfileShell,
  type ProfileShellModel,
  QUICK_COMMANDS,
  type TerminalDimensions,
  createControlPlaneInputFence,
  quickCommandMatches,
  reduceControlPlaneInput,
} from './profile-shell.js';
import { AgentWorkLabHost } from './qualification-lab-view.js';
import {
  IncrementalTerminalOutput,
  terminalCanvasRows,
} from './terminal-canvas.js';
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

class InsetDimensionSource {
  constructor(
    private readonly source: DimensionStore,
    private readonly bottomRows: number,
  ) {}
  private map(dimensions: TerminalDimensions): TerminalDimensions {
    return {
      ...dimensions,
      rows: Math.max(8, dimensions.rows - this.bottomRows),
    };
  }
  get() {
    return this.map(this.source.get());
  }
  subscribe(listener: (dimensions: TerminalDimensions) => void) {
    return this.source.subscribe((dimensions) =>
      listener(this.map(dimensions)),
    );
  }
}

function WorkControlHost({
  profile,
  workLoop,
  dimensions,
  onOpenLab,
  onSearchDocuments,
  isInputCaptured,
}: {
  profile: Profile;
  workLoop: WorkLoop;
  dimensions: InsetDimensionSource;
  onOpenLab: () => void;
  onSearchDocuments: (documents: ProductSearchDocument[]) => void;
  isInputCaptured: () => boolean;
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
    const documents: ProductSearchDocument[] = [
      ...(model.subject.id
        ? [
            {
              id: `work.initiative.${model.subject.id}`,
              kind: 'work' as const,
              title: model.subject.title,
              summary: model.subject.subtitle,
              keywords: ['initiative', model.subject.id],
              priority: 0,
              action: {
                kind: 'open-work' as const,
                workId: model.subject.id,
              },
            },
          ]
        : []),
      ...model.cards.map((card, index) => ({
        id: `work.assignment.${card.id}`,
        kind: 'work' as const,
        title: card.title,
        summary: `${card.summary} · ${card.status}`,
        keywords: ['assignment', card.id, card.status],
        priority: index + 1,
        action: { kind: 'open-work' as const, workId: card.id },
      })),
    ];
    onSearchDocuments(documents);
  }, [model, onSearchDocuments]);
  React.useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      if (isInputCaptured()) return;
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
  }, [exit, isInputCaptured, model, onOpenLab, refresh]);

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
  isInputCaptured,
}: {
  dimensions: InsetDimensionSource;
  onOpenLab: () => void;
  isInputCaptured: () => boolean;
}) {
  const { exit } = useApp();
  const [size, setSize] = React.useState(dimensions.get());
  React.useEffect(() => dimensions.subscribe(setSize), [dimensions]);
  React.useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      if (isInputCaptured()) return;
      const key = decodeShellKey(String(chunk));
      if (key === 'quit') exit();
      if (key === 'qualification-lab') onOpenLab();
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [exit, isInputCaptured, onOpenLab]);
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
      <Text dimColor>[a] Agent Work Lab · q quit</Text>
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
  const { exit } = useApp();
  const [size, setSize] = React.useState(dimensions.get());
  const [startup, setStartup] = React.useState<QualificationLabStartupRoute>();
  const [surface, setSurface] = React.useState<'auto' | 'lab' | 'work'>('auto');
  const [control, setControl] =
    React.useState<ControlPlaneState>(CLOSED_CONTROL_PLANE);
  const controlRef = React.useRef(control);
  const inputFence = React.useMemo(
    () =>
      createControlPlaneInputFence(
        () =>
          controlRef.current.mode !== 'closed' ||
          controlRef.current.focus === 'input',
      ),
    [],
  );
  const [cliDocuments, setCliDocuments] = React.useState<
    ProductSearchDocument[]
  >([]);
  const [workDocuments, setWorkDocuments] = React.useState<
    ProductSearchDocument[]
  >([]);
  const [catalogStatus, setCatalogStatus] = React.useState(
    'Loading governed command catalog',
  );
  const profile = React.useMemo(() => openTuiProfile(), []);
  const workLoop = React.useMemo(() => openTuiWorkLoop(), []);
  const contentDimensions = React.useMemo(
    () => new InsetDimensionSource(dimensions, 4),
    [dimensions],
  );
  React.useEffect(() => dimensions.subscribe(setSize), [dimensions]);
  React.useEffect(() => {
    let active = true;
    const paths = runtimePaths();
    void loadCliHelpSearchDocuments({
      bin: paths.bin,
      env: cliEnvironment() as Record<string, string | undefined>,
      execFile: (file, args, options) =>
        new Promise<string>((resolve, reject) => {
          execFile(file, args, options, (error, stdout, stderr) => {
            if (error)
              reject(new Error(describeCliFailure(error, stdout, stderr)));
            else resolve(stdout);
          });
        }),
    })
      .then((documents) => {
        if (!active) return;
        setCliDocuments(documents);
        setCatalogStatus(
          `${documents.length} governed Help and Command entries`,
        );
      })
      .catch((error) => {
        if (!active) return;
        setCatalogStatus(
          `Command catalog unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    return () => {
      active = false;
    };
  }, []);
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

  const resolvedStartup = startup ?? PENDING_STARTUP;
  const startupSurface = qualificationLabStartupSurface(resolvedStartup);
  const labOpen =
    surface === 'lab' ||
    (surface === 'auto' && startupSurface === 'qualification-lab');
  const viewDocuments = React.useMemo<ProductSearchDocument[]>(
    () => [
      {
        id: 'view.work-control',
        kind: 'view',
        title: 'Work Control',
        summary: 'Open the read-only Work and Profile projection.',
        keywords: ['home', 'assignments', 'initiatives'],
        action: { kind: 'open-view', viewId: 'work' },
      },
      {
        id: 'view.agent-work-lab',
        kind: 'view',
        title: 'Agent Work Lab',
        summary: 'Compare bounded Agent Work behavior across two Sessions.',
        keywords: ['qualification', 'handoff', 'session'],
        action: { kind: 'open-view', viewId: 'lab' },
      },
    ],
    [],
  );
  const quickSearchDocuments = React.useMemo<ProductSearchDocument[]>(
    () =>
      QUICK_COMMANDS.map((command, index) => ({
        id: `command.quick.${command.id}`,
        kind: 'command',
        title: command.command,
        summary: command.summary,
        section: 'Quick commands',
        keywords: [command.title],
        priority: index,
        action: {
          kind: 'describe-command',
          command: command.command,
        },
      })),
    [],
  );
  const documents = React.useMemo(
    () => [
      ...SYSTEM_HELP_DOCUMENTS,
      ...quickSearchDocuments,
      ...cliDocuments,
      ...workDocuments,
      ...viewDocuments,
    ],
    [cliDocuments, quickSearchDocuments, viewDocuments, workDocuments],
  );
  const searchResults = React.useMemo(
    () => searchProductDocuments(documents, control.query),
    [control.query, documents],
  );
  const quickCommands = React.useMemo(
    () => quickCommandMatches(control.query),
    [control.query],
  );
  const searchResultsRef = React.useRef(searchResults);
  const quickCommandsRef = React.useRef(quickCommands);
  searchResultsRef.current = searchResults;
  quickCommandsRef.current = quickCommands;

  const setControlNow = React.useCallback((next: ControlPlaneState) => {
    controlRef.current = next;
    setControl(next);
  }, []);
  const closeControl = React.useCallback(
    () => setControlNow(CLOSED_CONTROL_PLANE),
    [setControlNow],
  );
  const activateControl = React.useCallback(() => {
    const current = controlRef.current;
    if (current.mode === 'commands') {
      const command = quickCommandsRef.current[current.selected];
      if (!command) return;
      if (command.action === 'help') {
        setControlNow({
          mode: 'help',
          focus: 'input',
          query: '',
          selected: 0,
        });
      } else if (command.action === 'search') {
        setControlNow({
          mode: 'search',
          focus: 'input',
          query: '',
          selected: 0,
        });
      } else if (command.action === 'work') {
        setSurface('work');
        closeControl();
      } else if (command.action === 'lab') {
        setSurface('lab');
        closeControl();
      } else if (command.action === 'home') {
        setSurface('auto');
        closeControl();
      } else {
        exit();
      }
      return;
    }
    if (current.mode !== 'search') return;
    const result = searchResultsRef.current[current.selected];
    if (!result) return;
    if (result.action.kind === 'open-work') {
      setSurface('work');
      closeControl();
    } else if (result.action.kind === 'open-view') {
      setSurface(result.action.viewId === 'lab' ? 'lab' : 'work');
      closeControl();
    } else {
      setControlNow({
        mode: 'detail',
        focus: 'input',
        query: current.query,
        selected: current.selected,
        detail: result,
      });
    }
  }, [closeControl, exit, setControlNow]);
  const activateControlRef = React.useRef(activateControl);
  activateControlRef.current = activateControl;
  const isInputCaptured = React.useCallback(
    () => inputFence.isCaptured(),
    [inputFence],
  );
  React.useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      const current = controlRef.current;
      const itemCount =
        current.mode === 'commands'
          ? quickCommandsRef.current.length
          : current.mode === 'search'
            ? searchResultsRef.current.length
            : 0;
      const update = reduceControlPlaneInput(current, String(chunk), itemCount);
      if (!update.handled) return;
      inputFence.captureCurrentEmission();
      setControlNow(update.state);
      if (update.quit) return exit();
      if (update.activate) activateControlRef.current();
    };
    process.stdin.prependListener('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [exit, inputFence, setControlNow]);

  let content: React.ReactNode;
  if (!startup && surface !== 'lab') {
    content = (
      <StartingHost
        dimensions={contentDimensions}
        onOpenLab={() => setSurface('lab')}
        isInputCaptured={isInputCaptured}
      />
    );
  } else if (labOpen) {
    content = (
      <AgentWorkLabHost
        lab={lab}
        startup={resolvedStartup}
        dimensions={contentDimensions}
        isInputCaptured={isInputCaptured}
        onOpenWork={
          startupSurface === 'work-graph' ? () => setSurface('work') : undefined
        }
      />
    );
  } else {
    content = (
      <WorkControlHost
        profile={profile}
        workLoop={workLoop}
        dimensions={contentDimensions}
        onOpenLab={() => setSurface('lab')}
        onSearchDocuments={setWorkDocuments}
        isInputCaptured={isInputCaptured}
      />
    );
  }

  const resultCount =
    control.mode === 'commands'
      ? quickCommands.length
      : control.mode === 'search'
        ? searchResults.length
        : 0;
  return (
    <Box
      width={size.columns}
      height={terminalCanvasRows(size.rows)}
      flexDirection="column"
      overflow="hidden"
    >
      {content}
      <ControlPlaneOverlay
        dimensions={contentDimensions.get()}
        state={control}
        searchResults={searchResults}
        quickCommands={quickCommands}
        catalogStatus={catalogStatus}
      />
      <ControlPlaneBar
        dimensions={size}
        state={control}
        resultCount={resultCount}
      />
    </Box>
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

void main()
  .then(() => {
    // Ink has released the terminal at this point. Exit explicitly so an
    // in-flight discovery child cannot keep the user's shell in the foreground
    // after the visible TUI has already closed.
    process.exit(process.exitCode ?? 0);
  })
  .catch((error) => {
    process.stderr.write(`Kungfu TUI failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
