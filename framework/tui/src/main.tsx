// SPDX-License-Identifier: Apache-2.0

import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { constants as osConstants } from 'node:os';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  type AgentWorkLab,
  type AgentWorkLabStartupRoute,
  type GlobalWorkSnapshot,
  type ProductSearchDocument,
  SYSTEM_HELP_DOCUMENTS,
  agentWorkLabStartupSurface,
  loadCliHelpSearchDocuments,
  openAgentWorkLab,
  searchProductDocuments,
} from '@kungfu-tech/api/capability';
import { Box, Text, render, useApp } from 'ink';
import React from 'react';

import {
  AGENT_WORK_LAB_QUICK_COMMANDS,
  type AgentWorkLabActionRequest,
  AgentWorkLabHost,
  type AgentWorkLabSuiteAction,
  agentWorkLabActionReturnsToControls,
} from './agent-work-lab-view.js';
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
  degradedGlobalWorkModel,
  globalWorkContribution,
  loadLatestGlobalWorkCache,
  startGlobalWorkObserver,
} from './work-control-contribution.js';

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
    configHome:
      process.env.KF_CONFIG_HOME || path.join(homedir(), '.kungfu-config'),
    bin:
      process.env.KUNGFU_CLI_BIN ||
      process.env.KUNGFU_BIN ||
      (fs.existsSync(packagedBin) ? packagedBin : 'kungfu'),
  };
}

function openTuiAgentWorkLab(): AgentWorkLab {
  const paths = runtimePaths();
  return openAgentWorkLab({
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
  dimensions,
  onOpenLab,
  onSearchDocuments,
  isInputCaptured,
}: {
  dimensions: InsetDimensionSource;
  onOpenLab: () => void;
  onSearchDocuments: (documents: ProductSearchDocument[]) => void;
  isInputCaptured: () => boolean;
}) {
  const { exit } = useApp();
  const paths = React.useMemo(() => runtimePaths(), []);
  const observerStatePath = React.useMemo(
    () => path.join(paths.configHome, 'tui', 'global-work-observer.json'),
    [paths.configHome],
  );
  const initialSnapshot = React.useMemo(
    () =>
      loadLatestGlobalWorkCache(
        (candidate) => fs.readFileSync(candidate, 'utf8'),
        [
          observerStatePath,
          path.join(paths.configHome, 'gui', 'global-work-observer.json'),
        ],
      ),
    [observerStatePath, paths.configHome],
  );
  const [size, setSize] = React.useState(dimensions.get());
  const [model, setModel] = React.useState<ProfileShellModel>(() =>
    initialSnapshot
      ? globalWorkContribution(initialSnapshot).model
      : degradedGlobalWorkModel('loading global Portfolio'),
  );
  const [busy, setBusy] = React.useState(initialSnapshot === null);
  const [observerError, setObserverError] = React.useState('');
  const [selectedCard, setSelectedCard] = React.useState(0);
  const [activeRegion, setActiveRegion] = React.useState(1);
  const latestRevision = React.useRef('');

  const applySnapshot = React.useCallback(
    (snapshot: GlobalWorkSnapshot) => {
      const revision = JSON.stringify({
        projection: snapshot.global_work.projection_root,
        observedAt: snapshot.observed_at,
        visible: snapshot.global_work.visible_work_count,
        state: snapshot.aggregate.state,
      });
      if (revision === latestRevision.current) {
        setBusy(false);
        return;
      }
      latestRevision.current = revision;
      const contribution = globalWorkContribution(snapshot);
      setModel(contribution.model);
      onSearchDocuments(contribution.searchDocuments);
      setSelectedCard((current) =>
        Math.min(current, Math.max(0, contribution.model.cards.length - 1)),
      );
      setObserverError('');
      setBusy(false);
    },
    [onSearchDocuments],
  );

  React.useEffect(() => dimensions.subscribe(setSize), [dimensions]);
  React.useEffect(() => {
    if (initialSnapshot) applySnapshot(initialSnapshot);
    fs.mkdirSync(path.dirname(observerStatePath), { recursive: true });
    return startGlobalWorkObserver({
      bin: paths.bin,
      env: cliEnvironment(),
      statePath: observerStatePath,
      spawn: (file, args, options) => spawn(file, args, options),
      onSnapshot: applySnapshot,
      onError: (error) => {
        setObserverError(error.message);
        setBusy(false);
      },
    });
  }, [applySnapshot, initialSnapshot, observerStatePath, paths.bin]);
  React.useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      if (isInputCaptured()) return;
      const key = decodeShellKey(String(chunk));
      if (key === 'quit') return exit();
      if (key === 'agent-work-lab') return onOpenLab();
      if (key === 'refresh') {
        setBusy(true);
        const cached = loadLatestGlobalWorkCache(
          (candidate) => fs.readFileSync(candidate, 'utf8'),
          [
            observerStatePath,
            path.join(paths.configHome, 'gui', 'global-work-observer.json'),
          ],
        );
        if (cached) applySnapshot(cached);
        else setBusy(false);
        return;
      }
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
      }
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [
    applySnapshot,
    exit,
    isInputCaptured,
    model.cards.length,
    observerStatePath,
    onOpenLab,
    paths.configHome,
  ]);

  const displayedModel = observerError
    ? {
        ...model,
        notice: [model.notice, `live observer: ${observerError}`]
          .filter(Boolean)
          .join(' · '),
      }
    : model;

  return (
    <ProfileShell
      model={displayedModel}
      dimensions={size}
      selectedCard={selectedCard}
      activeRegion={activeRegion}
      busy={busy}
    />
  );
}

