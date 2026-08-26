// SPDX-License-Identifier: Apache-2.0

import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, constants as osConstants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgentWorkLab,
  type AgentWorkLabStartupRoute,
  type GlobalWorkFilter,
  type GlobalWorkSnapshot,
  type KungfuOnboardingState,
  type ProductSearchDocument,
  type ProjectTemplateCreationReceipt,
  type ProjectTemplateWorkspaceSelection,
  type ProjectWorkCapturePlan,
  type ProjectWorkCaptureReceipt,
  type ProjectWorkRunPlan,
  type ProjectWorkRunSnapshot,
  type Projects,
  type ProjectsCatalog,
  type WorkCloseReceipt,
  type WorkReviewReceipt,
  type WorkStartReceipt,
  applyProjectWorkspaceEnvironment,
  beginKungfuOnboardingRoute,
  dismissKungfuOnboarding,
  finishKungfuOnboarding,
  kungfuAgentBriefCommand,
  kungfuAgentFirstPrompt,
  loadCliHelpSearchDocuments,
  openAgentWorkLab,
  openProjects,
  projectSearchDocuments,
  searchProductDocuments,
  shouldShowKungfuOnboarding,
} from '@kungfu-tech/api/capability';
import { Box, Text, render, useApp } from 'ink';
import React from 'react';
import {
  createAttachedAgentSessionHost,
  createDetachedAgentSessionHost,
  prepareAgentSessionNodePty,
} from '../../agent-session/src/product-client.mjs';
import {
  AGENT_WORK_LAB_QUICK_COMMANDS,
  AgentFirstOnboardingView,
  type AgentWorkLabActionRequest,
  type AgentWorkLabAutoplayResult,
  AgentWorkLabHost,
  type AgentWorkLabSuiteAction,
  type TuiOnboardingAction,
  agentWorkLabActionReturnsToControls,
  readTuiOnboardingState,
  useTransientOnboardingNotice,
} from './agent-work-lab-view.js';
import { copyTextToClipboard } from './clipboard/index.js';
import { scrollListSelection } from './list-window/index.js';
import { boundedIndex, decodeShellKey } from './navigation.js';
import {
  CLOSED_CONTROL_PLANE,
  ControlPlaneBar,
  ControlPlaneOverlay,
  type ControlPlaneState,
  KUNGFU_EMPTY_WORK_NEBULA_PATTERN,
  KUNGFU_PROJECT_DISCOVERY_PATTERN,
  KUNGFU_STARTUP_NEBULA_PATTERN,
  KUNGFU_WORK_DISCOVERY_PATTERN,
  PlaybackBar,
  type ProductSurface,
  QUICK_COMMANDS,
  TerminalAmbientScene,
  type TerminalDimensions,
  TerminalLoadingScene,
  buildTuiProductSearchDocuments,
  contextualProjectRestoreCanCommit,
  createControlPlaneInputFence,
  directWorkspaceNavigationFromInput,
  initialProductSurface,
  onboardingContinueSurface,
  projectWorkOwnsInput,
  quickCommandMatches,
  reduceControlPlaneInput,
  resolveProductStartupSurface,
  shouldStartContextualProjectRestore,
  splitHorizontalPointerActionAtPoint,
  terminalAnimationsEnabled,
} from './profile-shell.js';
import {
  ProjectFileTreeNavigation,
  type ProjectPathCopyNotice,
  ProjectPathCopyOverlay,
  projectNavigationWidth,
  projectWorkAmbientRows,
} from './project-files-view/index.js';
import {
  PROJECTS_QUICK_COMMANDS,
  PROJECT_WORK_QUICK_COMMANDS,
  type ProjectWorkQuickAction,
  type ProjectWorkspaceSelection,
  type ProjectsActionRequest,
  ProjectsHost,
  type ProjectsQuickAction,
  projectWorkQuickCommandAvailable,
} from './projects-view/index.js';
import { runtimeSurfaceDiagnostic } from './runtime-surface.js';
import {
  type OpenedStarterProject,
  type ProjectTourEpisode,
  type ProjectTourResult,
  ProjectTourView,
  StarterProjectHost,
  cleanupProjectTourTemporaryProject,
  parseProjectTourLaunchOptions,
  playbackQuitRequested,
  workReceiptHasRetainedSession,
} from './starter-project-view/index.js';
import {
  IncrementalTerminalOutput,
  synchronizedTerminalOutputEnabled,
  terminalCanvasRows,
} from './terminal-canvas.js';
import {
  TerminalLifecycle,
  bindTuiMockAgentEnvironment,
  decodeTerminalMouseInput,
  describeCliFailure,
  existingProjectWorkspaceRoot,
  resolveTuiAgentSessionExecutable,
  resolveTuiAgentSessionPaths,
  resolveTuiCliInvocation,
  resolveTuiCliRuntime,
  resolveTuiProductPaths,
  resolveTuiRuntimeDir,
} from './terminal-lifecycle.js';
import {
  globalWorkContribution,
  loadLatestGlobalWorkCache,
  startGlobalWorkObserver,
} from './work-control-contribution.js';
import {
  type ProjectWorkActionRequest,
  ProjectWorkHost,
  type WorkSort,
  WorkWindow,
  type WorkWindowModel,
  buildWorkWindowModel,
  cycleWorkSort,
  workWindowListContainsPoint,
} from './work-window/index.js';
const nodeRequire = createRequire(import.meta.url);
let tuiAgentSessionEndpoint = '';
let tuiAgentSessionReady: Promise<string> | undefined;
type TuiAgentSessionHost =
  | ReturnType<typeof createAttachedAgentSessionHost>
  | ReturnType<typeof createDetachedAgentSessionHost>;
