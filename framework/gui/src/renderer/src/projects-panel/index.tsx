// SPDX-License-Identifier: Apache-2.0

import type {
  KfxExperienceFlowDescriptor,
  ProjectSummary,
  Projects,
  ProjectsCatalog,
} from '@kungfu-tech/api/capability';
import * as capability from '@kungfu-tech/api/capability';
import { mono, panelStyle } from '@kungfu-tech/kfx';
import React from 'react';
import { isResettableRuntimeFailure } from '../../../runtime-recovery-contract';
import {
  RUNTIME_BACKUP_RESET_CHANNEL,
  WORKSPACE_GET_CHANNEL,
  WORKSPACE_OPEN_CHANNEL,
  WORKSPACE_SELECT_HOME_CHANNEL,
  WORKSPACE_SELECT_PATH_CHANNEL,
  WORKSPACE_SELECT_RECENT_CHANNEL,
  WORKSPACE_START_CONTINUATION_CHANNEL,
} from '../../../sandbox/channels';
import { createAgentSessionProxy } from '../agent-session-proxy';
import { AgentWorkLabPanel } from '../agent-work-lab';
import { guiKungfuCliArgs } from '../runtime';

type ProcessOptions = {
  env: Record<string, string | undefined>;
  maxBuffer: number;
};

type RendererChild = {
  stdin: {
    end: (input: string) => void;
    once: (event: 'error', listener: (reason: Error) => void) => void;
  };
  stdout: {
    on: (event: 'data', listener: (chunk: unknown) => void) => void;
  };
  stderr: {
    on: (event: 'data', listener: (chunk: unknown) => void) => void;
  };
  once: (
    event: 'error' | 'close',
    listener: (value: Error | number | null) => void,
  ) => void;
  kill: () => void;
};

type RendererChildProcess = {
  execFile: (
    file: string,
    args: string[],
    options: ProcessOptions & { encoding: 'utf8' },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => void;
  spawn: (
    file: string,
    args: string[],
    options: {
      env: Record<string, string | undefined>;
      stdio: ['ignore' | 'pipe', 'pipe', 'pipe'];
    },
  ) => RendererChild;
};

type RendererProcessContext = {
  childProcess: RendererChildProcess;
  args: (values: string[]) => string[];
};

type RendererProcessRequest = {
  file: string;
  values: string[];
  options: ProcessOptions;
};

type RendererExecRequest = RendererProcessRequest & {
  options: ProcessOptions & { encoding: 'utf8' };
};

type RendererInputRequest = RendererProcessRequest & { input: string };

type RendererEventsRequest = RendererProcessRequest & {
  onLine: (line: string) => void;
};

type RendererProcessRun<Request> = {
  process: RendererProcessContext;
  request: Request;
};

type RendererRunClose = {
  code: number | null;
  failureMessage: string;
  resolve: (stdout: string) => void;
};

class RendererProjectRun {
  stdout = '';
  stderr = '';
  size = 0;
  settled = false;

  constructor(
    readonly child: RendererChild,
    readonly maxBuffer: number,
    readonly overflowMessage: string,
    readonly reject: (reason: Error) => void,
  ) {}

  fail(reason: Error) {
    if (this.settled) return;
    this.settled = true;
    this.child.kill();
    this.reject(reason);
  }

  append(stream: 'stdout' | 'stderr', chunk: unknown) {
    const text = String(chunk);
    this.size += text.length;
    if (this.size > this.maxBuffer) {
      this.fail(new Error(this.overflowMessage));
      return false;
    }
    this[stream] += text;
    return true;
  }

  receiveLines(chunk: unknown, onLine: (line: string) => void) {
    if (!this.append('stdout', chunk)) return;
    const lines = this.stdout.split(/\r?\n/);
    this.stdout = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) onLine(line);
  }

  receiveError(reason: unknown) {
    this.fail(reason instanceof Error ? reason : new Error(String(reason)));
  }

  close({ code, failureMessage, resolve }: RendererRunClose) {
    if (this.settled) return;
    if (code !== 0) {
      this.fail(new Error(this.stderr.trim() || failureMessage));
      return;
    }
    this.settled = true;
    resolve(this.stdout);
  }
}

