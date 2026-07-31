// SPDX-License-Identifier: Apache-2.0

import type {
  ProjectRemovePlan,
  ProjectSummary,
  ProjectWorkCapturePlan,
  ProjectWorkRunPlan,
  ProjectWorkRunSnapshot,
  Projects,
  ProjectsCatalog,
} from '@kungfu-tech/api/capability';
import * as capability from '@kungfu-tech/api/capability';
import {
  ProjectWorkRunConfirmation,
  ProjectWorkRunSession,
  mono,
  panelStyle,
} from '@kungfu-tech/kfx';
import React from 'react';
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
  onOpenWork,
}: {
  projects: Projects;
  focusedPath?: string;
  onCatalog: (catalog: ProjectsCatalog) => void;
  onOpenProject: (workspace: WorkspaceSelection) => Promise<unknown>;
  onOpenExistingProject: () => void;
  onOpenWork: (project: ProjectSummary, section?: 'files' | 'work') => void;
}) {
  const [catalog, setCatalog] = React.useState<ProjectsCatalog>();
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const [createPlan, setCreatePlan] = React.useState<CreatePlan>();
  const [workComposer, setWorkComposer] = React.useState<{
    project: ProjectSummary;
    plan?: ProjectWorkCapturePlan;
  }>();
  const [workObjective, setWorkObjective] = React.useState('');
  const [workAcceptance, setWorkAcceptance] = React.useState('');
  const [selectedWork, setSelectedWork] = React.useState<
    Record<string, string>
  >({});
  const [removePlan, setRemovePlan] = React.useState<ProjectRemovePlan>();
  const [runs, setRuns] = React.useState<ProjectWorkRunSnapshot[]>(() =>
    projects.runs(),
  );
  const [visibleRunId, setVisibleRunId] = React.useState<string | null>(
    () => projects.runs()[0]?.id ?? null,
  );
  const [runPlan, setRunPlan] = React.useState<{
    project: ProjectSummary;
    provider: string;
    plan: ProjectWorkRunPlan;
  }>();
  React.useEffect(() => projects.subscribeRuns(setRuns), [projects]);
  const onCatalogRef = React.useRef(onCatalog);
  React.useEffect(() => {
    onCatalogRef.current = onCatalog;
  }, [onCatalog]);

  const refresh = React.useCallback(() => {
    setBusy('Loading Projects…');
    setError('');
    return projects
      .list()
      .then((value) => {
        setCatalog(value);
        onCatalogRef.current(value);
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(''));
  }, [projects]);
  React.useEffect(() => {
    void refresh();
  }, [refresh]);

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

  const prepareWork = React.useCallback(
    (project: ProjectSummary) => {
      try {
        const plan = projects.prepareWork(workObjective, workAcceptance);
        setWorkComposer({ project, plan });
        setError('');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    },
    [projects, workAcceptance, workObjective],
  );
  const captureWork = React.useCallback(() => {
    if (!workComposer?.plan) return;
    const { project, plan } = workComposer;
    setBusy(`Creating Work in ${project.name}…`);
    setError('');
    void projects
      .captureWork(project.path, plan)
      .then(() => {
        setSelectedWork((current) => ({
          ...current,
          [project.path]: plan.assignmentId,
        }));
        setWorkComposer(undefined);
        setWorkObjective('');
        setWorkAcceptance('');
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(''));
  }, [projects, workComposer]);

  const planRemove = React.useCallback(
    (project: ProjectSummary) => {
      setBusy(`Planning removal of ${project.name} from Kungfu…`);
      setError('');
      void projects
        .planRemove(project.id)
        .then(setRemovePlan)
        .catch((reason) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
        )
        .finally(() => setBusy(''));
    },
    [projects],
  );
  const confirmRemove = React.useCallback(() => {
    if (!removePlan) return;
    setBusy(`Removing ${removePlan.project.name} from Kungfu Projects…`);
    setError('');
    void projects
      .remove(removePlan.project.id, removePlan.planRoot)
      .then(() => {
        setRemovePlan(undefined);
        return refresh();
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(''));
  }, [projects, refresh, removePlan]);

  const planRun = React.useCallback(
    (project: ProjectSummary, provider: string) => {
      setBusy(`Checking ${provider} and the next Work…`);
      setError('');
      void projects
        .planRun(provider, {
          workspace: project.path,
          work: selectedWork[project.path],
        })
        .then((plan) => setRunPlan({ project, provider, plan }))
        .catch((reason) =>
          setError(reason instanceof Error ? reason.message : String(reason)),
        )
        .finally(() => setBusy(''));
    },
    [projects, selectedWork],
  );
  const confirmRun = React.useCallback(() => {
    if (!runPlan) return;
    const { project, provider } = runPlan;
    setBusy(`Starting ${provider} for ${project.name}…`);
    setError('');
    setRunPlan(undefined);
    const pending = projects.run(
      provider,
      {
        workspace: project.path,
        work: runPlan.plan.work.assignmentId,
        expectedPlanRoot: runPlan.plan.planRoot,
      },
      () => undefined,
    );
    setVisibleRunId(projects.runs()[0]?.id);
    void pending
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(''));
  }, [projects, runPlan]);
  const visibleRun = runs.find((run) => run.id === visibleRunId) ?? null;
  const openedProject = focusedPath
    ? catalog?.projects.find((project) => project.path === focusedPath)
    : undefined;
  const forwardedProject = React.useRef('');
  React.useEffect(() => {
    if (!openedProject || forwardedProject.current === openedProject.path) {
      return;
    }
    forwardedProject.current = openedProject.path;
    onOpenWork(openedProject, 'files');
  }, [onOpenWork, openedProject]);

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
            Open a Project, create Work, then choose an Agent. Kungfu remembers
            the Project while its files stay ordinary.
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
          <button type="button" style={buttonStyle} onClick={refresh}>
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
              gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
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
                  style={{ display: 'flex', justifyContent: 'space-between' }}
                >
                  <strong>{project.name}</strong>
                  <span
                    style={{
                      ...mono,
                      color: project.available ? '#89d185' : '#f48771',
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
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={!project.available || Boolean(busy)}
                    onClick={() => open(project)}
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={!project.available || Boolean(busy)}
                    onClick={() => onOpenWork(project, 'work')}
                  >
                    Work
                  </button>
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={!project.available || Boolean(busy)}
                    onClick={() => {
                      setWorkObjective('');
                      setWorkAcceptance('');
                      setWorkComposer({ project });
                    }}
                  >
                    New Work
                  </button>
                  {(
                    [
                      ['codex', 'Run Codex'],
                      ['claude', 'Run Claude'],
                      ['opencode', 'Run OpenCode'],
                    ] as const
                  ).map(([provider, label]) => (
                    <button
                      key={provider}
                      type="button"
                      style={buttonStyle}
                      disabled={!project.available || Boolean(busy)}
                      onClick={() => planRun(project, provider)}
                    >
                      {label}
                    </button>
                  ))}
                  {runs.some((run) => run.workspace === project.path) ? (
                    <button
                      type="button"
                      style={buttonStyle}
                      onClick={() =>
                        setVisibleRunId(
                          runs.find((run) => run.workspace === project.path)
                            ?.id ?? null,
                        )
                      }
                    >
                      Open Session
                    </button>
                  ) : null}
                  <button
                    type="button"
                    title="Remove from Kungfu Projects; keep every project file"
                    style={{ ...buttonStyle, color: '#f0b7ad' }}
                    disabled={Boolean(busy)}
                    onClick={() => planRemove(project)}
                  >
                    Remove
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
      {visibleRun ? (
        <ProjectWorkRunSession
          run={visibleRun}
          title={
            catalog?.projects.find(
              (project) => project.path === visibleRun.workspace,
            )?.name
          }
          onClose={() => setVisibleRunId(null)}
        />
      ) : null}
      {runPlan ? (
        <ProjectWorkRunConfirmation
          plan={runPlan.plan}
          busy={Boolean(busy)}
          onCancel={() => setRunPlan(undefined)}
          onConfirm={confirmRun}
        />
      ) : null}
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
      {workComposer ? (
        <dialog
          open
          aria-modal="true"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 50,
            background: 'rgba(0,0,0,0.82)',
            display: 'grid',
            placeItems: 'center',
            padding: 24,
          }}
        >
          <div
            style={{
              width: 'min(680px, 90vw)',
              background: '#252526',
              border: '2px solid #4fc1ff',
              borderRadius: 10,
              padding: 18,
              boxShadow: '0 18px 48px rgba(0,0,0,.55)',
            }}
          >
            <h3 style={{ marginTop: 0 }}>
              New Work · {workComposer.project.name}
            </h3>
            <label style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
              <span style={mono}>What should the Agent do?</span>
              <textarea
                value={workObjective}
                onChange={(event) => setWorkObjective(event.target.value)}
                rows={4}
                style={{
                  ...mono,
                  resize: 'vertical',
                  padding: 9,
                  border: '1px solid #4b4b4b',
                  borderRadius: 6,
                  background: '#1e1e1e',
                  color: '#f1f1f1',
                }}
              />
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={mono}>How will you know the Work is correct?</span>
              <textarea
                value={workAcceptance}
                onChange={(event) => setWorkAcceptance(event.target.value)}
                rows={3}
                style={{
                  ...mono,
                  resize: 'vertical',
                  padding: 9,
                  border: '1px solid #4b4b4b',
                  borderRadius: 6,
                  background: '#1e1e1e',
                  color: '#f1f1f1',
                }}
              />
            </label>
            <p style={{ ...mono, color: '#a8a8a8' }}>
              Kungfu creates one Work item in this Project. Choose an Agent
              after the Work is created.
            </p>
            <div
              style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}
            >
              <button
                type="button"
                style={buttonStyle}
                onClick={() => setWorkComposer(undefined)}
              >
                Cancel
              </button>
              <button
                type="button"
                style={{ ...buttonStyle, borderColor: '#4fc1ff' }}
                disabled={!workObjective.trim() || !workAcceptance.trim()}
                onClick={() => prepareWork(workComposer.project)}
              >
                Review Work
              </button>
              {workComposer.plan?.objective === workObjective.trim() &&
              workComposer.plan.acceptanceChecks[0] ===
                workAcceptance.trim() ? (
                <button
                  type="button"
                  style={{
                    ...buttonStyle,
                    borderColor: '#89d185',
                    background: '#1f4d2e',
                  }}
                  onClick={captureWork}
                >
                  Create Work
                </button>
              ) : null}
            </div>
          </div>
        </dialog>
      ) : null}
      {removePlan ? (
        <dialog
          open
          aria-modal="true"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 50,
            background: 'rgba(0,0,0,0.82)',
            display: 'grid',
            placeItems: 'center',
            padding: 24,
          }}
        >
          <div
            style={{
              width: 'min(620px, 90vw)',
              background: '#252526',
              border: '2px solid #f48771',
              borderRadius: 10,
              padding: 18,
              boxShadow: '0 18px 48px rgba(0,0,0,.55)',
            }}
          >
            <h3 style={{ marginTop: 0 }}>
              Remove {removePlan.project.name} from Kungfu?
            </h3>
            <div style={{ ...mono, color: '#9cdcfe' }}>
              {removePlan.project.path}
            </div>
            <p>
              This removes only the machine-local Projects locator. The project
              directory, its files, and retained Kungfu evidence will not be
              deleted.
            </p>
            <div
              style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}
            >
              <button
                type="button"
                style={buttonStyle}
                onClick={() => setRemovePlan(undefined)}
              >
                Cancel
              </button>
              <button
                type="button"
                style={{ ...buttonStyle, borderColor: '#f48771' }}
                onClick={confirmRemove}
              >
                Remove from Kungfu
              </button>
            </div>
          </div>
        </dialog>
      ) : null}
    </section>
  );
}