let tuiAgentSessionHost: TuiAgentSessionHost | undefined;
let tuiAgentSessionRuntimeDir = '';
function tuiAgentSessionEnvironment(
  env: NodeJS.ProcessEnv,
  optional = false,
): NodeJS.ProcessEnv {
  if (optional && !tuiAgentSessionEndpoint) return { ...env };
  return {
    ...env,
    KF_RUNTIME_DIR: tuiAgentSessionRuntimeDir,
    KUNGFU_AGENT_SESSION_ENDPOINT: tuiAgentSessionEndpoint,
    KUNGFU_PROJECT_WORK_AGENT_SESSION: '1',
  };
}
function ensureTuiAgentSession(runtimeDir: string): Promise<string> {
  const resolvedRuntimeDir = path.resolve(runtimeDir);
  if (
    tuiAgentSessionReady &&
    tuiAgentSessionRuntimeDir === resolvedRuntimeDir &&
    tuiAgentSessionHost
  ) {
    const host = tuiAgentSessionHost;
    tuiAgentSessionReady = tuiAgentSessionReady.then(async () => {
      await host.invoke({ operation: 'capabilities' });
      return host.endpoint;
    });
    return tuiAgentSessionReady;
  }
  const { packageRoot, workerPath, mockPath } = resolveTuiAgentSessionPaths({
    env: process.env,
    argvEntry: process.argv[1],
    modulePath: fileURLToPath(import.meta.url),
  });
  const ptyModule = (root: string) =>
    path.join(root, 'node_modules', 'node-pty', 'lib', 'index.js');
  const packagedPty = ptyModule(path.dirname(workerPath));
  const sourcePty = ptyModule(packageRoot);
  process.env.KUNGFU_AGENT_SESSION_NODE_PTY_MODULE = prepareAgentSessionNodePty(
    {
      runtimeDir: resolvedRuntimeDir,
      modulePath: fs.existsSync(packagedPty) ? packagedPty : sourcePty,
    },
  );
  process.env.KUNGFU_AGENT_SESSION_WORKER = workerPath;
  process.env.KUNGFU_MOCK_AGENT_SCRIPT = mockPath;
  process.env.KUNGFU_PROJECT_WORK_AGENT_SESSION = '1';
  const paths = runtimePaths();
  const mockScenario = process.env.KUNGFU_MOCK_AGENT_SCENARIO;
  const deterministicMock = Boolean(mockScenario?.trim());
  const host = deterministicMock
    ? createAttachedAgentSessionHost({
        runtimeDir: resolvedRuntimeDir,
        ptyModule: process.env.KUNGFU_AGENT_SESSION_NODE_PTY_MODULE,
        env: process.env,
      })
    : createDetachedAgentSessionHost({
        runtimeDir: resolvedRuntimeDir,
        executable: resolveTuiAgentSessionExecutable({
          env: process.env,
          cliBin: paths.bin,
          sourceCliFallback: paths.sourceCliFallback,
          processExecPath: process.execPath,
        }),
        workerPath,
        env: process.env,
      });
  tuiAgentSessionHost = host;
  tuiAgentSessionRuntimeDir = resolvedRuntimeDir;
  tuiAgentSessionEndpoint = host.endpoint;
  process.env.KUNGFU_AGENT_SESSION_ENDPOINT = host.endpoint;
  tuiAgentSessionReady = Promise.resolve(
    host.invoke({ operation: 'capabilities' }),
  ).then(() => host.endpoint);
  return tuiAgentSessionReady;
}
async function closeTuiAgentSession() {
  const host = tuiAgentSessionHost;
  tuiAgentSessionHost = undefined;
  tuiAgentSessionReady = undefined;
  tuiAgentSessionEndpoint = tuiAgentSessionRuntimeDir = '';
  if (host && 'close' in host) await host.close();
}
async function invokeTuiAgentSession(
  request: Record<string, unknown> & { operation: string },
) {
  while (true) {
    const ready = tuiAgentSessionReady;
    const host = tuiAgentSessionHost;
    if (!ready || !host) {
      throw new Error('Agent Session control is unavailable on this surface');
    }
    await ready;
    if (ready !== tuiAgentSessionReady || host !== tuiAgentSessionHost) {
      continue;
    }
    return host.invoke(request);
  }
}
function runtimePaths() {
  const { coreDir, kungfuDir, packagedBin } = resolveTuiProductPaths({
    env: process.env,
    resolveCorePackageJson: () =>
      nodeRequire.resolve('@kungfu-tech/core/package.json'),
  });
  const cli = resolveTuiCliRuntime({ env: process.env, packagedBin });
  return {
    coreDir,
    packagedBin,
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
    ...cli,
  };
}
function tuiCliInvocation(paths: ReturnType<typeof runtimePaths>) {
  return resolveTuiCliInvocation(paths, process.env);
}
function bindMockAgentEnvironment(
  cli: ReturnType<typeof tuiCliInvocation>,
  paths: ReturnType<typeof runtimePaths>,
) {
  const { mockPath } = resolveTuiAgentSessionPaths({
    env: process.env,
    argvEntry: process.argv[1],
    modulePath: fileURLToPath(import.meta.url),
  });
  cli.env = bindTuiMockAgentEnvironment({
    env: cli.env,
    packagedBin: paths.packagedBin,
    mockPath,
  });
}
function streamCliEvents({
  file,
  args,
  env,
  maxBuffer,
  onLine,
  label,
}: {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  onLine: (line: string) => void;
  label: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdoutBuffer = '';
    const stderrChunks: unknown[] = [];
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
            : new Error(`invalid ${label} event: ${String(reason)}`),
        );
        return false;
      }
    };
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      outputSize += text.length;
      if (outputSize > maxBuffer) {
        fail(new Error(`${label} event stream exceeded maxBuffer`));
        return;
      }
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/u);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) if (!emitLine(line)) return;
    });
    child.stderr.on('data', stderrChunks.push.bind(stderrChunks));
    child.once('error', fail);
    child.once('close', (code, signal) => {
      if (settled || !emitLine(stdoutBuffer)) return;
      if (code !== 0) {
        fail(
          new Error(
            stderrChunks.join('').trim() ||
              `${label} event stream exited ${code ?? signal ?? 'unknown'}`,
          ),
        );
        return;
      }
      settled = true;
      resolve();
    });
  });
}
type ExitHistoryStatus = {
  ok: boolean;
  state: string;
  coverage: string;
  lastVerifiedExport: { bundleId: string; packageRoot: string } | null;
  nextActions: string[];
};
const EXIT_HISTORY_STATUS_FALLBACK: ExitHistoryStatus = {
  ok: false,
  state: 'unavailable',
  coverage: 'not-evaluated',
  lastVerifiedExport: null,
  nextActions: ['kungfu exit history status --json'],
};
async function openTuiAgentWorkLab(projectTour = false): Promise<AgentWorkLab> {
  const paths = runtimePaths();
  const cli = tuiCliInvocation(paths);
  bindMockAgentEnvironment(cli, paths);
  if (projectTour) {
    const endpoint = await ensureTuiAgentSession(paths.runtimeDir);
    cli.env.KUNGFU_AGENT_SESSION_ENDPOINT = endpoint;
    cli.env.KUNGFU_ASSIGNMENT_ADMIT_ALLOW_FOREIGN_BINDING = '1';
  }
  return openAgentWorkLab({
    runtimeDir: paths.runtimeDir,
    bin: cli.bin,
    env: cli.env,
    allowForeignBinding: paths.sourceCliFallback || projectTour,
    execFileSync: (file, values, options) =>
      execFileSync(file, cli.args(values), options),
    execFile: (file, values, options) =>
      new Promise<string>((resolve, reject) => {
        execFile(file, cli.args(values), options, (error, stdout, stderr) => {
          if (error)
            reject(new Error(describeCliFailure(error, stdout, stderr)));
          else resolve(stdout);
        });
      }),
    execFileEvents: async (file, values, options, onLine) => {
      if (tuiAgentSessionReady) {
        await ensureTuiAgentSession(tuiAgentSessionRuntimeDir);
      }
      return streamCliEvents({
        file,
        args: cli.args(values),
        env: tuiAgentSessionEnvironment(options.env, true),
        maxBuffer: options.maxBuffer,
        onLine,
        label: 'qualification',
      });
    },
  });
}
function openTuiProjects(useAgentSession = true, allowForeignBinding = false) {
  const paths = runtimePaths();
  const cli = tuiCliInvocation(paths);
  bindMockAgentEnvironment(cli, paths);
  if (!useAgentSession) {
    cli.env.KUNGFU_PROJECT_WORK_AGENT_SESSION = undefined;
    cli.env.KUNGFU_AGENT_SESSION_ENDPOINT = undefined;
  }
  if (allowForeignBinding) {
    cli.env.KUNGFU_ASSIGNMENT_ADMIT_ALLOW_FOREIGN_BINDING = '1';
  }
  const machineConfigHome = process.env.KF_PROJECTS_CONFIG_HOME;
  return openProjects({
    bin: cli.bin,
    env: cli.env,
    agentSessionClient: 'cli',
    agentSession: useAgentSession
      ? {
          invoke: invokeTuiAgentSession,
        }
      : undefined,
    catalogConfigHomes:
      machineConfigHome &&
      path.resolve(machineConfigHome) !== path.resolve(paths.configHome)
        ? [machineConfigHome]
        : [],
    execFile: (file, values, options) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          file,
          cli.args(values),
          {
            ...options,
            env: tuiAgentSessionEnvironment(options.env),
          },
          (error, stdout, stderr) => {
            if (error)
              reject(new Error(describeCliFailure(error, stdout, stderr)));
            else resolve(stdout);
          },
        );
      }),
    execFileInput: (file, values, input, options) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(file, cli.args(values), {
          env: tuiAgentSessionEnvironment(options.env),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let outputSize = 0;
        let settled = false;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          child.kill();
          reject(error);
        };
        const retain = (
          chunk: Buffer | string,
          target: 'stdout' | 'stderr',
        ) => {
          const text = String(chunk);
          outputSize += text.length;
          if (outputSize > options.maxBuffer) {
            fail(new Error('Project Work capture exceeded maxBuffer'));
            return;
          }
          if (target === 'stdout') stdout += text;
          else stderr += text;
        };
        child.stdout.on('data', (chunk) => retain(chunk, 'stdout'));
        child.stderr.on('data', (chunk) => retain(chunk, 'stderr'));
        child.once('error', fail);
        child.once('close', (code, signal) => {
          if (settled) return;
          if (code !== 0) {
            fail(
              new Error(
                stderr.trim() ||
                  `Project Work capture exited ${code ?? signal ?? 'unknown'}`,
              ),
            );
            return;
          }
          settled = true;
          resolve(stdout);
        });
        child.stdin.end(input);
      }),
    execFileEvents: async (file, values, options, onLine) => {
      if (tuiAgentSessionReady) await tuiAgentSessionReady;
      return streamCliEvents({
        file,
        args: cli.args(values),
        env: tuiAgentSessionEnvironment(options.env),
        maxBuffer: options.maxBuffer,
        onLine,
        label: 'Work',
      });
    },
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
  projects,
  dimensions,
  emptyState,
  onOpenLab,
  onSearchDocuments,
  onWorkspacePointer,
  isInputCaptured,
}: {
  projects: Projects;
  dimensions: InsetDimensionSource;
  emptyState: boolean;
  onOpenLab: () => void;
  onSearchDocuments: (documents: ProductSearchDocument[]) => void;
  onWorkspacePointer: () => void;
  isInputCaptured: () => boolean;
}) {
  const { exit } = useApp();
  const paths = React.useMemo(() => runtimePaths(), []);
  const cli = React.useMemo(() => tuiCliInvocation(paths), [paths]);
  const observerStatePath = React.useMemo(
    () => path.join(paths.configHome, 'tui', 'global-work-observer.json'),
    [paths.configHome],
  );
  const initialSnapshot = React.useMemo(
    () =>
      emptyState
        ? EMPTY_GLOBAL_WORK_SNAPSHOT
        : loadLatestGlobalWorkCache(
            (candidate) => fs.readFileSync(candidate, 'utf8'),
            [
              observerStatePath,
              path.join(paths.configHome, 'gui', 'global-work-observer.json'),
            ],
          ),
    [emptyState, observerStatePath, paths.configHome],
  );
  const [size, setSize] = React.useState(dimensions.get());
  const [snapshot, setSnapshot] = React.useState<GlobalWorkSnapshot | null>(
    initialSnapshot,
  );
  const [filter, setFilter] = React.useState<GlobalWorkFilter>('active');
  const [sort, setSort] = React.useState<WorkSort>('updated-desc');
  const [projectCatalog, setProjectCatalog] = React.useState<ProjectsCatalog>();
  const [busy, setBusy] = React.useState(initialSnapshot === null);
  const [observerError, setObserverError] = React.useState('');
  const [selectedCard, setSelectedCard] = React.useState(0);
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
      setSnapshot(snapshot);
      onSearchDocuments(contribution.searchDocuments);
      setObserverError('');
      setBusy(false);
    },
    [onSearchDocuments],
  );

  React.useEffect(() => dimensions.subscribe(setSize), [dimensions]);
  React.useEffect(() => {
    if (emptyState) return undefined;
    let active = true;
    void projects
      .list()
      .then((catalog) => {
        if (active) setProjectCatalog(catalog);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [emptyState, projects]);
  React.useEffect(() => {
    if (initialSnapshot) applySnapshot(initialSnapshot);
    if (emptyState) return undefined;
    fs.mkdirSync(path.dirname(observerStatePath), { recursive: true });
    return startGlobalWorkObserver({
      bin: cli.bin,
      argsPrefix: cli.argsPrefix,
      env: cli.env,
      statePath: observerStatePath,
      spawn: (file, args, options) => spawn(file, args, options),
      onSnapshot: applySnapshot,
      onError: (error) => {
        setObserverError(error.message);
        setBusy(false);
      },
    });
  }, [applySnapshot, cli, emptyState, initialSnapshot, observerStatePath]);
  const model = React.useMemo(
    (): WorkWindowModel =>
      snapshot
        ? buildWorkWindowModel(snapshot, {
            filter,
            sort,
            projects: projectCatalog,
          })
        : {
            filter,
            sort,
            counts: { active: 0, completed: 0, all: 0 },
            groups: [],
            items: [],
            observedAt: '',
            verified: false,
            notice: 'Loading all Work…',
          },
    [filter, projectCatalog, snapshot, sort],
  );
  React.useEffect(() => {
    const onData = (chunk: Buffer | string) => {
      const value = String(chunk);
      const mouseEvents = decodeTerminalMouseInput(value);
      if (mouseEvents.length > 0) {
        for (const event of mouseEvents) {
          if (
            event.kind !== 'wheel' ||
            !workWindowListContainsPoint({
              dimensions: size,
              column: event.column,
              row: event.row,
              topOffset: 1,
            })
          ) {
            continue;
          }
          const delta = event.button === 'wheel-up' ? -1 : 1;
          setSelectedCard((current) =>
            scrollListSelection({
              current,
              delta,
              itemCount: model.items.length,
            }),
          );
          onWorkspacePointer();
        }
        return;
      }
      if (isInputCaptured()) return;
      const key = decodeShellKey(value);
      if (key === 'quit') return exit();
      if (key === 'agent-work-lab') return onOpenLab();
      if (value === 'f' || key === 'next-subject') {
        setFilter((current) => {
          const filters: GlobalWorkFilter[] = ['active', 'completed', 'all'];
          return (
            filters[
              boundedIndex(filters.indexOf(current), 1, filters.length)
            ] ?? current
          );
        });
        return;
      }
      if (key === 'previous-subject') {
        setFilter((current) => {
          const filters: GlobalWorkFilter[] = ['active', 'completed', 'all'];
          return (
            filters[
              boundedIndex(filters.indexOf(current), -1, filters.length)
            ] ?? current
          );
        });
        return;
      }
      if (value === 's') {
        setSort(cycleWorkSort);
        setSelectedCard(0);
        return;
      }
      if (key === 'refresh') {
        if (emptyState) {
          applySnapshot(EMPTY_GLOBAL_WORK_SNAPSHOT);
          return;
        }
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
          boundedIndex(current, 1, model.items.length),
        );
      } else if (key === 'previous-card') {
        setSelectedCard((current) =>
          boundedIndex(current, -1, model.items.length),
        );
      }
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [
    applySnapshot,
    emptyState,
    exit,
    isInputCaptured,
    model,
    observerStatePath,
    onOpenLab,
    onWorkspacePointer,
    paths.configHome,
    size,
  ]);

  React.useEffect(() => {
    setSelectedCard((current) =>
      Math.min(current, Math.max(0, model.items.length - 1)),
    );
  }, [model.items.length]);
  const displayedModel = observerError
    ? {
        ...model,
        notice: [model.notice, `live observer: ${observerError}`]
          .filter(Boolean)
          .join(' · '),
      }
    : model;

  if (!snapshot && busy) {
    return (
      <TerminalLoadingScene
        dimensions={{
          ...size,
          rows: terminalCanvasRows(size.rows),
        }}
        title="ALL WORK"
        status="Reading the machine Work graph"
        detail="Joining retained Work with its local Project coordinates."
        pattern={KUNGFU_WORK_DISCOVERY_PATTERN}
      />
    );
  }

  return (
    <WorkWindow
      model={displayedModel}
      dimensions={size}
      selected={selectedCard}
      busy={busy}
    />
  );
}

const PENDING_STARTUP: AgentWorkLabStartupRoute = {
  schema: 'kungfu.agent-work-lab.startup-route/v1',
  state: 'verified-empty',
  route: 'agent-work-lab',
  reasonCode: 'startup-inspection-pending',
  message: 'Kungfu is reading local Project, Work, and Agent state.',
  runtimeDir: '',
  workGraphPresent: null,
  evidence: [],
  writeOccurred: false,
};

const EMPTY_GLOBAL_WORK_SNAPSHOT: GlobalWorkSnapshot = {
  schema: 'kungfu.workspace-federation.query/v1',
  observed_at: '',
  aggregate: {
    state: 'complete',
    component_count: 0,
    available_component_count: 0,
    unknown_component_count: 0,
    conflict_count: 0,
  },
  verification: { ok: true },
  global_work: {
    visible_work: [],
    visible_work_count: 0,
    canonical_work_count: 0,
    conflict_count: 0,
    label_collision_count: 0,
  },
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
    <TerminalLoadingScene
      dimensions={{
        ...size,
        rows: terminalCanvasRows(size.rows),
      }}
      title="KUNGFU"
      status="Opening your Work control plane"
      detail="Reading local Projects, Work, and Agent evidence."
      pattern={KUNGFU_STARTUP_NEBULA_PATTERN}
    />
  );
}

function ProductHost({
  lab,
  dimensions,
  autoDemo = false,
  projectTourRoot,
  projectTourSpeed = 1,
  projectTourEpisode = '1',
  emptyState = false,
  onAutoDemoSettled,
  onProjectTourSettled,
  onPlaybackQuit,
}: {
  lab: AgentWorkLab;
  dimensions: DimensionStore;
  autoDemo?: boolean;
  projectTourRoot?: string;
  projectTourSpeed?: number;
  projectTourEpisode?: ProjectTourEpisode;
  emptyState?: boolean;
  onAutoDemoSettled?: (result: AgentWorkLabAutoplayResult) => void;
  onProjectTourSettled?: (result: ProjectTourResult) => void;
  onPlaybackQuit?: () => void;
}) {
  const { exit } = useApp();
  const playbackMode = autoDemo || Boolean(projectTourRoot);
  const openLab = process.argv.includes('--agent-work-lab-open');
  const [size, setSize] = React.useState(dimensions.get());
  const [onboardingState, setOnboardingState] =
    React.useState<KungfuOnboardingState>(() => {
      const paths = runtimePaths();
      return readTuiOnboardingState(paths.configHome);
    });
  const [onboardingNotice, setOnboardingNotice] =
    useTransientOnboardingNotice();
  const firstLaunch = !openLab && shouldShowKungfuOnboarding(onboardingState);
  const startupProjectRoot = React.useMemo(
    () =>
      emptyState
        ? ''
        : existingProjectWorkspaceRoot(process.cwd(), process.env),
    [emptyState],
  );
  const [startup, setStartup] = React.useState<
    AgentWorkLabStartupRoute | undefined
  >(playbackMode ? PENDING_STARTUP : undefined);
  const [surface, setSurfaceState] = React.useState<ProductSurface>(
    initialProductSurface({ playbackMode, firstLaunch, emptyState, openLab }),
  );
  const startupSurface = React.useRef(surface).current;
  const startupAnimationEnabled = React.useMemo(
    () => terminalAnimationsEnabled(process.env),
    [],
  );
  const [startupIntroSettled, setStartupIntroSettled] = React.useState(
    playbackMode || firstLaunch || emptyState || !startupAnimationEnabled,
  );
  const surfaceRef = React.useRef(surface);
  const setSurface = React.useCallback((next: ProductSurface) => {
    surfaceRef.current = next;
    setSurfaceState(next);
  }, []);
  const projects = React.useMemo(
    () => openTuiProjects(!projectTourRoot, Boolean(projectTourRoot)),
    [projectTourRoot],
  );
  const [starterProject, setStarterProject] =
    React.useState<OpenedStarterProject>();
  const [starterWorkReceipt, setStarterWorkReceipt] =
    React.useState<WorkStartReceipt>();
  const [starterReviewReceipt, setStarterReviewReceipt] =
    React.useState<WorkReviewReceipt>();
  const [starterCloseReceipt, setStarterCloseReceipt] =
    React.useState<WorkCloseReceipt>();
  const [labActionRequest, setLabActionRequest] =
    React.useState<AgentWorkLabActionRequest>();
  const nextLabActionId = React.useRef(0);
  const [projectActionRequest, setProjectActionRequest] =
    React.useState<ProjectsActionRequest>();
  const nextProjectActionId = React.useRef(0);
  const [projectWorkActionRequest, setProjectWorkActionRequest] =
    React.useState<ProjectWorkActionRequest>();
  const nextProjectWorkActionId = React.useRef(0);
  const [openedProject, setOpenedProject] =
    React.useState<ProjectWorkspaceSelection>();
  const productNavActions = React.useMemo(
    () =>
      [
        { action: 'work', label: '[1] All Work' },
        {
          action: 'projects',
          label: openedProject
            ? `[2] Project · ${path.basename(openedProject.workspace_root)}`
            : '[2] Projects',
        },
        { action: 'lab', label: '[3] Agent Work Lab' },
      ] as const,
    [openedProject],
  );
  const openProjectRequest = React.useRef(0);
  const [projectWorkLoading, setProjectWorkLoading] = React.useState(false);
  const [projectResumeSettled, setProjectResumeSettled] = React.useState(
    playbackMode || emptyState || !startupProjectRoot,
  );
  const [control, setControl] =
    React.useState<ControlPlaneState>(CLOSED_CONTROL_PLANE);
  const controlRef = React.useRef(control);
  const [workspaceInputActive, setWorkspaceInputActiveState] =
    React.useState(false);
  const workspaceInputActiveRef = React.useRef(false);
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
  const [projectDocuments, setProjectDocuments] = React.useState<
    ProductSearchDocument[]
  >([]);
  const [catalogStatus, setCatalogStatus] = React.useState(
    playbackMode
      ? 'Offline demo automation owns this run'
      : 'Loading governed command catalog',
  );
  const [historyStatus, setHistoryStatus] = React.useState<ExitHistoryStatus>(
    EXIT_HISTORY_STATUS_FALLBACK,
  );
  const contentDimensions = React.useMemo(
    () => new InsetDimensionSource(dimensions, 6),
    [dimensions],
  );
  React.useEffect(() => dimensions.subscribe(setSize), [dimensions]);
  React.useEffect(() => {
    if (playbackMode || surface === 'onboarding') return undefined;
    const paths = runtimePaths();
    const invocation = tuiCliInvocation(paths);
    let active = true;
    execFile(
      invocation.bin,
      invocation.args(['exit', 'history', 'status', '--json']),
      {
        encoding: 'utf8',
        env: invocation.env,
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout) => {
        if (!active) return;
        if (error) {
          setHistoryStatus(EXIT_HISTORY_STATUS_FALLBACK);
          return;
        }
        try {
          const value = JSON.parse(stdout) as ExitHistoryStatus;
          setHistoryStatus(
            value.ok && value.nextActions?.length
              ? value
              : EXIT_HISTORY_STATUS_FALLBACK,
          );
        } catch {
          setHistoryStatus(EXIT_HISTORY_STATUS_FALLBACK);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [playbackMode, surface]);
  React.useEffect(() => {
    if (playbackMode || firstLaunch || emptyState || !startupAnimationEnabled)
      return undefined;
    const timer = setTimeout(() => setStartupIntroSettled(true), 540);
    return () => clearTimeout(timer);
  }, [emptyState, firstLaunch, playbackMode, startupAnimationEnabled]);
  React.useEffect(() => {
    if (playbackMode || control.mode === 'closed' || cliDocuments.length > 0)
      return;
    let active = true;
    const paths = runtimePaths();
    const invocation = tuiCliInvocation(paths);
    void loadCliHelpSearchDocuments({
      bin: invocation.bin,
      env: invocation.env as Record<string, string | undefined>,
      execFile: (file, args, options) =>
        new Promise<string>((resolve, reject) => {
          execFile(
            file,
            invocation.args(args),
            options,
            (error, stdout, stderr) => {
              if (error)
                reject(new Error(describeCliFailure(error, stdout, stderr)));
              else resolve(stdout);
            },
          );
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
  }, [cliDocuments.length, control.mode, playbackMode]);
  React.useEffect(() => {
    if (playbackMode || surface !== 'lab' || startup) return;
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
  }, [lab, playbackMode, startup, surface]);
  React.useEffect(() => {
    if (
      !shouldStartContextualProjectRestore({
        playbackMode,
        surface: startupSurface,
        emptyState,
        startupProjectRoot,
      })
    ) {
      return;
    }
    if (!startupProjectRoot) return;
    let active = true;
    const request = openProjectRequest.current + 1;
    openProjectRequest.current = request;
    setProjectWorkLoading(true);
    void projects
      .select(startupProjectRoot)
      .then(async (receipt) => {
        if (!active || !contextualProjectRestoreCanCommit(surfaceRef.current)) {
          return;
        }
        const selected = receipt as {
          workspace: ProjectWorkspaceSelection;
        };
        setOpenedProject(selected.workspace);
        applyProjectWorkspaceEnvironment(process.env, {
          schema: 'kungfu.workspace.registry/v1',
          last_workspace_id: selected.workspace.workspace_id,
          recent: [selected.workspace],
          updated_at: '',
          registry_path: '',
          selected: selected.workspace,
        } as unknown as ProjectTemplateWorkspaceSelection);
        setSurface('project-work');
        const inventory = await projects.works(
          selected.workspace.workspace_root,
        );
        const work = inventory.activeWork;
        if (
          !active ||
          request !== openProjectRequest.current ||
          surfaceRef.current !== 'project-work' ||
          !work
        ) {
          return;
        }
        const workspace = {
          schema: 'kungfu.workspace.registry/v1',
          last_workspace_id: selected.workspace.workspace_id,
          recent: [selected.workspace],
          updated_at: '',
          registry_path: '',
          selected: selected.workspace,
        } as unknown as ProjectTemplateWorkspaceSelection;
        const resumed = await lab.resumeProjectWork({
          destination: selected.workspace.workspace_root,
          initialWork: {
            initiativeId: work.initiativeId,
            assignmentId: work.assignmentId,
            requestPath: work.requestPath,
          },
        });
        if (
          !active ||
          request !== openProjectRequest.current ||
          surfaceRef.current !== 'project-work'
        ) {
          return;
        }
        setStarterProject({ workspace, work, works: inventory.works });
        setStarterWorkReceipt(resumed.workReceipt);
        setStarterReviewReceipt(resumed.reviewReceipt);
        setStarterCloseReceipt(resumed.closeReceipt);
        setSurface(
          workReceiptHasRetainedSession(resumed.workReceipt)
            ? 'project-work'
            : 'project-assignment',
        );
      })
      .catch(() => undefined)
      .finally(() => {
        if (active && request === openProjectRequest.current) {
          setProjectWorkLoading(false);
          setProjectResumeSettled(true);
        }
      });
    return () => {
      active = false;
    };
  }, [
    emptyState,
    lab,
    playbackMode,
    projects,
    setSurface,
    startupProjectRoot,
    startupSurface,
  ]);
  const autoplay = React.useMemo(
    () =>
      autoDemo
        ? {
            onSettled: (result: AgentWorkLabAutoplayResult) => {
              onAutoDemoSettled?.(result);
              exit();
            },
          }
        : undefined,
    [autoDemo, exit, onAutoDemoSettled],
  );
  const projectTourSettled = React.useCallback(
    (result: ProjectTourResult) => {
      onProjectTourSettled?.(result);
      exit();
    },
    [exit, onProjectTourSettled],
  );

  const resolvedStartup = startup ?? PENDING_STARTUP;
  const labOpen = surface === 'lab';
  const starterOpen =
    surface === 'project-assignment' && Boolean(starterProject);
  React.useEffect(() => {
    if (playbackMode || surface !== 'loading' || !startupIntroSettled) return;
    const resolved = resolveProductStartupSurface({
      contextualProject: Boolean(startupProjectRoot),
      openedProject: Boolean(openedProject),
      projectResumeSettled,
    });
    if (resolved) setSurface(resolved);
  }, [
    playbackMode,
    openedProject,
    projectResumeSettled,
    setSurface,
    startupProjectRoot,
    startupIntroSettled,
    surface,
  ]);
  const availableQuickCommands = React.useMemo(
    () =>
      labOpen
        ? [...AGENT_WORK_LAB_QUICK_COMMANDS, ...QUICK_COMMANDS]
        : surface === 'projects'
          ? [...PROJECTS_QUICK_COMMANDS, ...QUICK_COMMANDS]
          : projectWorkQuickCommandAvailable({
                surface,
                hasOpenedProject: Boolean(openedProject),
                completedWork: starterCloseReceipt?.status === 'completed',
              })
            ? [...PROJECT_WORK_QUICK_COMMANDS, ...QUICK_COMMANDS]
            : QUICK_COMMANDS,
    [labOpen, openedProject, starterCloseReceipt?.status, surface],
  );
  const documents = React.useMemo(
    () =>
      buildTuiProductSearchDocuments({
        quickCommands: availableQuickCommands,
        cliDocuments,
        workDocuments,
        projectDocuments,
      }),
    [availableQuickCommands, cliDocuments, projectDocuments, workDocuments],
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
    (focus: ControlPlaneState['focus'] = 'input') =>
      setControlNow({ ...CLOSED_CONTROL_PLANE, focus }),
    [setControlNow],
  );
  const agentFirstEntry = React.useMemo(() => {
    const paths = runtimePaths();
    const invocation = tuiCliInvocation(paths);
    const command = kungfuAgentBriefCommand(
      invocation.bin,
      invocation.argsPrefix,
    );
    return { command, prompt: kungfuAgentFirstPrompt(command) };
  }, []);
  const persistOnboarding = React.useCallback(
    (next: KungfuOnboardingState, onSaved?: () => void) => {
      const paths = runtimePaths();
      const invocation = tuiCliInvocation(paths);
      execFile(
        invocation.bin,
        invocation.args([
          'config',
          'set',
          'ui.onboarding',
          JSON.stringify(next),
          '--scope',
          'user',
          '--json',
        ]),
        { env: invocation.env, maxBuffer: 2 * 1024 * 1024 },
        (error) => {
          if (error) {
            setOnboardingNotice({
              ok: false,
              title: 'GETTING STARTED STATE NOT SAVED',
              detail: error.message,
              next: 'Press Enter to continue without saving this state.',
            });
            setControlNow({
              ...CLOSED_CONTROL_PLANE,
              focus: 'workspace',
              notice: `Could not save Getting Started state: ${error.message}`,
            });
            return;
          }
          setOnboardingNotice(undefined);
          setOnboardingState(next);
          onSaved?.();
        },
      );
    },
    [setControlNow, setOnboardingNotice],
  );
  const setWorkspaceInputActive = React.useCallback(
    (active: boolean) => {
      workspaceInputActiveRef.current = active;
      setWorkspaceInputActiveState(active);
      if (active) {
        setControlNow({ ...CLOSED_CONTROL_PLANE, focus: 'workspace' });
      }
    },
    [setControlNow],
  );
  const dispatchLabAction = React.useCallback(
    (action: AgentWorkLabSuiteAction) => {
      nextLabActionId.current += 1;
      setLabActionRequest({ id: nextLabActionId.current, action });
    },
    [],
  );
  const handleOnboardingAction = React.useCallback(
    (action: TuiOnboardingAction) => {
      if (action === 'copy') {
        const receipt = copyTextToClipboard(agentFirstEntry.prompt, {
          exec: (file, args, options) =>
            execFileSync(file, args, { ...options, encoding: 'utf8' }),
        });
        setOnboardingNotice(
          receipt.ok
            ? {
                ok: true,
                title: 'ONE-LINE AGENT PROMPT COPIED',
                detail: 'Paste it into your Agent in another window.',
                next: 'Optional: [Enter] start · [L/l] Lab · [T/t] Tour.',
              }
            : {
                ok: false,
                title: 'COPY PROMPT FAILED',
                detail: receipt.error,
                next: 'Optional: [Enter] start · [L/l] Lab · [T/t] Tour.',
              },
        );
      } else if (action === 'lab') {
        persistOnboarding(
          beginKungfuOnboardingRoute(onboardingState, 'lab'),
          () => setSurface('lab'),
        );
      } else if (action === 'tour') {
        persistOnboarding(
          beginKungfuOnboardingRoute(onboardingState, 'tour'),
          () => {
            setSurface('lab');
            dispatchLabAction('lab-starter');
          },
        );
      } else if (action === 'dismiss') {
        persistOnboarding(dismissKungfuOnboarding(onboardingState), () =>
          setSurface('all-work'),
        );
      } else {
        persistOnboarding(finishKungfuOnboarding(onboardingState), () => {
          setSurface(onboardingContinueSurface(firstLaunch));
          setControlNow({ ...CLOSED_CONTROL_PLANE, focus: 'workspace' });
        });
      }
    },
    [
      agentFirstEntry.prompt,
      dispatchLabAction,
      firstLaunch,
      onboardingState,
      persistOnboarding,
      setControlNow,
      setOnboardingNotice,
      setSurface,
    ],
  );
  const acknowledgeLabAction = React.useCallback((id: number) => {
    setLabActionRequest((current) =>
      current?.id === id ? undefined : current,
    );
  }, []);
  const dispatchProjectAction = React.useCallback(
    (action: ProjectsQuickAction) => {
      nextProjectActionId.current += 1;
      setProjectActionRequest({
        id: nextProjectActionId.current,
        action,
      });
    },
    [],
  );
  const acknowledgeProjectAction = React.useCallback((id: number) => {
    setProjectActionRequest((current) =>
      current?.id === id ? undefined : current,
    );
  }, []);
  const dispatchProjectWorkAction = React.useCallback(
    (action: ProjectWorkQuickAction) => {
      nextProjectWorkActionId.current += 1;
      setProjectWorkActionRequest({
        id: nextProjectWorkActionId.current,
        action,
      });
    },
    [],
  );
  const acknowledgeProjectWorkAction = React.useCallback((id: number) => {
    setProjectWorkActionRequest((current) =>
      current?.id === id ? undefined : current,
    );
  }, []);
  const handleProjectDocuments = React.useCallback(
    (catalog: ProjectsCatalog) =>
      setProjectDocuments(projectSearchDocuments(catalog)),
    [],
  );
  const openProject = React.useCallback(
    (selection: ProjectWorkspaceSelection) => {
      const request = openProjectRequest.current + 1;
      openProjectRequest.current = request;
      setOpenedProject(selection);
      setStarterProject(undefined);
      setStarterWorkReceipt(undefined);
      setStarterReviewReceipt(undefined);
      setStarterCloseReceipt(undefined);
      setProjectWorkLoading(true);
      setControlNow({ ...CLOSED_CONTROL_PLANE, focus: 'workspace' });
      surfaceRef.current = 'project-work';
      setSurface('project-work');
      applyProjectWorkspaceEnvironment(process.env, {
        schema: 'kungfu.workspace.registry/v1',
        last_workspace_id: selection.workspace_id,
        recent: [selection],
        updated_at: '',
        registry_path: '',
        selected: selection,
      } as unknown as ProjectTemplateWorkspaceSelection);
      void lab
        .resumeStarterProject()
        .then((resumed) => {
          if (
            !resumed ||
            request !== openProjectRequest.current ||
            surfaceRef.current !== 'project-work' ||
            resumed.project.workspace.selected.workspace_root !==
              selection.workspace_root
          ) {
            return;
          }
          setStarterProject(resumed.project);
          setStarterWorkReceipt(resumed.workReceipt);
          setStarterReviewReceipt(resumed.reviewReceipt);
          setStarterCloseReceipt(resumed.closeReceipt);
          setSurface('project-assignment');
        })
        .catch(() => undefined)
        .finally(() => {
          if (request === openProjectRequest.current) {
            setProjectWorkLoading(false);
          }
        });
    },
    [lab, setControlNow, setSurface],
  );
  const openGlobalWork = React.useCallback(() => {
    setControlNow({ ...CLOSED_CONTROL_PLANE, focus: 'workspace' });
    setSurface('all-work');
  }, [setControlNow, setSurface]);
  const openHome = React.useCallback(() => {
    setControlNow({ ...CLOSED_CONTROL_PLANE, focus: 'workspace' });
    if (starterProject) setSurface('project-assignment');
    else if (openedProject) setSurface('project-work');
    else setSurface('all-work');
  }, [openedProject, setControlNow, setSurface, starterProject]);
  const activateControl = React.useCallback(() => {
    const current = controlRef.current;
    if (current.mode === 'commands') {
      const command = quickCommandsRef.current[current.selected];
      if (!command) return;
      if (command.action === 'help') {
        setControlNow({
          mode: 'help',
          focus: 'input',
          returnFocus: current.returnFocus,
          query: '',
          selected: 0,
        });
      } else if (command.action === 'search') {
        setControlNow({
          mode: 'search',
          focus: 'input',
          returnFocus: current.returnFocus,
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
          returnFocus: current.returnFocus,
          query: 'health',
          selected: 0,
          detail: health,
        });
      } else if (command.action === 'new-work') {
        if (openedProject) {
          setSurface('project-work');
          dispatchProjectWorkAction('project-work-new');
          setControlNow({ ...CLOSED_CONTROL_PLANE, focus: 'workspace' });
        } else {
          setSurface('projects');
          setControlNow({
            ...CLOSED_CONTROL_PLANE,
            focus: 'workspace',
            notice: 'Choose a Project before creating Work.',
          });
        }
      } else if (command.action === 'work') {
        openGlobalWork();
        closeControl('workspace');
      } else if (command.action === 'projects') {
        setSurface('projects');
        closeControl('workspace');
      } else if (command.action === 'lab') {
        setSurface('lab');
        closeControl('workspace');
      } else if (command.action === 'onboarding') {
        setSurface('onboarding');
        closeControl('workspace');
      } else if (command.action === 'home') {
        openHome();
        closeControl('workspace');
      } else if (command.action === 'quit') {
        exit();
      } else if (
        PROJECT_WORK_QUICK_COMMANDS.some(
          (candidate) => candidate.action === command.action,
        )
      ) {
        setSurface('project-work');
        dispatchProjectWorkAction(command.action as ProjectWorkQuickAction);
        setControlNow({ ...CLOSED_CONTROL_PLANE, focus: 'workspace' });
      } else if (
        PROJECTS_QUICK_COMMANDS.some(
          (candidate) => candidate.action === command.action,
        )
      ) {
        setSurface('projects');
        dispatchProjectAction(command.action as ProjectsQuickAction);
        closeControl('workspace');
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
      openGlobalWork();
      closeControl('workspace');
    } else if (result.action.kind === 'open-project') {
      void projects
        .select(result.action.projectPath)
        .then((receipt) =>
          openProject(
            (
              receipt as unknown as {
                workspace: ProjectWorkspaceSelection;
              }
            ).workspace,
          ),
        )
        .catch(() => setSurface('projects'));
      closeControl('workspace');
    } else if (result.action.kind === 'open-view') {
      if (result.action.viewId === 'work') {
        openGlobalWork();
      } else if (result.action.viewId === 'onboarding') {
        setSurface('onboarding');
      } else {
        setSurface(result.action.viewId === 'lab' ? 'lab' : 'projects');
      }
      closeControl('workspace');
    } else {
      setControlNow({
        mode: 'detail',
        focus: 'input',
        returnFocus: current.returnFocus,
        query: current.query,
        selected: current.selected,
        detail: result,
      });
    }
  }, [
    cliDocuments,
    closeControl,
    dispatchLabAction,
    dispatchProjectAction,
    dispatchProjectWorkAction,
    exit,
    openGlobalWork,
    openHome,
    openProject,
    openedProject,
    projects,
    setControlNow,
    setSurface,
  ]);
  const activateControlRef = React.useRef(activateControl);
  activateControlRef.current = activateControl;
  const isInputCaptured = React.useCallback(
    () => playbackMode || inputFence.isCaptured(),
    [inputFence, playbackMode],
  );
  React.useEffect(() => {
    if (!playbackMode) return;
    const onData = (chunk: Buffer | string) => {
      if (!playbackQuitRequested(chunk)) return;
      onPlaybackQuit?.();
      exit();
    };
    process.stdin.prependListener('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [exit, onPlaybackQuit, playbackMode]);
  React.useEffect(() => {
    if (playbackMode || surface === 'onboarding') return;
    const onData = (chunk: Buffer | string) => {
      if (workspaceInputActiveRef.current) return;
      const mouseEvents = decodeTerminalMouseInput(chunk);
      if (mouseEvents.length > 0) {
        for (const event of mouseEvents) {
          if (event.kind !== 'press' || event.button !== 'left') continue;
          const navigation = splitHorizontalPointerActionAtPoint({
            actions: productNavActions,
            column: event.column,
            row: event.row,
            targetRow: 1,
            width: size.columns,
            startColumn: 2,
            gap: 2,
          });
          if (navigation) {
            setControlNow({ ...CLOSED_CONTROL_PLANE, focus: 'workspace' });
            if (navigation === 'work') openGlobalWork();
            else if (navigation === 'projects' && openedProject) openHome();
            else setSurface(navigation);
            continue;
          }
          const canvasRows = terminalCanvasRows(size.rows);
          if (
            event.row >= canvasRows - 3 &&
            event.row <= canvasRows &&
            event.column >= 1 &&
            event.column <= size.columns
          ) {
            const current = controlRef.current;
            setControlNow({
              ...current,
              focus: 'input',
              notice: undefined,
            });
          }
        }
        return;
      }
      const current = controlRef.current;
      if (projectWorkOwnsInput(current, String(chunk), surfaceRef.current)) {
        return;
      }
      const directNavigation = directWorkspaceNavigationFromInput(
        current,
        String(chunk),
        surfaceRef.current,
      );
      if (directNavigation === 'projects') {
        inputFence.captureCurrentEmission();
        setControlNow({ ...CLOSED_CONTROL_PLANE, focus: 'workspace' });
        setSurface('projects');
        return;
      }
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
  }, [
    playbackMode,
    surface,
    dispatchLabAction,
    exit,
    inputFence,
    labOpen,
    openGlobalWork,
    openHome,
    openedProject,
    productNavActions,
    setControlNow,
    setSurface,
    size,
  ]);

  React.useEffect(() => {
    if (playbackMode || surface === 'onboarding') return;
    const onData = (chunk: Buffer | string) => {
      if (workspaceInputActiveRef.current || isInputCaptured()) return;
      const value = String(chunk);
      if (value === '1') openGlobalWork();
      else if (value === '2') {
        if (openedProject) openHome();
        else setSurface('projects');
      } else if (value === '3') setSurface('lab');
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [
    isInputCaptured,
    openGlobalWork,
    openHome,
    openedProject,
    playbackMode,
    setSurface,
    surface,
  ]);

  let content: React.ReactNode;
  if (projectTourRoot) {
    content = (
      <ProjectTourView
        lab={lab}
        projects={projects}
        destination={projectTourRoot}
        columns={size.columns}
        rows={size.rows}
        playbackSpeed={projectTourSpeed}
        episode={projectTourEpisode}
        onSettled={projectTourSettled}
      />
    );
  } else if (surface === 'onboarding') {
    content = (
      <AgentFirstOnboardingView
        dimensions={{
          ...size,
          rows: terminalCanvasRows(size.rows),
        }}
        state={onboardingState}
        command={agentFirstEntry.command}
        prompt={agentFirstEntry.prompt}
        notice={onboardingNotice}
        onAction={handleOnboardingAction}
      />
    );
  } else if (starterOpen && starterProject) {
    content = (
      <StarterProjectHost
        project={starterProject}
        lab={lab}
        ensureAgentSession={ensureTuiAgentSession}
        dimensions={contentDimensions}
        isInputCaptured={isInputCaptured}
        onOpenLab={() => setSurface('lab')}
        onOpenProjects={() => setSurface('projects')}
        onWorkspacePointer={() =>
          setControlNow({ ...CLOSED_CONTROL_PLANE, focus: 'workspace' })
        }
        onCreateNextWork={() => {
          setOpenedProject(
            starterProject.workspace
              .selected as unknown as ProjectWorkspaceSelection,
          );
          setSurface('project-work');
          dispatchProjectWorkAction('project-work-new');
          setControlNow({ ...CLOSED_CONTROL_PLANE, focus: 'workspace' });
        }}
        onRetainedAgentSession={(receipt) => {
          setStarterWorkReceipt(receipt);
          setOpenedProject(
            starterProject.workspace
              .selected as unknown as ProjectWorkspaceSelection,
          );
          setSurface('project-work');
          setControlNow({ ...CLOSED_CONTROL_PLANE, focus: 'workspace' });
        }}
        initialWorkReceipt={starterWorkReceipt}
        initialReviewReceipt={starterReviewReceipt}
        initialCloseReceipt={starterCloseReceipt}
      />
    );
  } else if (surface === 'projects') {
    content = (
      <ProjectsHost
        projects={projects}
        dimensions={contentDimensions}
        isInputCaptured={isInputCaptured}
        onOpenProject={openProject}
        onOpenLab={() => setSurface('lab')}
        onSearchDocuments={handleProjectDocuments}
        onInputModeChange={setWorkspaceInputActive}
        onWorkspacePointer={() =>
          setControlNow({ ...CLOSED_CONTROL_PLANE, focus: 'workspace' })
        }
        openedProject={openedProject}
        actionRequest={projectActionRequest}
        onActionHandled={acknowledgeProjectAction}
      />
    );
  } else if (surface === 'loading') {
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
        autoplay={autoplay}
        onWorkspacePointer={() =>
          setControlNow({ ...CLOSED_CONTROL_PLANE, focus: 'workspace' })
        }
        onOpenStarterProject={(
          receipt: ProjectTemplateCreationReceipt,
          workspace: ProjectTemplateWorkspaceSelection,
        ) => {
          if (
            onboardingState.route === 'tour' ||
            onboardingState.route === 'lab'
          ) {
            persistOnboarding(
              finishKungfuOnboarding(onboardingState, {
                route: onboardingState.route,
                labCompleted: onboardingState.route === 'lab',
                tourCompleted: onboardingState.route === 'tour',
              }),
            );
          }
          applyProjectWorkspaceEnvironment(process.env, workspace);
          setStarterProject({ receipt, workspace });
          setStarterWorkReceipt(undefined);
          setStarterReviewReceipt(undefined);
          setStarterCloseReceipt(undefined);
          setOpenedProject(
            workspace.selected as unknown as ProjectWorkspaceSelection,
          );
          setSurface('project-assignment');
        }}
      />
    );
  } else if (surface === 'project-work' && openedProject) {
    content = (
      <ProjectWorkHost
        key={openedProject.workspace_root}
        projects={projects}
        project={openedProject}
        dimensions={contentDimensions}
        ensureAgentSession={ensureTuiAgentSession}
        onContinueRetainedWork={async (receipt) => {
          const inventory = await projects.works(openedProject.workspace_root);
          const work = inventory.works.find(
            (candidate) =>
              candidate.initiativeId === receipt.work?.initiativeId &&
              candidate.assignmentId === receipt.work?.assignmentId,
          );
          if (!work) {
            throw new Error(
              'Kungfu could not bind this retained run to its Project review flow.',
            );
          }
          const workspace = {
            schema: 'kungfu.workspace.registry/v1',
            last_workspace_id: openedProject.workspace_id,
            recent: [openedProject],
            updated_at: '',
            registry_path: '',
            selected: openedProject,
          } as unknown as ProjectTemplateWorkspaceSelection;
          const resumed = await lab.resumeProjectWork({
            destination: openedProject.workspace_root,
            initialWork: {
              initiativeId: work.initiativeId,
              assignmentId: work.assignmentId,
              requestPath: work.requestPath,
            },
          });
          setStarterProject({ workspace, work, works: inventory.works });
          setStarterWorkReceipt(resumed.workReceipt ?? receipt);
          setStarterReviewReceipt(resumed.reviewReceipt);
          setStarterCloseReceipt(resumed.closeReceipt);
          setSurface('project-assignment');
        }}
        onOpenProjects={() => setSurface('projects')}
        onOpenLab={() => setSurface('lab')}
        onOpenCapturedWork={(plan, receipt) => {
          const workspace = {
            schema: 'kungfu.workspace.registry/v1',
            last_workspace_id: openedProject.workspace_id,
            recent: [openedProject],
            updated_at: '',
            registry_path: '',
            selected: openedProject,
          } as unknown as ProjectTemplateWorkspaceSelection;
          const work = {
            initiativeId: plan.initiativeId,
            assignmentId: plan.assignmentId,
            title: plan.title,
            objective: plan.objective,
            acceptanceChecks: plan.acceptanceChecks,
            requestRoot: receipt.requestRoot,
            receiptRoot: receipt.receiptRoot,
            requestPath: receipt.requestPath,
            state: 'captured-pending-admission' as const,
          };
          setStarterProject({
            workspace,
            work,
            works: [
              ...(starterProject?.works ??
                starterProject?.receipt?.works ??
                []),
              work,
            ].filter(
              (candidate, index, all) =>
                all.findIndex(
                  (row) =>
                    row.initiativeId === candidate.initiativeId &&
                    row.assignmentId === candidate.assignmentId,
                ) === index,
            ),
          });
          setStarterWorkReceipt(undefined);
          setStarterReviewReceipt(undefined);
          setStarterCloseReceipt(undefined);
          setSurface('project-assignment');
          setControlNow({ ...CLOSED_CONTROL_PLANE, focus: 'workspace' });
        }}
        onInputModeChange={setWorkspaceInputActive}
        onWorkspacePointer={() =>
          setControlNow({ ...CLOSED_CONTROL_PLANE, focus: 'workspace' })
        }
        loadingWork={projectWorkLoading}
        initialWorkReceipt={starterWorkReceipt}
        allowNewWorkOverRetainedRun={
          starterCloseReceipt?.status === 'completed'
        }
        actionRequest={projectWorkActionRequest}
        onActionHandled={acknowledgeProjectWorkAction}
        isInputCaptured={isInputCaptured}
      />
    );
  } else if (surface === 'all-work') {
    content = (
      <WorkControlHost
        projects={projects}
        dimensions={contentDimensions}
        emptyState={emptyState}
        onOpenLab={() => setSurface('lab')}
        onSearchDocuments={setWorkDocuments}
        onWorkspacePointer={() =>
          setControlNow({ ...CLOSED_CONTROL_PLANE, focus: 'workspace' })
        }
        isInputCaptured={isInputCaptured}
      />
    );
  } else {
    content = (
      <StartingHost
        dimensions={contentDimensions}
        onOpenLab={() => setSurface('lab')}
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
      {!playbackMode && surface !== 'onboarding' ? (
        <Box height={1} paddingX={1}>
          <Box flexGrow={1} flexShrink={1} gap={2} overflow="hidden">
            <Text
              color={surface === 'all-work' ? 'cyan' : undefined}
              bold={surface === 'all-work'}
              wrap="truncate-end"
            >
              [1] All Work
            </Text>
            <Text
              color={
                surface === 'projects' ||
                surface === 'project-work' ||
                surface === 'project-assignment'
                  ? 'cyan'
                  : undefined
              }
              bold={
                surface === 'projects' ||
                surface === 'project-work' ||
                surface === 'project-assignment'
              }
              wrap="truncate-end"
            >
              [2]{' '}
              {openedProject
                ? `Project · ${path.basename(openedProject.workspace_root)}`
                : 'Projects'}
            </Text>
          </Box>
          <Box flexShrink={0} marginLeft={2} gap={2}>
            <Text color={labOpen ? 'cyan' : undefined} bold={labOpen}>
              [3] Agent Work Lab
            </Text>
          </Box>
        </Box>
      ) : null}
      {!playbackMode && surface !== 'onboarding' ? (
        <Box height={1} paddingX={1} overflow="hidden">
          <Text
            color={historyStatus.ok ? 'green' : 'yellow'}
            wrap="truncate-end"
          >
            History {historyStatus.state} · coverage {historyStatus.coverage} ·
            last export {historyStatus.lastVerifiedExport?.bundleId ?? 'none'} ·
            Next: {historyStatus.nextActions[0]}
          </Text>
        </Box>
      ) : null}
      {content}
      {playbackMode ? (
        <PlaybackBar
          dimensions={size}
          label="DEMO PLAYBACK"
          status={
            projectTourRoot
              ? projectTourEpisode === 'all'
                ? 'Project Tour · Episodes 1–2 · full story'
                : projectTourEpisode === '1'
                  ? 'Project Tour · Episode 1/2 · Work survives failure'
                  : 'Project Tour · Episode 2/2 · recover, review, settle'
              : 'Agent Work Lab · Offline continuity'
          }
          hint="q Exit · Automatic playback · exits after the final result"
        />
      ) : surface !== 'onboarding' ? (
        <>
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
            workspaceInputActive={workspaceInputActive}
            controlsLabel={
              labOpen
                ? 'LAB CONTROLS'
                : surface === 'projects'
                  ? workspaceInputActive
                    ? 'PROJECT INPUT'
                    : 'PROJECT CONTROLS'
                  : starterOpen || surface === 'project-work'
                    ? openedProject
                      ? workspaceInputActive
                        ? 'NEW WORK INPUT'
                        : 'PROJECT WORK CONTROLS'
                      : 'PROJECT WORK CONTROLS'
                    : 'ALL WORK CONTROLS'
            }
            controlsHint={
              labOpen
                ? 'd Demo · x Same · m Handoff · Tab Focus'
                : surface === 'projects'
                  ? workspaceInputActive
                    ? 'Type in the focused panel · Enter Continue · Esc Cancel'
                    : 'Enter Open · /new New Project · /open Open Project · d Remove'
                  : starterOpen
                    ? 'j/k Work · Enter Open · /new New Work · p Projects'
                    : surface === 'project-work' && openedProject
                      ? workspaceInputActive
                        ? 'Type in the focused panel · Enter Continue · Esc Cancel'
                        : 't Files · Enter Run · /new New Work · p Projects'
                      : `f Active/Completed/All · s Sort · j/k Work · [2] ${
                          openedProject ? 'Project' : 'Projects'
                        } · /new Work`
            }
          />
        </>
      ) : null}
    </Box>
  );
}

function printNonInteractiveDiagnostic(): void {
  const paths = runtimePaths();
  process.stdout.write(
    `${JSON.stringify(
      runtimeSurfaceDiagnostic(
        process.argv,
        paths.runtimeDir,
        tuiCliInvocation(paths),
      ),
    )}\n`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write(
      'Kungfu Work Control TUI\n\nRun in an interactive terminal.\nVerified receipt diagnostic: `kungfu --diagnostic --runtime-surface-receipt receipt.json`.\nOffline animation demo: `kungfu agent-work-lab autoplay`.\nProject recovery tour: `kungfu agent-work-lab project-tour`.\nAgent brief: `kungfu agent brief`.\n',
    );
    return;
  }
  const autoDemo = process.argv.includes('--agent-work-lab-autoplay');
  const {
    root: projectTourRoot,
    speed: projectTourSpeed,
    episode: projectTourEpisode,
  } = parseProjectTourLaunchOptions(process.argv);
  const lab = await openTuiAgentWorkLab(Boolean(projectTourRoot));
  const playbackMode = autoDemo || Boolean(projectTourRoot);
  const emptyState = process.argv.includes('--empty-state');
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
    if (playbackMode) process.exitCode = 2;
    return;
  }
  const lifecycle = new TerminalLifecycle(
    process.stdin,
    process.stdout,
    process,
  );
  const dimensions = new DimensionStore(lifecycle.dimensions());
  const terminalOutput = new IncrementalTerminalOutput(process.stdout, {
    synchronizedOutput: synchronizedTerminalOutputEnabled(process.env),
  });
  let instance: ReturnType<typeof render> | undefined;
  let autoDemoResult: AgentWorkLabAutoplayResult | undefined;
  let projectTourResult: ProjectTourResult | undefined;
  let playbackQuit = false;
  let terminating = false;
  try {
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
        instance = render(
          <ProductHost
            lab={lab}
            dimensions={dimensions}
            autoDemo={autoDemo}
            projectTourRoot={projectTourRoot}
            projectTourSpeed={projectTourSpeed}
            projectTourEpisode={projectTourEpisode}
            emptyState={emptyState}
            onAutoDemoSettled={(result) => {
              autoDemoResult = result;
            }}
            onProjectTourSettled={(result) => {
              projectTourResult = result;
            }}
            onPlaybackQuit={() => {
              playbackQuit = true;
            }}
          />,
          {
            stdin: process.stdin,
            stdout: terminalOutput as unknown as NodeJS.WriteStream,
            stderr: process.stderr,
            exitOnCtrlC: false,
            patchConsole: false,
            debug: true,
          },
        );
        await instance.waitUntilExit();
      },
    );
  } finally {
    await closeTuiAgentSession();
  }
  if (autoDemo && !playbackQuit) {
    if (!autoDemoResult) {
      throw new Error('Agent Work Lab autoplay exited without a result');
    }
    const completion =
      autoDemoResult.state === 'completed'
        ? {
            schema: 'kungfu.agent-work-lab.tui-autoplay/v1',
            status: autoDemoResult.report.status,
            reportRoot: autoDemoResult.report.reportRoot,
            eventCount: autoDemoResult.report.events.length,
          }
        : {
            schema: 'kungfu.agent-work-lab.tui-autoplay/v1',
            status: 'failed',
            message: autoDemoResult.message,
          };
    process.stdout.write(
      `KUNGFU_TUI_DEMO_COMPLETE ${JSON.stringify(completion)}\n`,
    );
    if (
      autoDemoResult.state === 'failed' ||
      autoDemoResult.report.status === 'failed'
    ) {
      process.exitCode = 1;
    }
  }
  if (projectTourRoot) {
    cleanupProjectTourTemporaryProject(projectTourRoot);
    if (playbackQuit) return;
    if (!projectTourResult) {
      throw new Error('Project Work tour exited without a result');
    }
    const completion =
      projectTourResult.state === 'completed'
        ? projectTourResult.report
        : {
            schema: 'kungfu.project-work.tui-tour/v1',
            status: 'failed',
            message: projectTourResult.message,
          };
    process.stdout.write(
      `KUNGFU_PROJECT_TOUR_COMPLETE ${JSON.stringify(completion)}\n`,
    );
    if (projectTourResult.state === 'failed') process.exitCode = 1;
  }
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