function runRendererExecFile(run: RendererProcessRun<RendererExecRequest>) {
  const { childProcess, args } = run.process;
  const { file, values, options } = run.request;
  return new Promise<string>((resolve, reject) => {
    childProcess.execFile(
      file,
      args(values),
      options,
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || stdout.trim() || error.message));
        } else resolve(stdout);
      },
    );
  });
}

function runRendererInput(run: RendererProcessRun<RendererInputRequest>) {
  const { childProcess, args } = run.process;
  const { file, values, input, options } = run.request;
  return new Promise<string>((resolve, reject) => {
    const child = childProcess.spawn(file, args(values), {
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const processRun = new RendererProjectRun(
      child,
      options.maxBuffer,
      'Project Work capture output exceeded maxBuffer',
      reject,
    );
    child.stdout.on('data', (chunk) => {
      processRun.append('stdout', chunk);
    });
    child.stderr.on('data', (chunk) => {
      processRun.append('stderr', chunk);
    });
    child.stdin.once('error', (reason) => processRun.fail(reason));
    child.once('error', (reason) => processRun.receiveError(reason));
    child.once('close', (code) =>
      processRun.close({
        code: code as number | null,
        failureMessage: `kungfu capture exited ${code}`,
        resolve,
      }),
    );
    child.stdin.end(input);
  });
}

function runRendererEvents(run: RendererProcessRun<RendererEventsRequest>) {
  const { childProcess, args } = run.process;
  const { file, values, options, onLine } = run.request;
  return new Promise<void>((resolve, reject) => {
    const child = childProcess.spawn(file, args(values), {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const processRun = new RendererProjectRun(
      child,
      options.maxBuffer,
      'Work activity stream exceeded maxBuffer',
      reject,
    );
    child.stdout.on('data', (chunk) => processRun.receiveLines(chunk, onLine));
    child.stderr.on('data', (chunk) => {
      processRun.stderr += String(chunk);
    });
    child.once('error', (reason) => processRun.receiveError(reason));
    child.once('close', (code) => {
      if (processRun.settled) return;
      if (processRun.stdout.trim()) onLine(processRun.stdout);
      processRun.close({
        code: code as number | null,
        failureMessage: `kungfu run exited ${code}`,
        resolve: () => resolve(),
      });
    });
  });
}

function createRendererProjects() {
  const childProcess = window.require(
    'node:child_process',
  ) as RendererChildProcess;
  const electron = window.require('electron') as {
    ipcRenderer: {
      invoke: (channel: string, payload: unknown) => Promise<unknown>;
    };
  };
  const env: Record<string, string | undefined> = {
    ...window.process.env,
    KUNGFU_AS_VARIANT: undefined,
  };
  const bin =
    env.KUNGFU_CLI_BIN ||
    env.KUNGFU_BIN ||
    (window.process.platform === 'win32' ? 'kungfu.exe' : 'kungfu');
  const args = (values: string[]) => guiKungfuCliArgs(env, values);
  const process = { childProcess, args };
  return capability.openProjects({
    bin,
    env,
    agentSessionClient: 'gui',
    agentSession: createAgentSessionProxy(electron.ipcRenderer),
    execFile: (file, values, options) =>
      runRendererExecFile({ process, request: { file, values, options } }),
    execFileInput: (file, values, input, options) =>
      runRendererInput({
        process,
        request: { file, values, input, options },
      }),
    execFileEvents: (file, values, options, onLine) =>
      runRendererEvents({
        process,
        request: { file, values, options, onLine },
      }),
  });
}

export const openRendererProjects = createRendererProjects;

type WorkspaceSelection = {
  workspace_id: string;
  workspace_kind: 'project';
  workspace_root: string;
  display_path: string;
  data_home: string;
  runtime_dir: string;
  initialized: boolean;
  state: string;
  resolution_reason: string;
};

type SelectionReceipt = {
  workspace: WorkspaceSelection;
};

type CreatePlan = {
  templateId: string;
  destination: string;
  planRoot: string;
  effects: string[];
  skippedEffects: string[];
};

type RuntimeRecoveryResult = {
  ok?: boolean;
  canceled?: boolean;
  error?: string;
};

type RuntimeRecoveryIpc = {
  invoke: (channel: string, payload: unknown) => Promise<RuntimeRecoveryResult>;
};

const buttonStyle: React.CSSProperties = {
  ...mono,
  padding: '7px 11px',
  borderRadius: 6,
  border: '1px solid #4b4b4b',
  background: '#2d2d30',
  color: '#f1f1f1',
  cursor: 'pointer',
};

export function ProjectsPanel({
  projects,
  focusedPath,
  onCatalog,
  onOpenProject,
  onOpenExistingProject,
  onRestoreProject,
}: {
  projects: Projects;
  focusedPath?: string;
  onCatalog: (catalog: ProjectsCatalog) => void;
  onOpenProject: (workspace: WorkspaceSelection) => Promise<unknown>;
  onOpenExistingProject: () => void;
  onRestoreProject: (projectPath: string, section: 'files' | 'work') => boolean;
}) {
  const [catalog, setCatalog] = React.useState<ProjectsCatalog | undefined>(
    projects.cachedCatalog,
  );
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const [createPlan, setCreatePlan] = React.useState<CreatePlan>();
  const onCatalogRef = React.useRef(onCatalog);
  React.useEffect(() => {
    onCatalogRef.current = onCatalog;
  }, [onCatalog]);

  const refresh = React.useCallback(
    (force = true) => {
      setBusy('Loading Projects…');
      setError('');
      return projects
        .list({ refresh: force })
        .then((value) => {
          setCatalog(value);
          onCatalogRef.current(value);
        })
        .catch((reason) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
        )
        .finally(() => setBusy(''));
    },
    [projects],
  );
  React.useEffect(() => {
    if (!focusedPath && !catalog) void refresh(false);
  }, [catalog, focusedPath, refresh]);

  const open = React.useCallback(
    (project: ProjectSummary) => {
      setBusy(`Opening ${project.name}…`);
      setError('');
      void projects
        .select(project.path)
        .then((receipt) =>
          onOpenProject((receipt as unknown as SelectionReceipt).workspace),
        )
        .catch((reason) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
        )
        .finally(() => setBusy(''));
    },
    [onOpenProject, projects],
  );

  const planProject = React.useCallback(() => {
    setBusy('Planning a new Project under ~/Documents/Kungfu…');
    setError('');
    void projects
      .planCreate(undefined, 'kungfu.blank-project')
      .then((plan) => setCreatePlan(plan as unknown as CreatePlan))
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(''));
  }, [projects]);

  const createProject = React.useCallback(() => {
    if (!createPlan) return;
    setBusy('Creating Project files…');
    setError('');
    void projects
      .create(
        createPlan.destination,
        createPlan.planRoot,
        createPlan.templateId,
      )
      .then((receipt) => {
        setCreatePlan(undefined);
        return onOpenProject(
          (receipt as unknown as SelectionReceipt).workspace,
        );
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(''));
  }, [createPlan, onOpenProject, projects]);

  const openedProject = focusedPath
    ? catalog?.projects.find((project) => project.path === focusedPath)
    : undefined;
  const forwardedProject = React.useRef('');
  React.useEffect(() => {
    if (!focusedPath || forwardedProject.current === focusedPath) {
      return;
    }
    if (onRestoreProject(focusedPath, 'files')) {
      forwardedProject.current = focusedPath;
    }
  }, [focusedPath, onRestoreProject]);

  return (
    <section
      style={{
        ...panelStyle,
        height: '100%',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
        <div>
          <h2 style={{ margin: 0, color: '#f1f1f1' }}>Projects</h2>
          <p style={{ ...mono, color: '#a8a8a8', margin: '6px 0 0' }}>
            Open a Project to inspect Files and manage Work, Agents, and deeper
            Project actions. Kungfu remembers it while its files stay ordinary.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            style={buttonStyle}
            onClick={onOpenExistingProject}
          >
            Open Project…
          </button>
          <button type="button" style={buttonStyle} onClick={planProject}>
            New Project
          </button>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => void refresh()}
          >
            Refresh
          </button>
        </div>
      </header>
      {error ? <div style={{ ...mono, color: '#f48771' }}>{error}</div> : null}
      {busy ? <div style={{ ...mono, color: '#dcdcaa' }}>◌ {busy}</div> : null}
      {focusedPath ? (
        <article
          aria-label="Opening Project"
          style={{
            border: '1px solid #315f79',
            borderRadius: 10,
            padding: '22px 18px',
            background: '#182b3a',
            display: 'grid',
            gap: 7,
          }}
        >
          <strong style={{ color: '#9cdcfe' }}>
            Opening {openedProject?.name ?? 'Project'}…
          </strong>
          <div style={{ ...mono, color: '#a8a8a8' }}>
            Restoring Files and retained Work without showing an empty
            placeholder.
          </div>
        </article>
      ) : (
        <>
          <div
            style={{
              ...mono,
              color: '#a8a8a8',
              fontWeight: 700,
              letterSpacing: '.05em',
            }}
          >
            ALL PROJECTS
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))',
              gap: 10,
              overflow: 'auto',
              minHeight: 0,
              flex: 1,
              alignContent: 'start',
            }}
          >
            {(catalog?.projects ?? []).map((project) => (
              <article
                key={project.id}
                style={{
                  border:
                    focusedPath === project.path
                      ? '2px solid #4fc1ff'
                      : '1px solid #454545',
                  borderRadius: 9,
                  padding: 12,
                  background: project.selected ? '#182b3a' : '#252526',
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 10,
                  }}
                >
                  <strong>{project.name}</strong>
                  <span
                    style={{
                      ...mono,
                      color: project.available ? '#89d185' : '#f48771',
                      flexShrink: 0,
                    }}
                  >
                    {project.available ? project.state : 'unavailable'}
                  </span>
                </div>
                <div
                  title={project.path}
                  style={{
                    ...mono,
                    color: '#9b9b9b',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    margin: '8px 0 12px',
                  }}
                >
                  {project.path}
                </div>
                <div
                  style={{
                    ...mono,
                    display: 'flex',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 10,
                    color: '#a8a8a8',
                    marginBottom: 12,
                  }}
                >
                  <span>
                    {project.workCount ?? 0}{' '}
                    {(project.workCount ?? 0) === 1 ? 'Work' : 'Works'}
                  </span>
                  <span>
                    Last activity ·{' '}
                    {project.updatedAt
                      ? new Intl.DateTimeFormat(undefined, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }).format(new Date(project.updatedAt))
                      : 'unknown'}
                  </span>
                </div>
                <div style={{ display: 'flex' }}>
                  <button
                    type="button"
                    style={{
                      ...buttonStyle,
                      width: '100%',
                      borderColor: '#4fc1ff',
                      background: '#0e639c',
                    }}
                    disabled={!project.available || Boolean(busy)}
                    onClick={() => open(project)}
                  >
                    Open Project
                  </button>
                </div>
              </article>
            ))}
            {catalog && catalog.projects.length === 0 ? (
              <div style={{ ...mono, color: '#dcdcaa' }}>
                No Projects yet. Create a Project or open an existing folder.
              </div>
            ) : null}
          </div>
        </>
      )}
      {createPlan ? (
        <dialog
          open
          aria-modal="true"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 50,
            background: 'rgba(0,0,0,0.78)',
            display: 'grid',
            placeItems: 'center',
            padding: 24,
          }}
        >
          <div
            style={{
              width: 'min(680px, 90vw)',
              background: '#252526',
              border: '2px solid #d7ba7d',
              borderRadius: 10,
              padding: 18,
              boxShadow: '0 18px 48px rgba(0,0,0,.55)',
            }}
          >
            <h3 style={{ marginTop: 0 }}>Create Project?</h3>
            <div style={{ ...mono, color: '#9cdcfe' }}>
              {createPlan.destination}
            </div>
            <ul>
              {createPlan.effects.map((effect) => (
                <li key={effect}>{effect}</li>
              ))}
            </ul>
            <p style={{ ...mono, color: '#a8a8a8' }}>
              Existing paths are never overwritten. Git commit, push, and
              publication are not included.
            </p>
            <div
              style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}
            >
              <button
                type="button"
                style={buttonStyle}
                onClick={() => setCreatePlan(undefined)}
              >
                Cancel
              </button>
              <button
                type="button"
                style={{ ...buttonStyle, borderColor: '#d7ba7d' }}
                onClick={createProject}
              >
                Create Project
              </button>
            </div>
          </div>
        </dialog>
      ) : null}
    </section>
  );
}