const PENDING_STARTUP: AgentWorkLabStartupRoute = {
  schema: 'kungfu.agent-work-lab.startup-route/v1',
  state: 'verified-empty',
  route: 'agent-work-lab',
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
      if (key === 'agent-work-lab') onOpenLab();
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
  lab: AgentWorkLab;
  dimensions: DimensionStore;
}) {
  const { exit } = useApp();
  const [size, setSize] = React.useState(dimensions.get());
  const [startup, setStartup] = React.useState<AgentWorkLabStartupRoute>();
  const [surface, setSurface] = React.useState<'auto' | 'lab' | 'work'>('auto');
  const [labActionRequest, setLabActionRequest] =
    React.useState<AgentWorkLabActionRequest>();
  const nextLabActionId = React.useRef(0);
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
          schema: 'kungfu.agent-work-lab.startup-route/v1',
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
  const startupSurface = agentWorkLabStartupSurface(resolvedStartup);
  const cachedGlobalWorkPresent = React.useMemo(() => {
    const paths = runtimePaths();
    return (
      (loadLatestGlobalWorkCache(
        (candidate) => fs.readFileSync(candidate, 'utf8'),
        [
          path.join(paths.configHome, 'tui', 'global-work-observer.json'),
          path.join(paths.configHome, 'gui', 'global-work-observer.json'),
        ],
      )?.global_work.visible_work.length ?? 0) > 0
    );
  }, []);
  const labOpen =
    surface === 'lab' ||
    (surface === 'auto' &&
      startupSurface === 'agent-work-lab' &&
      !cachedGlobalWorkPresent);
  const availableQuickCommands = React.useMemo(
    () =>
      labOpen
        ? [...AGENT_WORK_LAB_QUICK_COMMANDS, ...QUICK_COMMANDS]
        : QUICK_COMMANDS,
    [labOpen],
  );
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
      availableQuickCommands.map((command, index) => ({
        id: `command.quick.${command.id}`,
        kind: 'command',
        title: command.command,
        summary: command.summary,
        section: 'Quick actions',
        keywords: [command.title],
        priority: index,
        action: {
          kind: 'describe-command',
          command: command.command,
        },
      })),
    [availableQuickCommands],
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
    () => quickCommandMatches(control.query, availableQuickCommands),
    [availableQuickCommands, control.query],
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
  const dispatchLabAction = React.useCallback(
    (action: AgentWorkLabSuiteAction) => {
      nextLabActionId.current += 1;
      setLabActionRequest({ id: nextLabActionId.current, action });
    },
    [],
  );
  const acknowledgeLabAction = React.useCallback((id: number) => {
    setLabActionRequest((current) =>
      current?.id === id ? undefined : current,
    );
  }, []);
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
      } else if (command.action === 'health') {
        const health =
          cliDocuments.find(
            (document) =>
              document.action.kind === 'describe-command' &&
              document.action.command === 'kungfu health',
          ) ??
          ({
            id: 'command.health',
            kind: 'command',
            title: 'kungfu health',
            summary:
              'Inspect read-only runtime, Peer, storage, and Episode health.',
            section: 'Governed Commands',
            keywords: ['health', 'runtime', 'peer', 'storage', 'episode'],
            priority: 0,
            action: {
              kind: 'describe-command',
              command: 'kungfu health',
            },
          } satisfies ProductSearchDocument);
        setControlNow({
          mode: 'detail',
          focus: 'input',
          query: 'health',
          selected: 0,
          detail: health,
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
      } else if (command.action === 'quit') {
        exit();
      } else if (
        AGENT_WORK_LAB_QUICK_COMMANDS.some(
          (candidate) => candidate.action === command.action,
        )
      ) {
        setSurface('lab');
        dispatchLabAction(command.action as AgentWorkLabSuiteAction);
        setControlNow(
          agentWorkLabActionReturnsToControls(
            command.action as AgentWorkLabSuiteAction,
          )
            ? { ...CLOSED_CONTROL_PLANE, focus: 'workspace' }
            : CLOSED_CONTROL_PLANE,
        );
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
  }, [cliDocuments, closeControl, dispatchLabAction, exit, setControlNow]);
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
      if (update.workspaceNavigation && labOpen) {
        dispatchLabAction('lab-focus-next');
      }
      if (update.activate) activateControlRef.current();
    };
    process.stdin.prependListener('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [dispatchLabAction, exit, inputFence, labOpen, setControlNow]);

  let content: React.ReactNode;
  if (!startup && surface !== 'lab' && !cachedGlobalWorkPresent) {
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
        actionRequest={labActionRequest}
        onActionHandled={acknowledgeLabAction}
        onOpenWork={
          startupSurface === 'work-graph' ? () => setSurface('work') : undefined
        }
      />
    );
  } else {
    content = (
      <WorkControlHost
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
        surfaceLabel={labOpen ? 'Agent Work Lab' : 'Work Control'}
        controlsLabel={labOpen ? 'LAB CONTROLS' : 'WORK CONTROLS'}
        controlsHint={
          labOpen
            ? 'd Demo · x Same · m Handoff · Tab Focus'
            : 'Work navigation is active'
        }
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
  const lab = openTuiAgentWorkLab();
  if (process.argv.includes('--agent-work-lab-demo')) {
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
