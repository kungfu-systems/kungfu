// SPDX-License-Identifier: Apache-2.0

import type {
  ProjectSummary,
  Projects,
  ProjectsCatalog,
} from '@kungfu-tech/api/capability';
import * as capability from '@kungfu-tech/api/capability';
import { mono, panelStyle } from '@kungfu-tech/kfx';
import React from 'react';
import { createAgentSessionProxy } from '../agent-session-proxy';
import { guiKungfuCliArgs } from '../runtime';

export function openRendererProjects() {
  type ExecFile = (
    file: string,
    args: string[],
    options: {
      encoding: 'utf8';
      env: Record<string, string | undefined>;
      maxBuffer: number;
    },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => void;
  type Spawn = (
    file: string,
    args: string[],
    options: {
      env: Record<string, string | undefined>;
      stdio: ['ignore', 'pipe', 'pipe'];
    },
  ) => {
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
  const childProcess = window.require('node:child_process') as {
    execFile: ExecFile;
    spawn: Spawn;
  };
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
  return capability.openProjects({
    bin,
    env,
    agentSessionClient: 'gui',
    agentSession: createAgentSessionProxy(electron.ipcRenderer),
    execFile: (file, values, options) =>
      new Promise<string>((resolve, reject) => {
        childProcess.execFile(
          file,
          args(values),
          options,
          (error, stdout, stderr) => {
            if (error) reject(new Error(stderr.trim() || error.message));
            else resolve(stdout);
          },
        );
      }),
    execFileEvents: (file, values, options, onLine) =>
      new Promise<void>((resolve, reject) => {
        const child = childProcess.spawn(file, args(values), {
          env: options.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let size = 0;
        let settled = false;
        const fail = (reason: Error) => {
          if (settled) return;
          settled = true;
          child.kill();
          reject(reason);
        };
        child.stdout.on('data', (chunk) => {
          const text = String(chunk);
          size += text.length;
          if (size > options.maxBuffer) {
            fail(new Error('Work activity stream exceeded maxBuffer'));
            return;
          }
          stdout += text;
          const lines = stdout.split(/\r?\n/);
          stdout = lines.pop() ?? '';
          for (const line of lines) if (line.trim()) onLine(line);
        });
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.once('error', (reason) =>
          fail(reason instanceof Error ? reason : new Error(String(reason))),
        );
        child.once('close', (code) => {
          if (settled) return;
          if (stdout.trim()) onLine(stdout);
          if (code !== 0) {
            fail(new Error(stderr.trim() || `kungfu run exited ${code}`));
            return;
          }
          settled = true;
          resolve();
        });
      }),
  });
}

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