type KfxPlan = {
  hostContract?: KfxExperienceFlowDescriptor | null;
};

function hostContract(value: unknown): KfxExperienceFlowDescriptor | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = (value as KfxPlan).hostContract;
  return candidate &&
    typeof candidate === 'object' &&
    candidate.admission?.state === 'admitted'
    ? candidate
    : null;
}

export function resolveKfxHostDescriptor(options: {
  nativePlan: () => unknown;
  cliPlan: () => unknown;
}): KfxExperienceFlowDescriptor | null {
  try {
    const descriptor = hostContract(options.nativePlan());
    if (descriptor) return descriptor;
  } catch {
    // A retained Project can be inspected without a live native master. In
    // that state the Core CLI remains the exact read-only KFX authority.
  }
  try {
    return hostContract(options.cliPlan());
  } catch {
    return null;
  }
}

export function kfxNativePlanArgs(
  env: Record<string, string | undefined>,
  path: Pick<typeof import('node:path'), 'delimiter' | 'dirname' | 'resolve'>,
  exists: (value: string) => boolean = () => true,
): string[] {
  const roots: Array<{ kind: 'product' | 'user'; path: string }> = [];
  const seen = new Set<string>();
  const add = (kind: 'product' | 'user', value: string | undefined) => {
    if (!value) return;
    const resolved = path.resolve(value);
    if (seen.has(resolved) || !exists(resolved)) return;
    seen.add(resolved);
    roots.push({ kind, path: resolved });
  };
  const productRoot = env.KF_BUNDLED_EXTENSION_ROOT;
  add('product', productRoot);
  for (const entry of (env.KF_EXTENSION_PATH ?? '').split(path.delimiter)) {
    if (!entry) continue;
    const resolved = path.resolve(entry);
    add(
      productRoot && resolved === path.resolve(productRoot)
        ? 'product'
        : 'user',
      resolved,
    );
  }
  if (env.KF_RUNTIME_DIR) {
    add('user', path.resolve(path.dirname(env.KF_RUNTIME_DIR), 'extensions'));
  }
  return [
    'kfx',
    'native',
    'plan',
    ...roots.flatMap((root) => ['--root', `${root.kind}=${root.path}`]),
  ];
}

