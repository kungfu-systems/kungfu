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
  type GlobalWorkFilter,
  type GlobalWorkSnapshot,
  type ProductSearchDocument,
  type ProjectTemplateCreationReceipt,
  type ProjectTemplateWorkspaceSelection,
  type ProjectWorkCapturePlan,
  type ProjectWorkCaptureReceipt,
  type ProjectWorkRunPlan,
  type ProjectWorkRunSnapshot,
  type Projects,
  type ProjectsCatalog,
  SYSTEM_HELP_DOCUMENTS,
  type WorkCloseReceipt,
  type WorkReviewReceipt,
  type WorkStartReceipt,
  applyProjectWorkspaceEnvironment,
  loadCliHelpSearchDocuments,
  openAgentWorkLab,
  openProjects,
  projectSearchDocuments,
  searchProductDocuments,
} from '@kungfu-tech/api/capability';
import { Box, Text, render, useApp } from 'ink';
import React from 'react';

import {
  AGENT_WORK_LAB_QUICK_COMMANDS,
  type AgentWorkLabActionRequest,
  type AgentWorkLabAutoplayResult,
  AgentWorkLabHost,
  type AgentWorkLabSuiteAction,
  agentWorkLabActionReturnsToControls,
} from './agent-work-lab-view.js';
import { scrollListSelection } from './list-window/index.js';
import { boundedIndex, decodeShellKey } from './navigation.js';
import {
  CLOSED_CONTROL_PLANE,
  ControlPlaneBar,
  ControlPlaneOverlay,
  type ControlPlaneState,
  PlaybackBar,
  QUICK_COMMANDS,
  type TerminalDimensions,
  createControlPlaneInputFence,
  horizontalPointerActionAtPoint,
  quickCommandMatches,
  reduceControlPlaneInput,
  resolveProductStartupSurface,
} from './profile-shell.js';
import { ProjectFilesHost } from './project-files-view/index.js';
import {
  PROJECTS_QUICK_COMMANDS,
  PROJECT_WORK_QUICK_COMMANDS,
  type ProjectWorkQuickAction,
  type ProjectWorkspaceSelection,
  type ProjectsActionRequest,
  ProjectsHost,
  type ProjectsQuickAction,
} from './projects-view/index.js';
import {
  type OpenedStarterProject,
  StarterProjectHost,
} from './starter-project-view/index.js';
import {
  IncrementalTerminalOutput,
  terminalCanvasRows,
} from './terminal-canvas.js';
import {
  TerminalLifecycle,
  decodeTerminalMouseInput,
  describeCliFailure,
  existingProjectWorkspaceRoot,
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
  type WorkSort,
  WorkWindow,
  type WorkWindowModel,
  buildWorkWindowModel,
  cycleWorkSort,
  workWindowListContainsPoint,
} from './work-window/index.js';

const nodeRequire = createRequire(import.meta.url);

function cliEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // This process is running inside embedded libnode. Child `kungfu` calls must
  // re-enter the ordinary CLI instead of recursively selecting the Node host.
  env.KUNGFU_AS_VARIANT = undefined;
  return env;
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
  const argsPrefix = paths.sourceCliFallback
    ? ['run', '--project', paths.coreDir, '--frozen', 'python', '-m', 'kungfu']
    : [];
  const env = cliEnvironment();
  if (paths.sourceCliFallback) {
    env.PYTHONPATH = [
      path.join(paths.coreDir, 'src', 'python'),
      process.env.KUNGFU_NATIVE_PATH ||
        path.join(paths.coreDir, 'build', 'Release'),
      env.PYTHONPATH,
    ]
      .filter(Boolean)
      .join(path.delimiter);
  }
  return {
    bin: paths.sourceCliFallback ? 'uv' : paths.bin,
    env,
    argsPrefix,
    args: (values: string[]) => [...argsPrefix, ...values],
  };
}