type WorkspaceSnapshot = {
  current: {
    workspaceId: string;
    workspaceKind: 'home' | 'project';
    workspaceRoot: string | null;
    displayPath: string;
    dataHome: string;
    state:
      | 'uninitialized'
      | 'shadow-only'
      | 'live-runtime'
      | 'evidence-degraded'
      | 'unavailable';
    diagnosis: string;
    evidenceLevel: 'none' | 'settled-review' | 'live-local' | 'degraded';
    settledEpisodeCount: number;
    projectCutCount: number;
  };
  recent: Array<{
    workspace_id?: string;
    workspace_kind?: 'home' | 'project';
    workspace_root?: string | null;
    display_path?: string;
    data_home?: string;
  }>;
};

export function workspaceIpc() {
  const ipcRenderer = (
    window.require('electron') as {
      ipcRenderer: {
        invoke: (channel: string, payload?: unknown) => Promise<unknown>;
      };
    }
  ).ipcRenderer;
  return {
    get: () =>
      ipcRenderer.invoke(WORKSPACE_GET_CHANNEL) as Promise<WorkspaceSnapshot>,
    open: () => ipcRenderer.invoke(WORKSPACE_OPEN_CHANNEL),
    home: () => ipcRenderer.invoke(WORKSPACE_SELECT_HOME_CHANNEL),
    path: (workspaceRoot: string) =>
      ipcRenderer.invoke(WORKSPACE_SELECT_PATH_CHANNEL, { workspaceRoot }),
    startContinuation: () =>
      ipcRenderer.invoke(WORKSPACE_START_CONTINUATION_CHANNEL),
    recent: (workspaceId: string) =>
      ipcRenderer.invoke(WORKSPACE_SELECT_RECENT_CHANNEL, { workspaceId }),
  };
}

export function WorkspacePanel() {
  const bridge = React.useMemo(workspaceIpc, []);
  const [snapshot, setSnapshot] = React.useState<WorkspaceSnapshot | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    void bridge
      .get()
      .then(setSnapshot)
      .catch((e) => setError((e as Error).message));
  }, [bridge]);
  const run = (action: () => Promise<unknown>) => {
    setError(null);
    void action().catch((e) => setError((e as Error).message));
  };
  return (
    <section style={{ ...panelStyle, width: 'min(680px, 100%)' }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>Project details</h2>
      {snapshot && (
        <div style={{ ...mono, color: '#9cdcfe', marginBottom: 10 }}>
          {snapshot.current.displayPath} · {snapshot.current.state}
          {snapshot.current.diagnosis ? ` · ${snapshot.current.diagnosis}` : ''}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => run(bridge.open)}
          style={{ ...mono, padding: '6px 10px' }}
        >
          Open Project…
        </button>
        <button
          type="button"
          onClick={() => run(bridge.home)}
          style={{ ...mono, padding: '6px 10px' }}
        >
          Use Personal Project
        </button>
      </div>
      <div style={{ ...mono, color: '#858585', marginBottom: 6 }}>
        Opening or selecting is read-only. The first fact-bearing action creates
        the selected `.kungfu` data home.
      </div>
      {snapshot?.current.state === 'shadow-only' && (
        <div
          style={{
            display: 'grid',
            gap: 5,
            padding: 8,
            marginBottom: 10,
            border: '1px solid #3c3c3c',
            borderRadius: 5,
          }}
        >
          <div style={{ ...mono, color: '#9cdcfe' }}>
            Settled history is available without a local runtime.
          </div>
          <div style={{ ...mono, color: '#858585' }}>
            {snapshot.current.settledEpisodeCount} Episode shadow(s) ·{' '}
            {snapshot.current.projectCutCount} Project Cut(s) · evidence{' '}
            {snapshot.current.evidenceLevel}. Git shadows are not Episode
            authority; raw replay and requalification require full evidence.
          </div>
          <button
            type="button"
            onClick={() => run(bridge.startContinuation)}
            style={{ ...mono, padding: '6px 10px', width: 'fit-content' }}
          >
            Start local continuation
          </button>
        </div>
      )}
      {snapshot?.current.state === 'evidence-degraded' && (
        <div style={{ ...mono, color: '#f48771', marginBottom: 10 }}>
          Settled evidence is degraded. Continuation is disabled until the
          reported shadow mismatch is repaired or full evidence is imported.
        </div>
      )}
      {snapshot?.current.state === 'uninitialized' && (
        <div
          style={{
            display: 'grid',
            gap: 5,
            padding: 8,
            marginBottom: 10,
            border: '1px solid #3c3c3c',
            borderRadius: 5,
          }}
        >
          <div style={{ ...mono, color: '#9cdcfe' }}>
            This Project has not been initialized yet.
          </div>
          <div style={{ ...mono, color: '#858585' }}>
            Open the focused Profile and run its first fact-bearing action when
            you are ready.
          </div>
        </div>
      )}
      {snapshot?.recent.map((recent) => (
        <button
          key={recent.workspace_id}
          type="button"
          disabled={
            recent.workspace_kind === 'project' && !recent.workspace_root
          }
          onClick={() =>
            recent.workspace_id &&
            run(() => bridge.recent(recent.workspace_id as string))
          }
          style={{
            ...mono,
            display: 'block',
            width: '100%',
            padding: '5px 7px',
            border: 'none',
            background: 'transparent',
            color: '#cccccc',
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          {recent.display_path || recent.workspace_root || 'Personal Project'}
        </button>
      ))}
      {error && <div style={{ ...mono, color: '#f48771' }}>{error}</div>}
    </section>
  );
}

async function requestRuntimeRecovery(message: string) {
  const ipcRenderer = (
    window.require('electron') as { ipcRenderer: RuntimeRecoveryIpc }
  ).ipcRenderer;
  const result = await ipcRenderer.invoke(RUNTIME_BACKUP_RESET_CHANNEL, {
    message,
  });
  if (!result.ok && !result.canceled)
    return result.error || 'runtime recovery failed';
  return '';
}

function useRuntimeRecovery(message: string) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const backupAndReset = React.useCallback(() => {
    setBusy(true);
    setError('');
    void requestRuntimeRecovery(message)
      .then(setError)
      .catch((reason) => setError((reason as Error).message))
      .finally(() => setBusy(false));
  }, [message]);
  return { busy, error, backupAndReset };
}

function RuntimeFailureSurface({ message }: { message: string }) {
  const { busy, error, backupAndReset } = useRuntimeRecovery(message);
  const resettable = isResettableRuntimeFailure(message);
  return (
    <section style={{ ...panelStyle, width: 'min(680px, 100%)' }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>
        Project runtime unavailable
      </h2>
      <pre
        style={{
          ...mono,
          color: '#f48771',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
        }}
      >
        {message || 'Unknown runtime startup failure'}
      </pre>
      {resettable && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={backupAndReset}
            style={{ ...mono, padding: '6px 10px' }}
          >
            {busy ? 'Preparing recovery…' : 'Back up and reset runtime'}
          </button>
          <div style={{ ...mono, color: '#858585', marginTop: 8 }}>
            The current runtime is preserved under
            .kungfu/backups/runtime-recovery before Kungfu creates a fresh one.
          </div>
        </>
      )}
      {error && <div style={{ ...mono, color: '#f48771' }}>{error}</div>}
    </section>
  );
}

export const RuntimeFailurePanel = RuntimeFailureSurface;

// One failing kfx renders its error panel; it never takes the shell down.
export class KfxErrorBoundary extends React.Component<
  { kfxId: string; children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { kfxId: string }) {
    if (prev.kfxId !== this.props.kfxId && this.state.error) {
      this.setState({ error: null });
    }
  }
  render() {
    if (this.state.error) {
      return (
        <section style={panelStyle}>
          <div style={{ ...mono, color: '#f48771' }}>
            kfx `{this.props.kfxId}` failed: {this.state.error.message}
          </div>
          <div style={{ ...mono, color: '#6a6a6a', marginTop: 4 }}>
            the shell and other kfx keep running — see the console for the stack
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}

export type CoreSurfaceId = 'projects' | 'agent-work-lab' | 'core-work';

export function useRetainedCoreSurfaces(
  visible?: CoreSurfaceId,
): ReadonlySet<CoreSurfaceId> {
  const [retained, setRetained] = React.useState<ReadonlySet<CoreSurfaceId>>(
    () => new Set(visible ? [visible] : []),
  );
  React.useEffect(() => {
    if (!visible) return;
    setRetained((current) =>
      current.has(visible) ? current : new Set([...current, visible]),
    );
  }, [visible]);
  return retained;
}

type ProjectsPanelProps = React.ComponentProps<typeof ProjectsPanel>;
type LabPanelProps = React.ComponentProps<typeof AgentWorkLabPanel>;

export function RetainedCoreSurfaceStack({
  visible,
  retained,
  projects,
  focusedPath,
  onCatalog,
  onOpenProject,
  onOpenExistingProject,
  onRestoreProject,
  lab,
  startup,
  onOpenWork,
  onOpenLabExistingProject,
  onOpenStarterProject,
  onLabComplete,
  work,
}: {
  visible?: CoreSurfaceId;
  retained: ReadonlySet<CoreSurfaceId>;
  projects: ProjectsPanelProps['projects'];
  focusedPath: ProjectsPanelProps['focusedPath'];
  onCatalog: ProjectsPanelProps['onCatalog'];
  onOpenProject: ProjectsPanelProps['onOpenProject'];
  onOpenExistingProject: ProjectsPanelProps['onOpenExistingProject'];
  onRestoreProject: ProjectsPanelProps['onRestoreProject'];
  lab: LabPanelProps['lab'];
  startup: LabPanelProps['startup'];
  onOpenWork: LabPanelProps['onOpenWork'];
  onOpenLabExistingProject: LabPanelProps['onOpenExistingProject'];
  onOpenStarterProject: LabPanelProps['onOpenStarterProject'];
  onLabComplete: LabPanelProps['onComplete'];
  work: React.ReactNode;
}) {
  return (
    <>
      {visible === 'projects' || retained.has('projects') ? (
        <div
          style={{
            display: visible === 'projects' ? 'block' : 'none',
            height: '100%',
          }}
        >
          <ProjectsPanel
            projects={projects}
            focusedPath={focusedPath}
            onCatalog={onCatalog}
            onOpenProject={onOpenProject}
            onOpenExistingProject={onOpenExistingProject}
            onRestoreProject={onRestoreProject}
          />
        </div>
      ) : null}
      {visible === 'agent-work-lab' || retained.has('agent-work-lab') ? (
        <div
          style={{
            display: visible === 'agent-work-lab' ? 'block' : 'none',
            height: '100%',
          }}
        >
          <AgentWorkLabPanel
            lab={lab}
            startup={startup}
            onOpenWork={onOpenWork}
            onOpenExistingProject={onOpenLabExistingProject}
            onOpenStarterProject={onOpenStarterProject}
            onComplete={onLabComplete}
          />
        </div>
      ) : null}
      {visible === 'core-work' || retained.has('core-work') ? (
        <div
          style={{
            display: visible === 'core-work' ? 'block' : 'none',
            height: '100%',
          }}
        >
          {work}
        </div>
      ) : null}
    </>
  );
}