function openTuiAgentWorkLab(): AgentWorkLab {
  const paths = runtimePaths();
  const cli = tuiCliInvocation(paths);
  return openAgentWorkLab({
    runtimeDir: paths.runtimeDir,
    bin: cli.bin,
    env: cli.env,
    allowForeignBinding: paths.sourceCliFallback,
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
    execFileEvents: (file, values, options, onLine) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(file, cli.args(values), {
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

function openTuiProjects() {
  const paths = runtimePaths();
  const cli = tuiCliInvocation(paths);
  return openProjects({
    bin: cli.bin,
    env: cli.env,
    execFile: (file, values, options) =>
      new Promise<string>((resolve, reject) => {
        execFile(file, cli.args(values), options, (error, stdout, stderr) => {
          if (error)
            reject(new Error(describeCliFailure(error, stdout, stderr)));
          else resolve(stdout);
        });
      }),
    execFileInput: (file, values, input, options) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(file, cli.args(values), {
          env: options.env,
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
    execFileEvents: (file, values, options, onLine) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(file, cli.args(values), {
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
                : new Error(`invalid Work event: ${String(reason)}`),
            );
            return false;
          }
        };
        child.stdout.on('data', (chunk) => {
          const text = String(chunk);
          outputSize += text.length;
          if (outputSize > options.maxBuffer) {
            fail(new Error('Work event stream exceeded maxBuffer'));
            return;
          }
          stdoutBuffer += text;
          const lines = stdoutBuffer.split(/\r?\n/u);
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
                  `Work event stream exited ${code ?? signal ?? 'unknown'}`,
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
  projects,
  dimensions,
  onOpenLab,
  onSearchDocuments,
  onWorkspacePointer,
  isInputCaptured,
}: {
  projects: Projects;
  dimensions: InsetDimensionSource;
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
  }, [projects]);
  React.useEffect(() => {
    if (initialSnapshot) applySnapshot(initialSnapshot);
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
  }, [applySnapshot, cli, initialSnapshot, observerStatePath]);
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

  return (
    <WorkWindow
      model={displayedModel}
      dimensions={size}
      selected={selectedCard}
      busy={busy}
    />
  );
}

type ProjectWorkActionRequest = {
  id: number;
  action: ProjectWorkQuickAction;
};

type ProjectWorkComposer = {
  step: 'objective' | 'acceptance' | 'preview' | 'capturing';
  objective: string;
  acceptanceCriterion: string;
  plan?: ProjectWorkCapturePlan;
};

function ProjectWorkHost({
  projects,
  project,
  dimensions,
  onContinueRetainedWork,
  onOpenProjects,
  onOpenLab,
  onOpenCapturedWork,
  onInputModeChange,
  onWorkspacePointer,
  loadingWork,
  actionRequest,
  onActionHandled,
  isInputCaptured,
}: {
  projects: Projects;
  project: ProjectWorkspaceSelection;
  dimensions: InsetDimensionSource;
  onContinueRetainedWork: (receipt: WorkStartReceipt) => Promise<void>;
  onOpenProjects: () => void;
  onOpenLab: () => void;
  onOpenCapturedWork: (
    plan: ProjectWorkCapturePlan,
    receipt: ProjectWorkCaptureReceipt,
  ) => void;
  onInputModeChange: (active: boolean) => void;
  onWorkspacePointer: () => void;
  loadingWork: boolean;
  actionRequest?: ProjectWorkActionRequest;
  onActionHandled?: (id: number) => void;
  isInputCaptured: () => boolean;
}) {
  const { exit } = useApp();
  const [size, setSize] = React.useState(dimensions.get());
  const [plan, setPlan] = React.useState<ProjectWorkRunPlan>();
  const [composer, setComposer] = React.useState<ProjectWorkComposer>();
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState(
    'Press Enter to create the first Work in this Project.',
  );
  const [runs, setRuns] = React.useState<ProjectWorkRunSnapshot[]>(() =>
    projects.runs(),
  );
  const [projectSection, setProjectSection] = React.useState<'work' | 'files'>(
    'work',
  );
  const [loadingFrame, setLoadingFrame] = React.useState(0);
  React.useEffect(() => dimensions.subscribe(setSize), [dimensions]);
  React.useEffect(() => projects.subscribeRuns(setRuns), [projects]);
  React.useEffect(() => {
    if (!loadingWork) return;
    const timer = setInterval(
      () => setLoadingFrame((current) => (current + 1) % 4),
      180,
    );
    return () => clearInterval(timer);
  }, [loadingWork]);
  const composerActive = Boolean(composer);
  React.useEffect(() => {
    onInputModeChange(composerActive);
    return () => {
      if (composerActive) onInputModeChange(false);
    };
  }, [composerActive, onInputModeChange]);

  const visibleRun =
    runs.find((candidate) => candidate.workspace === project.workspace_root) ??
    null;
  const retainedAgentFinished =
    visibleRun?.receipt?.status === 'agent-finished';
  const canvasRows = terminalCanvasRows(size.rows);
  const navigationWidth = Math.min(
    24,
    Math.max(18, Math.floor(size.columns * 0.2)),
  );
  const loadingSpinner = ['◐', '◓', '◑', '◒'][loadingFrame];
  const beginNewWork = React.useCallback(() => {
    if (loadingWork || busy || visibleRun?.running) return;
    if (visibleRun?.receipt) {
      setMessage(
        'Review and complete the retained Work before creating another Work.',
      );
      return;
    }
    setPlan(undefined);
    setComposer({
      step: 'objective',
      objective: '',
      acceptanceCriterion: '',
    });
    setMessage('Describe one outcome for this Project.');
  }, [busy, loadingWork, visibleRun?.receipt, visibleRun?.running]);
  React.useEffect(() => {
    if (!actionRequest) return;
    beginNewWork();
    onActionHandled?.(actionRequest.id);
  }, [actionRequest, beginNewWork, onActionHandled]);
  const previewCodex = React.useCallback(() => {
    if (busy || visibleRun?.running || visibleRun?.receipt) return;
    setBusy(true);
    setMessage('Verifying Codex, native binding, and the selected Work…');
    void projects
      .planRun('codex', { workspace: project.workspace_root })
      .then((nextPlan) => {
        setPlan(nextPlan);
        setMessage(
          nextPlan.executable
            ? 'Exact Work plan is ready for confirmation.'
            : 'The Work plan is blocked; inspect the verification evidence below.',
        );
      })
      .catch((error) =>
        setMessage(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setBusy(false));
  }, [
    busy,
    project.workspace_root,
    projects,
    visibleRun?.receipt,
    visibleRun?.running,
  ]);
  const continueRetainedWork = React.useCallback(() => {
    const receipt = visibleRun?.receipt;
    if (busy || !retainedAgentFinished || !receipt) return;
    setBusy(true);
    setMessage('Loading the retained Agent run for independent review…');
    void onContinueRetainedWork(receipt)
      .catch((error) =>
        setMessage(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setBusy(false));
  }, [
    busy,
    onContinueRetainedWork,
    retainedAgentFinished,
    visibleRun?.receipt,
  ]);
  const confirmRun = React.useCallback(() => {
    if (!plan?.executable || busy) return;
    const acceptedPlan = plan;
    setPlan(undefined);
    setBusy(true);
    setMessage(
      `Launching ${acceptedPlan.agent.label} for ${acceptedPlan.work.title}…`,
    );
    void projects
      .run(
        'codex',
        {
          workspace: project.workspace_root,
          work: acceptedPlan.work.assignmentId,
          expectedPlanRoot: acceptedPlan.planRoot,
        },
        () => undefined,
      )
      .then((receipt) =>
        setMessage(
          receipt.ok
            ? 'Agent Work is retained. Follow the receipt next action below.'
            : `Agent Work ended with status ${receipt.status}.`,
        ),
      )
      .catch((error) =>
        setMessage(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setBusy(false));
  }, [busy, plan, project.workspace_root, projects]);
  const captureComposedWork = React.useCallback(() => {
    if (!composer?.plan || busy) return;
    const capturePlan = composer.plan;
    setComposer({ ...composer, step: 'capturing' });
    setBusy(true);
    setMessage('Capturing the exact request without admitting or running it…');
    void projects
      .captureWork(project.workspace_root, capturePlan)
      .then((receipt) => onOpenCapturedWork(capturePlan, receipt))
      .catch((error) => {
        setComposer({ ...composer, step: 'preview' });
        setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setBusy(false));
  }, [busy, composer, onOpenCapturedWork, project.workspace_root, projects]);

  React.useEffect(() => {
    if (projectSection === 'files') return;
    const onData = (chunk: Buffer | string) => {
      const value = String(chunk);
      if (isInputCaptured()) return;
      if (composer) {
        if (composer.step === 'capturing') return;
        if (composer.step === 'preview') {
          if (value === '\u001b' || value === 'b') {
            setComposer({ ...composer, step: 'acceptance', plan: undefined });
          } else if (value === '\r' || value === '\n') {
            captureComposedWork();
          }
          return;
        }
        if (value === '\u001b') {
          setComposer(undefined);
          setMessage('New Work cancelled; nothing was captured.');
          return;
        }
        if (value === '\u007f' || value === '\b') {
          setComposer((current) =>
            current?.step === 'objective'
              ? { ...current, objective: current.objective.slice(0, -1) }
              : current
                ? {
                    ...current,
                    acceptanceCriterion: current.acceptanceCriterion.slice(
                      0,
                      -1,
                    ),
                  }
                : current,
          );
          return;
        }
        if (value === '\r' || value === '\n') {
          if (composer.step === 'objective') {
            if (!composer.objective.trim()) return;
            setComposer({ ...composer, step: 'acceptance' });
            setMessage(
              'Define the result that independent review should check.',
            );
          } else {
            if (!composer.acceptanceCriterion.trim()) return;
            try {
              setComposer({
                ...composer,
                step: 'preview',
                plan: projects.prepareWork(
                  composer.objective,
                  composer.acceptanceCriterion,
                ),
              });
              setMessage('Review this Work before capturing it.');
            } catch (error) {
              setMessage(
                error instanceof Error ? error.message : String(error),
              );
            }
          }
          return;
        }
        const printable = [...value].every((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint >= 0x20 && codePoint !== 0x7f;
        });
        if (printable) {
          setComposer((current) =>
            current?.step === 'objective'
              ? {
                  ...current,
                  objective: `${current.objective}${value}`.slice(0, 320),
                }
              : current
                ? {
                    ...current,
                    acceptanceCriterion:
                      `${current.acceptanceCriterion}${value}`.slice(0, 320),
                  }
                : current,
          );
        }
        return;
      }
      if (plan) {
        if (value === '\u001b' || value === 'b' || value === 'n') {
          setPlan(undefined);
          setMessage('Work start cancelled; no effects were performed.');
        } else if (value === '\r' || value === 'y') {
          confirmRun();
        }
        return;
      }
      if (value === 'q' || value === '\u0003') return exit();
      if (value === 'a') return onOpenLab();
      if (value === 't') {
        setProjectSection('files');
        return;
      }
      if (value === 'p' || value === '\u001b') return onOpenProjects();
      if (value === 'n') return beginNewWork();
      if (value === '\r' && retainedAgentFinished)
        return continueRetainedWork();
      if (value === '\r') return beginNewWork();
      if (value === 'r') previewCodex();
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [
    beginNewWork,
    captureComposedWork,
    composer,
    confirmRun,
    continueRetainedWork,
    exit,
    isInputCaptured,
    onOpenLab,
    onOpenProjects,
    plan,
    previewCodex,
    projectSection,
    projects.prepareWork,
    retainedAgentFinished,
  ]);

  if (projectSection === 'files') {
    return (
      <ProjectFilesHost
        root={project.workspace_root}
        dimensions={dimensions}
        workCount={loadingWork ? undefined : 0}
        isInputCaptured={isInputCaptured}
        onOpenWork={() => setProjectSection('work')}
        onOpenProjects={onOpenProjects}
        onOpenLab={onOpenLab}
        onWorkspacePointer={onWorkspacePointer}
      />
    );
  }

  const eventRows = Math.max(3, canvasRows - 15);
  const visibleEvents = visibleRun?.events.slice(-eventRows) ?? [];
  const projectName =
    path.basename(project.workspace_root) || project.display_path;
  return (
    <Box
      width={size.columns}
      height={canvasRows}
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      position="relative"
      overflow="hidden"
    >
      <Text bold color="cyan" wrap="truncate-end">
        PROJECT · {projectName}
      </Text>
      <Text dimColor wrap="truncate-end">
        {project.workspace_root}
      </Text>
      <Box flexGrow={1}>
        <Box
          width={navigationWidth}
          flexDirection="column"
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
        >
          <Text bold>PROJECT</Text>
          <Text>{'  '}Files</Text>
          <Text bold color="cyan">
            › Work {loadingWork ? '…' : 0}
          </Text>
          <Text> </Text>
          <Text dimColor>[t] Files</Text>
          <Text dimColor>[Enter] New Work</Text>
        </Box>
        <Box flexGrow={1} flexDirection="column" paddingLeft={1}>
          <Text wrap="truncate-end">
            Create Work, choose an Agent, and keep the result in this Project.
          </Text>
          <Text bold color="yellow" wrap="truncate-end">
            {loadingWork
              ? `${loadingSpinner} LOADING: discovering retained Work in this Project`
              : visibleRun?.running
                ? 'RUNNING: wait for the retained Agent receipt'
                : retainedAgentFinished
                  ? 'NEXT: [Enter] review Project changes with a fresh Agent'
                  : visibleRun?.receipt
                    ? 'NEXT: inspect the retained failure before retrying'
                    : 'NEXT: [Enter or /new] create Work'}
          </Text>
          <Text dimColor wrap="truncate-end">
            [t] Files · [n or /new] New Work · [p/Esc] Projects · [a] Agent Work
            Lab · [q] quit
          </Text>
          <Box flexDirection="column" marginTop={1} flexGrow={1}>
            {loadingWork ? (
              <Box
                flexDirection="column"
                borderStyle="double"
                borderColor="cyan"
                paddingX={1}
              >
                <Text bold color="cyan">
                  {loadingSpinner} LOADING PROJECT WORK
                </Text>
                <Text>
                  Kungfu is reading retained Work and evidence for this exact
                  Project.
                </Text>
                <Text dimColor>
                  The empty-Project state will appear only after this check
                  finishes with no Work.
                </Text>
              </Box>
            ) : visibleRun ? (
              <>
                <Text bold color={visibleRun.running ? 'yellow' : 'green'}>
                  {visibleRun.running
                    ? '◌ CODEX SESSION RUNNING'
                    : '✓ CODEX SESSION'}
                </Text>
                {visibleEvents.length > 0 ? (
                  visibleEvents.map((event) => (
                    <Text key={`${event.index}:${event.root ?? event.text}`}>
                      <Text color={event.status === 'failed' ? 'red' : 'cyan'}>
                        {String(event.index).padStart(2, '0')} {event.stage}
                      </Text>{' '}
                      {event.activity?.text || event.text}
                    </Text>
                  ))
                ) : (
                  <Text color="yellow">
                    {visibleRun.running
                      ? 'Codex is working; waiting for the next retained event…'
                      : 'No streamed events were retained for this run.'}
                  </Text>
                )}
                {visibleRun.error ? (
                  <Text color="red">{visibleRun.error}</Text>
                ) : null}
                {visibleRun.receipt ? (
                  <>
                    <Text bold color={visibleRun.receipt.ok ? 'green' : 'red'}>
                      {visibleRun.receipt.status} ·{' '}
                      {visibleRun.receipt.workPhase}
                    </Text>
                    {visibleRun.receipt.nextActions
                      .slice(0, 2)
                      .map((action) => (
                        <Text key={action}>Next · {action}</Text>
                      ))}
                  </>
                ) : null}
              </>
            ) : (
              <Box
                flexDirection="column"
                borderStyle="double"
                borderColor="green"
                paddingX={1}
              >
                <Text bold color="green">
                  PROJECT OPENED
                </Text>
                <Text>
                  The Project is active. No Agent has been launched yet.
                </Text>
                <Text>
                  Press <Text bold>[Enter]</Text> to describe the first Work.
                  You will choose an Agent before anything runs.
                </Text>
              </Box>
            )}
          </Box>
          {plan ? (
            <Box
              flexDirection="column"
              borderStyle="double"
              borderColor={plan.executable ? 'yellow' : 'red'}
              paddingX={1}
            >
              <Text bold color={plan.executable ? 'yellow' : 'red'}>
                CONFIRM WORK START
              </Text>
              <Text>
                {plan.work.title} · {plan.agent.label}
              </Text>
              <Text color={plan.agent.verification.ok ? 'green' : 'red'}>
                Agent{' '}
                {plan.agent.verification.ok
                  ? `verified · ${plan.agent.verification.version || 'available'}`
                  : `failed · ${plan.agent.verification.error || 'unavailable'}`}
              </Text>
              <Text color={plan.admissionBinding.ok ? 'green' : 'red'}>
                Native binding · {plan.admissionBinding.state}
              </Text>
              {plan.effects.slice(0, 4).map((effect, index) => (
                <Text key={`${effect.stage}:${effect.label}`}>
                  {index + 1}. {effect.label}
                </Text>
              ))}
              <Text bold>
                {plan.executable
                  ? '[y/Enter] Start Work · [b/Esc] back'
                  : '[b/Esc] back · repair verification before retrying'}
              </Text>
            </Box>
          ) : composer ? (
            <Box
              flexDirection="column"
              borderStyle="double"
              borderColor={composer.step === 'preview' ? 'yellow' : 'cyan'}
              paddingX={1}
            >
              <Text
                bold
                color={composer.step === 'preview' ? 'yellow' : 'cyan'}
              >
                {composer.step === 'objective'
                  ? 'NEW WORK · OBJECTIVE'
                  : composer.step === 'acceptance'
                    ? 'NEW WORK · ACCEPTANCE'
                    : composer.step === 'capturing'
                      ? 'CAPTURING WORK'
                      : 'CONFIRM WORK CAPTURE'}
              </Text>
              {composer.step === 'objective' ? (
                <>
                  <Text>What should the Agent accomplish in this Project?</Text>
                  <Text>
                    Objective: <Text inverse>{composer.objective || ' '}</Text>
                  </Text>
                  <Text bold>[Enter] continue · [Esc] cancel</Text>
                </>
              ) : composer.step === 'acceptance' ? (
                <>
                  <Text>How will independent review know it is done?</Text>
                  <Text>
                    Check:{' '}
                    <Text inverse>{composer.acceptanceCriterion || ' '}</Text>
                  </Text>
                  <Text bold>[Enter] preview · [Esc] cancel</Text>
                </>
              ) : composer.plan ? (
                <>
                  <Text>
                    Work ID ·{' '}
                    <Text color="cyan">{composer.plan.assignmentId}</Text>
                  </Text>
                  <Text>Objective · {composer.plan.objective}</Text>
                  <Text bold>Acceptance criteria</Text>
                  {composer.plan.acceptanceChecks.map((check, index) => (
                    <Text key={check}>
                      {index + 1}. {check}
                    </Text>
                  ))}
                  <Text color="yellow">
                    This only captures the request. No Work is admitted and no
                    Agent runs yet.
                  </Text>
                  <Text bold>
                    {composer.step === 'capturing'
                      ? '◌ Waiting for the canonical capture receipt…'
                      : '[Enter] capture Work · [b/Esc] edit acceptance'}
                  </Text>
                </>
              ) : null}
            </Box>
          ) : loadingWork ? (
            <Text color="cyan">
              {loadingSpinner} Loading retained Project Work…
            </Text>
          ) : (
            <Text color={busy ? 'yellow' : undefined}>
              {busy ? '◌ ' : '✓ '}
              {message}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
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
  autoDemo = false,
  onAutoDemoSettled,
}: {
  lab: AgentWorkLab;
  dimensions: DimensionStore;
  autoDemo?: boolean;
  onAutoDemoSettled?: (result: AgentWorkLabAutoplayResult) => void;
}) {
  const { exit } = useApp();
  const [size, setSize] = React.useState(dimensions.get());
  const startupProjectRoot = React.useMemo(
    () => existingProjectWorkspaceRoot(process.cwd(), process.env),
    [],
  );
  const [startup, setStartup] = React.useState<
    AgentWorkLabStartupRoute | undefined
  >(autoDemo ? PENDING_STARTUP : undefined);
  const [surface, setSurface] = React.useState<
    | 'loading'
    | 'lab'
    | 'all-work'
    | 'projects'
    | 'project-work'
    | 'project-assignment'
  >(autoDemo ? 'lab' : startupProjectRoot ? 'loading' : 'all-work');
  const surfaceRef = React.useRef(surface);
  React.useEffect(() => {
    surfaceRef.current = surface;
  }, [surface]);
  const projects = React.useMemo(openTuiProjects, []);
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
    autoDemo || !startupProjectRoot,
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
    autoDemo
      ? 'Offline demo automation owns this run'
      : 'Loading governed command catalog',
  );
  const contentDimensions = React.useMemo(
    () => new InsetDimensionSource(dimensions, 5),
    [dimensions],
  );
  React.useEffect(() => dimensions.subscribe(setSize), [dimensions]);
  React.useEffect(() => {
    if (autoDemo || control.mode === 'closed' || cliDocuments.length > 0)
      return;
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
  }, [autoDemo, cliDocuments.length, control.mode]);
  React.useEffect(() => {
    if (autoDemo || surface !== 'lab' || startup) return;
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
  }, [autoDemo, lab, startup, surface]);
  React.useEffect(() => {
    if (autoDemo || !startupProjectRoot) return;
    let active = true;
    const request = openProjectRequest.current + 1;
    openProjectRequest.current = request;
    setProjectWorkLoading(true);
    void projects
      .select(startupProjectRoot)
      .then(async (receipt) => {
        if (!active) return;
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
        surfaceRef.current = 'project-work';
        setSurface('project-work');
        const resumed = await lab.resumeStarterProject();
        if (
          !active ||
          request !== openProjectRequest.current ||
          !resumed ||
          resumed.project.workspace.selected.workspace_root !==
            selected.workspace.workspace_root
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
        if (active && request === openProjectRequest.current) {
          setProjectWorkLoading(false);
          setProjectResumeSettled(true);
        }
      });
    return () => {
      active = false;
    };
  }, [autoDemo, lab, projects, startupProjectRoot]);
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

  const resolvedStartup = startup ?? PENDING_STARTUP;
  const labOpen = surface === 'lab';
  const starterOpen =
    surface === 'project-assignment' && Boolean(starterProject);
  React.useEffect(() => {
    if (autoDemo || surface !== 'loading') return;
    const resolved = resolveProductStartupSurface({
      contextualProject: Boolean(startupProjectRoot),
      openedProject: Boolean(openedProject),
      projectResumeSettled,
    });
    if (resolved) setSurface(resolved);
  }, [
    autoDemo,
    openedProject,
    projectResumeSettled,
    startupProjectRoot,
    surface,
  ]);
  const availableQuickCommands = React.useMemo(
    () =>
      labOpen
        ? [...AGENT_WORK_LAB_QUICK_COMMANDS, ...QUICK_COMMANDS]
        : surface === 'projects'
          ? [...PROJECTS_QUICK_COMMANDS, ...QUICK_COMMANDS]
          : surface === 'project-work' && openedProject
            ? [...PROJECT_WORK_QUICK_COMMANDS, ...QUICK_COMMANDS]
            : QUICK_COMMANDS,
    [labOpen, openedProject, surface],
  );
  const viewDocuments = React.useMemo<ProductSearchDocument[]>(
    () => [
      {
        id: 'view.work-control',
        kind: 'view',
        title: 'All Work',
        summary: 'Open the cross-Project read-only Work overview.',
        keywords: ['all', 'work', 'active', 'completed'],
        action: { kind: 'open-view', viewId: 'work' },
      },
      {
        id: 'view.projects',
        kind: 'view',
        title: 'Projects',
        summary: 'Create a Project or open an existing directory.',
        keywords: ['project', 'new', 'open', 'directory'],
        action: { kind: 'open-view', viewId: 'projects' },
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
      ...projectDocuments,
      ...viewDocuments,
    ],
    [
      cliDocuments,
      projectDocuments,
      quickSearchDocuments,
      viewDocuments,
      workDocuments,
    ],
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
    [lab, setControlNow],
  );
  const openGlobalWork = React.useCallback(() => {
    setControlNow({ ...CLOSED_CONTROL_PLANE, focus: 'workspace' });
    setSurface('all-work');
  }, [setControlNow]);
  const openHome = React.useCallback(() => {
    setControlNow({ ...CLOSED_CONTROL_PLANE, focus: 'workspace' });
    if (starterProject) setSurface('project-assignment');
    else if (openedProject) setSurface('project-work');
    else setSurface('all-work');
  }, [openedProject, setControlNow, starterProject]);
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
      } else if (command.action === 'work') {
        openGlobalWork();
        closeControl('workspace');
      } else if (command.action === 'projects') {
        setSurface('projects');
        closeControl('workspace');
      } else if (command.action === 'lab') {
        setSurface('lab');
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
    projects,
    setControlNow,
  ]);
  const activateControlRef = React.useRef(activateControl);
  activateControlRef.current = activateControl;
  const isInputCaptured = React.useCallback(
    () => autoDemo || inputFence.isCaptured(),
    [autoDemo, inputFence],
  );
  React.useEffect(() => {
    if (autoDemo) return;
    const onData = (chunk: Buffer | string) => {
      if (workspaceInputActiveRef.current) return;
      const mouseEvents = decodeTerminalMouseInput(chunk);
      if (mouseEvents.length > 0) {
        for (const event of mouseEvents) {
          if (event.kind !== 'press' || event.button !== 'left') continue;
          const navigation = horizontalPointerActionAtPoint({
            actions: productNavActions,
            column: event.column,
            row: event.row,
            targetRow: 1,
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
    autoDemo,
    dispatchLabAction,
    exit,
    inputFence,
    labOpen,
    openGlobalWork,
    openHome,
    openedProject,
    productNavActions,
    setControlNow,
    size,
  ]);

  React.useEffect(() => {
    if (autoDemo) return;
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
  }, [autoDemo, isInputCaptured, openGlobalWork, openHome, openedProject]);

  let content: React.ReactNode;
  if (starterOpen && starterProject) {
    content = (
      <StarterProjectHost
        project={starterProject}
        lab={lab}
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
        onContinueRetainedWork={async (receipt) => {
          const resumed = await lab.resumeStarterProject();
          if (
            !resumed ||
            resumed.project.workspace.selected.workspace_root !==
              openedProject.workspace_root
          ) {
            throw new Error(
              'Kungfu could not bind this retained run to its Project review flow.',
            );
          }
          setStarterProject(resumed.project);
          setStarterWorkReceipt(receipt);
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
      {!autoDemo ? (
        <Box height={1} paddingX={1} gap={2}>
          <Text
            color={surface === 'all-work' ? 'cyan' : undefined}
            bold={surface === 'all-work'}
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
          >
            [2]{' '}
            {openedProject
              ? `Project · ${path.basename(openedProject.workspace_root)}`
              : 'Projects'}
          </Text>
          <Text color={labOpen ? 'cyan' : undefined} bold={labOpen}>
            [3] Agent Work Lab
          </Text>
        </Box>
      ) : null}
      {content}
      {autoDemo ? (
        <PlaybackBar
          dimensions={size}
          label="DEMO PLAYBACK"
          status="Agent Work Lab · Offline continuity"
          hint="Automatic · No input required · exits after the final result"
        />
      ) : (
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
            surfaceLabel={
              labOpen
                ? 'Agent Work Lab'
                : surface === 'projects'
                  ? 'Projects'
                  : starterOpen || surface === 'project-work'
                    ? openedProject
                      ? `Project · ${path.basename(openedProject.workspace_root)}`
                      : 'Project'
                    : surface === 'all-work'
                      ? 'All Work'
                      : 'Starting'
            }
            controlsLabel={
              labOpen
                ? 'LAB CONTROLS'
                : surface === 'projects'
                  ? 'PROJECT CONTROLS'
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
                  ? 'Enter Open · /new New Project · /open Open Project · d Remove'
                  : starterOpen
                    ? 'j/k Work · Enter Open · /new New Work · p Projects'
                    : surface === 'project-work' && openedProject
                      ? workspaceInputActive
                        ? 'Type in the focused panel · Enter Continue · Esc Cancel'
                        : 't Files · Enter Run · /new New Work · p Projects'
                      : `f Active/Completed/All · s Sort · j/k Work · [2] ${
                          openedProject ? 'Project' : 'Projects'
                        }`
            }
          />
        </>
      )}
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
      'Kungfu Work Control TUI\n\nRun in an interactive terminal.\nOffline animation demo: `kungfu agent-work-lab autoplay`.\nAgent brief: `kungfu agent brief`.\n',
    );
    return;
  }
  const lab = openTuiAgentWorkLab();
  const autoDemo = process.argv.includes('--agent-work-lab-autoplay');
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
    if (autoDemo) process.exitCode = 2;
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
  let autoDemoResult: AgentWorkLabAutoplayResult | undefined;
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
      instance = render(
        <ProductHost
          lab={lab}
          dimensions={dimensions}
          autoDemo={autoDemo}
          onAutoDemoSettled={(result) => {
            autoDemoResult = result;
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
  if (autoDemo) {
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
