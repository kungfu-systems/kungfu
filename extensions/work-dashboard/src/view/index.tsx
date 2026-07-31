import type {
  GlobalWorkFilter,
  GlobalWorkSnapshot,
  Profile,
  ProjectFileTreeEntry,
  ProjectSummary,
  ProjectWorkCapturePlan,
  ProjectWorkRunPlan,
  ProjectWorkRunSnapshot,
  Projects,
  ProjectsCatalog,
} from '@kungfu-tech/api/capability';
import {
  filterGlobalWork,
  parseGlobalWorkSnapshot,
  projectFileTreeLabel,
  toggleProjectFileTreeEntry,
} from '@kungfu-tech/api/capability';
import type { KfxCapabilities, Shell } from '@kungfu-tech/kfx';
import {
  ProjectWorkRunConfirmation,
  ProjectWorkRunSession,
  headingStyle,
  mono,
  panelStyle,
} from '@kungfu-tech/kfx';
import React from 'react';

import {
  type GlobalWorkObserverEvent,
  type GlobalWorkObserverIpc,
  subscribeGlobalWorkObserver,
} from './global-work-observer';
import { assignmentSelector, resolveWorkProject } from './project-work-run';
import { openWorkControlProfile } from './work-control-profile';

// Preserve the qualified Profile application service without restoring its
// retired legacy presentation. The visible Work view is intentionally
// read-only.
export function openProfileApplication(profile: Profile, defaultRepoRoot = '') {
  const application = openWorkControlProfile(profile, defaultRepoRoot);
  return {
    createInitiative: (
      ...args: Parameters<typeof application.createInitiative>
    ) => application.createInitiative(...args),
    createAssignment: (
      ...args: Parameters<typeof application.createAssignment>
    ) => application.createAssignment(...args),
    appendAssignmentRelationEvent: (
      ...args: Parameters<typeof application.appendAssignmentRelationEvent>
    ) => application.appendAssignmentRelationEvent(...args),
    claimAssignment: (
      ...args: Parameters<typeof application.claimAssignment>
    ) => application.claimAssignment(...args),
    advanceAssignment: (
      ...args: Parameters<typeof application.advanceAssignment>
    ) => application.advanceAssignment(...args),
    claimCompletion: (
      ...args: Parameters<typeof application.claimCompletion>
    ) => application.claimCompletion(...args),
    assessInitiativeAsync: (
      ...args: Parameters<typeof application.assessInitiativeAsync>
    ) => application.assessInitiativeAsync(...args),
    reviewCompletion: (
      ...args: Parameters<typeof application.reviewCompletion>
    ) => application.reviewCompletion(...args),
    decideContinuation: (
      ...args: Parameters<typeof application.decideContinuation>
    ) => application.decideContinuation(...args),
    importRepo: (...args: Parameters<typeof application.importRepo>) =>
      application.importRepo(...args),
    activateWorkControl: (
      ...args: Parameters<typeof application.activateWorkControl>
    ) => application.activateWorkControl(...args),
    restoreAtlasAuthority: (
      ...args: Parameters<typeof application.restoreAtlasAuthority>
    ) => application.restoreAtlasAuthority(...args),
    exportInitiative: (
      ...args: Parameters<typeof application.exportInitiative>
    ) => application.exportInitiative(...args),
    importInitiative: (
      ...args: Parameters<typeof application.importInitiative>
    ) => application.importInitiative(...args),
    intentPlan: (...args: Parameters<typeof profile.intentPlan>) =>
      profile.intentPlan(...args),
  };
}

type NodeHost = {
  require: NodeRequire;
  process: NodeJS.Process;
};

function TextInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      value={value}
      placeholder="Filter Work or Project"
      onChange={(event) => onChange(event.target.value)}
      style={{
        ...mono,
        minWidth: 0,
        border: '1px solid #3c3c3c',
        borderRadius: 4,
        background: '#1e1e1e',
        color: '#cccccc',
        padding: '4px 6px',
      }}
    />
  );
}

const projectNavButtonStyle = (selected: boolean): React.CSSProperties => ({
  ...mono,
  width: '100%',
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  padding: '9px 10px',
  border: `1px solid ${selected ? '#4fc1ff' : 'transparent'}`,
  borderRadius: 6,
  background: selected ? '#04395e' : 'transparent',
  color: selected ? '#f1f1f1' : '#cccccc',
  cursor: 'pointer',
  textAlign: 'left',
});

const projectActionStyle: React.CSSProperties = {
  ...mono,
  border: '1px solid #4b4b4b',
  borderRadius: 5,
  background: '#2d2d30',
  color: '#f1f1f1',
  padding: '6px 9px',
  cursor: 'pointer',
};

function ProjectNavigation({
  project,
  section,
  workCount,
  workLoading,
  onSection,
}: {
  project: ProjectSummary | undefined;
  section: 'files' | 'work';
  workCount: number;
  workLoading: boolean;
  onSection: (section: 'files' | 'work') => void;
}) {
  return (
    <aside
      aria-label="Project sections"
      style={{
        ...panelStyle,
        width: 210,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        overflow: 'hidden',
      }}
    >
      <style>{`
        @keyframes kf-project-nav-spin {
          to { transform: rotate(360deg); }
        }
        .kf-project-nav-spinner {
          display: inline-block;
          animation: kf-project-nav-spin 900ms linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .kf-project-nav-spinner { animation: none; }
        }
      `}</style>
      <div
        style={{
          ...mono,
          color: '#4fc1ff',
          fontWeight: 700,
          letterSpacing: '.08em',
        }}
      >
        PROJECT
      </div>
      <div
        title={project?.name}
        style={{
          fontWeight: 700,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {project?.name ?? 'Opening Project…'}
      </div>
      <div style={{ height: 1, background: '#3c3c3c', margin: '3px 0' }} />
      <button
        type="button"
        aria-current={section === 'files' ? 'page' : undefined}
        onClick={() => onSection('files')}
        style={projectNavButtonStyle(section === 'files')}
      >
        <span>Files</span>
        <span aria-hidden="true" style={{ color: '#858585' }}>
          tree
        </span>
      </button>
      <button
        type="button"
        aria-current={section === 'work' ? 'page' : undefined}
        onClick={() => onSection('work')}
        style={projectNavButtonStyle(section === 'work')}
      >
        <span>Work</span>
        <span
          title={workLoading ? 'Retained Work is still loading' : undefined}
          style={{ color: workLoading ? '#dcdcaa' : '#9cdcfe' }}
        >
          {workLoading ? (
            <span className="kf-project-nav-spinner">↻</span>
          ) : (
            workCount
          )}
        </span>
      </button>
      <div style={{ ...mono, color: '#858585', marginTop: 'auto' }}>
        Files are read-only. Work remains governed by Kungfu.
      </div>
    </aside>
  );
}

function ProjectFilesView({
  project,
  projects,
}: {
  project: ProjectSummary;
  projects: Projects;
}) {
  const [expandedPaths, setExpandedPaths] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [selected, setSelected] = React.useState<ProjectFileTreeEntry>();
  const [notice, setNotice] = React.useState('');
  const tree = React.useMemo(() => {
    try {
      return {
        entries: projects.files(project.path, { expandedPaths }),
        error: '',
      };
    } catch (reason) {
      return {
        entries: [] as ProjectFileTreeEntry[],
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }
  }, [expandedPaths, project.path, projects]);

  React.useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const activate = (entry: ProjectFileTreeEntry) => {
    setSelected(entry);
    if (entry.kind === 'directory') {
      setExpandedPaths((current) => toggleProjectFileTreeEntry(current, entry));
    }
  };
  const copyPath = async (entry: ProjectFileTreeEntry) => {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(entry.absolutePath);
      } else {
        (
          (window as unknown as NodeHost).require('electron') as {
            clipboard: { writeText: (value: string) => void };
          }
        ).clipboard.writeText(entry.absolutePath);
      }
      setNotice(`Copied ${entry.absolutePath}`);
    } catch (reason) {
      setNotice(
        `Could not copy path: ${
          reason instanceof Error ? reason.message : String(reason)
        }`,
      );
    }
  };

  return (
    <section
      style={{
        ...panelStyle,
        minHeight: 0,
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          marginBottom: 8,
        }}
      >
        <div>
          <h2 style={headingStyle}>Files</h2>
          <div style={{ ...mono, color: '#858585' }}>
            One level is shown by default. Expand folders without opening file
            contents.
          </div>
        </div>
        <button
          type="button"
          disabled={!selected || selected.kind === 'directory'}
          onClick={() => selected && void copyPath(selected)}
          style={{
            ...mono,
            border: '1px solid #4b4b4b',
            borderRadius: 5,
            background: '#2d2d30',
            color: '#f1f1f1',
            padding: '6px 9px',
            cursor:
              !selected || selected.kind === 'directory'
                ? 'default'
                : 'pointer',
          }}
        >
          Copy absolute path
        </button>
      </div>
      <div
        title={project.path}
        style={{
          ...mono,
          color: '#9cdcfe',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          marginBottom: 8,
        }}
      >
        {project.path}
      </div>
      {tree.error ? (
        <div style={{ ...mono, color: '#f48771' }}>{tree.error}</div>
      ) : (
        <div
          role="tree"
          aria-label={`${project.name} files`}
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            border: '1px solid #3c3c3c',
            borderRadius: 6,
            padding: 6,
            background: '#1e1e1e',
          }}
        >
          {tree.entries.map((entry) => (
            <button
              type="button"
              aria-expanded={
                entry.kind === 'directory' ? !entry.collapsed : undefined
              }
              key={entry.relativePath}
              title={entry.absolutePath}
              onClick={() => activate(entry)}
              onDoubleClick={() => {
                if (entry.kind !== 'directory') void copyPath(entry);
              }}
              style={{
                ...mono,
                display: 'block',
                width: '100%',
                border: 'none',
                borderRadius: 4,
                padding: '6px 8px',
                background:
                  selected?.relativePath === entry.relativePath
                    ? '#04395e'
                    : 'transparent',
                color: entry.kind === 'directory' ? '#9cdcfe' : '#cccccc',
                cursor: 'pointer',
                textAlign: 'left',
                whiteSpace: 'pre',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {projectFileTreeLabel(entry)}
            </button>
          ))}
          {tree.entries.length === 0 ? (
            <div style={{ ...mono, color: '#858585', padding: 8 }}>
              This Project folder is empty.
            </div>
          ) : null}
        </div>
      )}
      {notice ? (
        <output style={{ ...mono, color: '#89d185', marginTop: 8 }}>
          {notice}
        </output>
      ) : null}
    </section>
  );
}

function ProjectWorkLoading({ projectName }: { projectName: string }) {
  return (
    <section
      aria-label="Loading Project Work"
      style={{
        ...panelStyle,
        flex: 1,
        display: 'grid',
        placeItems: 'center',
        minHeight: 0,
      }}
    >
      <style>{`
        @keyframes kf-project-work-spin {
          to { transform: rotate(360deg); }
        }
        .kf-project-work-spinner {
          animation: kf-project-work-spin 900ms linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .kf-project-work-spinner { animation: none; }
        }
      `}</style>
      <div style={{ display: 'grid', justifyItems: 'center', gap: 9 }}>
        <span
          aria-hidden="true"
          className="kf-project-work-spinner"
          style={{
            width: 22,
            height: 22,
            border: '2px solid #315f79',
            borderTopColor: '#4fc1ff',
            borderRadius: '50%',
          }}
        />
        <strong>Loading retained Project Work…</strong>
        <span style={{ ...mono, color: '#858585' }}>
          {projectName} remains open while Kungfu restores its Work graph.
        </span>
      </div>
    </section>
  );
}

function NewProjectWorkDialog({
  project,
  projects,
  onClose,
  onCreated,
}: {
  project: ProjectSummary;
  projects: Projects;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [objective, setObjective] = React.useState('');
  const [acceptance, setAcceptance] = React.useState('');
  const [plan, setPlan] = React.useState<ProjectWorkCapturePlan>();
  const [busy, setBusy] = React.useState('');
  const [error, setError] = React.useState('');
  const objectiveRef = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    objectiveRef.current?.focus();
  }, []);
  const prepare = () => {
    try {
      setPlan(projects.prepareWork(objective, acceptance));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const create = () => {
    if (!plan) return;
    setBusy('Creating governed Work…');
    setError('');
    void projects
      .captureWork(project.path, plan)
      .then(onCreated)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setBusy(''));
  };
  const planMatches =
    plan?.objective === objective.trim() &&
    plan.acceptanceChecks[0] === acceptance.trim();

  return (
    <dialog
      open
      aria-modal="true"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 50,
        background: 'rgba(0,0,0,0.84)',
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
        <h3 style={{ marginTop: 0 }}>New Work · {project.name}</h3>
        <label style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
          <span style={mono}>What should the Agent do?</span>
          <textarea
            ref={objectiveRef}
            value={objective}
            onChange={(event) => {
              setObjective(event.target.value);
              setPlan(undefined);
            }}
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
            value={acceptance}
            onChange={(event) => {
              setAcceptance(event.target.value);
              setPlan(undefined);
            }}
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
        {plan ? (
          <div
            style={{
              ...mono,
              color: '#89d185',
              marginTop: 10,
              padding: 9,
              border: '1px solid #315f79',
              borderRadius: 5,
            }}
          >
            Ready to create one retained Work item. No Agent starts yet.
          </div>
        ) : null}
        {busy ? (
          <div style={{ ...mono, color: '#dcdcaa', marginTop: 10 }}>
            ◌ {busy}
          </div>
        ) : null}
        {error ? (
          <div style={{ ...mono, color: '#f48771', marginTop: 10 }}>
            {error}
          </div>
        ) : null}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 14,
          }}
        >
          <button type="button" style={projectActionStyle} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            style={projectActionStyle}
            disabled={Boolean(busy) || !objective.trim() || !acceptance.trim()}
            onClick={prepare}
          >
            Review Work
          </button>
          {planMatches ? (
            <button
              type="button"
              style={{
                ...projectActionStyle,
                borderColor: '#89d185',
                background: '#1f4d2e',
              }}
              disabled={Boolean(busy)}
              onClick={create}
            >
              Create Work
            </button>
          ) : null}
        </div>
      </div>
    </dialog>
  );
}

function GlobalWorkView({
  shell,
  projects,
}: {
  shell: Shell;
  projects: Projects;
}) {
  const host = window as unknown as NodeHost;
  const [snapshot, setSnapshot] = React.useState<GlobalWorkSnapshot | null>(
    null,
  );
  const [selected, setSelected] = React.useState<string | null>(
    () => shell.params.workId?.trim() || null,
  );
  const [search, setSearch] = React.useState('');
  const [filter, setFilter] = React.useState<GlobalWorkFilter>('active');
  const [projectSection, setProjectSection] = React.useState<'files' | 'work'>(
    () => (shell.params.projectSection === 'work' ? 'work' : 'files'),
  );
  const [newWorkOpen, setNewWorkOpen] = React.useState(false);
  const [status, setStatus] = React.useState('Connecting All Work…');
  const [error, setError] = React.useState('');
  const [projectsCatalog, setProjectsCatalog] =
    React.useState<ProjectsCatalog>();
  const [projectsCatalogReady, setProjectsCatalogReady] = React.useState(false);
  const [runs, setRuns] = React.useState<ProjectWorkRunSnapshot[]>(() =>
    projects.runs(),
  );
  const [visibleRunId, setVisibleRunId] = React.useState<string | null>(
    () => projects.runs()[0]?.id ?? null,
  );
  const [runPlan, setRunPlan] = React.useState<{
    provider: string;
    workspace: string;
    work: string;
    plan: ProjectWorkRunPlan;
  }>();
  const [runBusy, setRunBusy] = React.useState('');
  const [runError, setRunError] = React.useState('');
  const lastNotification = React.useRef({ key: '', at: 0 });
  const shellRef = React.useRef(shell);
  shellRef.current = shell;
  const ipc = React.useMemo(
    () =>
      (
        host.require('electron') as {
          ipcRenderer: GlobalWorkObserverIpc;
        }
      ).ipcRenderer,
    [host],
  );

  React.useEffect(() => {
    const requestedWorkId = shell.params.workId?.trim();
    if (!requestedWorkId) return;
    setSelected(requestedWorkId);
    setSearch('');
  }, [shell.params.workId]);
  React.useEffect(() => {
    if (!shell.params.projectId?.trim() && !shell.params.projectPath?.trim()) {
      return;
    }
    setProjectSection(
      shell.params.projectSection === 'work' ? 'work' : 'files',
    );
  }, [
    shell.params.projectId,
    shell.params.projectPath,
    shell.params.projectSection,
  ]);

  React.useEffect(() => {
    let dispose: (() => Promise<void>) | undefined;
    let stopped = false;
    const receive = (event: GlobalWorkObserverEvent) => {
      if (stopped) return;
      if (event.kind === 'error') {
        setError(event.error);
        setStatus('cached view · live recovery pending');
        return;
      }
      let next: GlobalWorkSnapshot;
      try {
        next = parseGlobalWorkSnapshot(event.snapshot);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setStatus('Cached Work · live recovery pending');
        return;
      }
      setSnapshot(next);
      setError('');
      setStatus(
        `live · ${next.aggregate?.component_count ?? 0} active workspaces`,
      );
      if (
        event.mode === 'incremental' &&
        event.changed_workspace_ids.length > 0
      ) {
        const key = event.changed_workspace_ids.join('|');
        const now = Date.now();
        if (
          key !== lastNotification.current.key ||
          now - lastNotification.current.at > 4000
        ) {
          lastNotification.current = { key, at: now };
          shellRef.current.notify({
            level: 'info',
            title: 'All Work updated',
            message: event.changed_workspace_ids.slice(0, 3).join(' · '),
            timeoutMs: 4000,
          });
        }
      }
    };
    void subscribeGlobalWorkObserver(ipc, receive)
      .then((stop) => {
        if (stopped) void stop();
        else dispose = stop;
      })
      .catch((caught: unknown) => {
        if (!stopped) {
          setError((caught as Error).message);
          setStatus('live observer unavailable');
        }
      });
    return () => {
      stopped = true;
      if (dispose) void dispose();
    };
  }, [ipc]);
  React.useEffect(() => {
    let active = true;
    void projects
      .list()
      .then((catalog) => {
        if (active) setProjectsCatalog(catalog);
      })
      .catch((reason) => {
        if (active)
          setRunError(
            reason instanceof Error ? reason.message : String(reason),
          );
      })
      .finally(() => {
        if (active) setProjectsCatalogReady(true);
      });
    const unsubscribe = projects.subscribeRuns(setRuns);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [projects]);

  const requestedProjectId = shell.params.projectId?.trim();
  const requestedProjectPath = shell.params.projectPath?.trim();
  const requestedProject =
    projectsCatalog?.projects.find(
      (project) => project.id === requestedProjectId,
    ) ??
    projectsCatalog?.projects.find(
      (project) => project.path === requestedProjectPath,
    );
  const requestedProjectKey = requestedProjectId || requestedProjectPath;
  const allAssignmentRows = snapshot
    ? filterGlobalWork(snapshot, 'all').filter(
        (row) => row.object_kind === 'assignment',
      )
    : [];
  const filteredAssignmentRows = snapshot
    ? filterGlobalWork(snapshot, filter).filter(
        (row) => row.object_kind === 'assignment',
      )
    : [];
  const projectRows = requestedProject
    ? allAssignmentRows.filter(
        (row) =>
          resolveWorkProject(row.observations, projectsCatalog?.projects ?? [])
            ?.id === requestedProject.id,
      )
    : [];
  const rows = requestedProject
    ? filteredAssignmentRows.filter(
        (row) =>
          resolveWorkProject(row.observations, projectsCatalog?.projects ?? [])
            ?.id === requestedProject.id,
      )
    : filteredAssignmentRows;
  const needle = search.trim().toLowerCase();
  const visible = rows.filter(
    (row) =>
      !needle ||
      row.subject.toLowerCase().includes(needle) ||
      (row.display.title ?? '').toLowerCase().includes(needle) ||
      row.observations.some((item) =>
        (item.workspace_id ?? '').toLowerCase().includes(needle),
      ),
  );
  const current =
    rows.find((row) => row.canonical_root === selected) ?? visible[0] ?? null;
  const currentProject = current
    ? resolveWorkProject(current.observations, projectsCatalog?.projects ?? [])
    : undefined;
  const workSelector =
    current?.object_kind === 'assignment'
      ? assignmentSelector(current.subject)
      : undefined;
  const visibleRun = runs.find((run) => run.id === visibleRunId) ?? null;
  const prepareRun = (provider: string) => {
    if (!currentProject || !workSelector) return;
    setRunBusy(`Checking ${provider} and the selected Work…`);
    setRunError('');
    void projects
      .planRun(provider, {
        workspace: currentProject.path,
        work: workSelector,
      })
      .then((plan) =>
        setRunPlan({
          provider,
          workspace: currentProject.path,
          work: workSelector,
          plan,
        }),
      )
      .catch((reason) =>
        setRunError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setRunBusy(''));
  };
  const confirmRun = () => {
    if (!runPlan) return;
    const pending = projects.run(
      runPlan.provider,
      {
        workspace: runPlan.workspace,
        work: runPlan.work,
        expectedPlanRoot: runPlan.plan.planRoot,
      },
      () => undefined,
    );
    setRunPlan(undefined);
    setVisibleRunId(projects.runs()[0]?.id ?? null);
    setRunBusy(`Starting ${runPlan.provider}…`);
    void pending
      .catch((reason) =>
        setRunError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setRunBusy(''));
  };

  const workLoading = !snapshot || !projectsCatalogReady;
  const projectNameFallback =
    requestedProjectPath?.split(/[\\/]/u).filter(Boolean).at(-1) ??
    requestedProjectId ??
    'Project';
  const workControls = (
    <div style={{ display: 'flex', gap: 8 }}>
      <TextInput value={search} onChange={setSearch} />
      {(['active', 'completed', 'all'] as const).map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => setFilter(value)}
          style={{
            ...mono,
            border: `1px solid ${filter === value ? '#4fc1ff' : '#3c3c3c'}`,
            borderRadius: 5,
            background: filter === value ? '#04395e' : '#252526',
            color: filter === value ? '#f1f1f1' : '#cccccc',
            padding: '4px 9px',
            cursor: 'pointer',
            textTransform: 'capitalize',
          }}
        >
          {value}
        </button>
      ))}
    </div>
  );
  const workColumns = (
    <div
      style={{
        display: 'flex',
        gap: 12,
        flex: 1,
        minHeight: 0,
        marginTop: 8,
      }}
    >
      <section
        style={{ ...panelStyle, width: 460, overflow: 'auto', flexShrink: 0 }}
      >
        {visible.map((row) => (
          <button
            type="button"
            key={row.canonical_root}
            onClick={() => setSelected(row.canonical_root)}
            style={{
              ...mono,
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: 8,
              marginBottom: 3,
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              background:
                current?.canonical_root === row.canonical_root
                  ? '#04395e'
                  : 'transparent',
              color: '#cccccc',
            }}
          >
            <span style={{ color: row.conflict ? '#f48771' : '#4ec9b0' }}>
              [{row.display.status || row.display.portfolio_state || 'open'}]
            </span>{' '}
            {row.display.title || row.subject}
            <div style={{ color: '#858585', fontSize: 11 }}>
              {row.observations
                .map((item) => item.workspace_id)
                .filter(Boolean)
                .join(' · ')}
            </div>
          </button>
        ))}
        {visible.length === 0 ? (
          <div style={{ ...mono, color: '#6a6a6a', padding: 8 }}>
            No Work matches this view.
          </div>
        ) : null}
      </section>
      <section style={{ ...panelStyle, flex: 1, overflow: 'auto' }}>
        {current ? (
          <>
            <h2 style={headingStyle}>
              {current.display.title || current.subject}
            </h2>
            <div style={{ ...mono, color: '#9cdcfe' }}>
              Work · {current.subject}
            </div>
            <div style={{ ...mono, color: '#cccccc', marginTop: 8 }}>
              status:{' '}
              {current.display.status ||
                current.display.portfolio_state ||
                'open'}
            </div>
            {(current.display.next_actions ?? []).map((action) => (
              <div key={action} style={{ ...mono, color: '#dcdcaa' }}>
                next: {action}
              </div>
            ))}
            {current.object_kind === 'assignment' && currentProject ? (
              <>
                <h2 style={{ ...headingStyle, marginTop: 14 }}>
                  Run with an Agent
                </h2>
                <div style={{ ...mono, color: '#858585', marginBottom: 8 }}>
                  Project · {currentProject.name}. Preview the exact effects
                  before the Agent starts.
                </div>
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                  {(['codex', 'claude', 'opencode'] as const).map(
                    (provider) => (
                      <button
                        key={provider}
                        type="button"
                        disabled={Boolean(runBusy)}
                        onClick={() => prepareRun(provider)}
                        style={{
                          ...mono,
                          padding: '6px 9px',
                          border: '1px solid #4b4b4b',
                          borderRadius: 5,
                          background: '#2d2d30',
                          color: '#f1f1f1',
                          cursor: 'pointer',
                        }}
                      >
                        Run {provider === 'opencode' ? 'OpenCode' : provider}
                      </button>
                    ),
                  )}
                  {runs.some(
                    (run) =>
                      run.workspace === currentProject.path &&
                      run.work === workSelector,
                  ) ? (
                    <button
                      type="button"
                      onClick={() =>
                        setVisibleRunId(
                          runs.find(
                            (run) =>
                              run.workspace === currentProject.path &&
                              run.work === workSelector,
                          )?.id ?? null,
                        )
                      }
                      style={{
                        ...mono,
                        padding: '6px 9px',
                        border: '1px solid #4fc1ff',
                        borderRadius: 5,
                        background: '#102c3c',
                        color: '#f1f1f1',
                        cursor: 'pointer',
                      }}
                    >
                      Open Session
                    </button>
                  ) : null}
                </div>
                {runBusy ? (
                  <div style={{ ...mono, color: '#dcdcaa', marginTop: 8 }}>
                    ◌ {runBusy}
                  </div>
                ) : null}
                {runError ? (
                  <div style={{ ...mono, color: '#f48771', marginTop: 8 }}>
                    {runError}
                  </div>
                ) : null}
              </>
            ) : null}
            <h2 style={{ ...headingStyle, marginTop: 14 }}>Project evidence</h2>
            {current.observations.map((observation, index) => (
              <div
                key={`${observation.workspace_id ?? 'workspace'}:${index}`}
                style={{ ...mono, color: '#858585' }}
              >
                {observation.workspace_id ?? 'unknown workspace'} ·{' '}
                {observation.availability ?? 'unknown'}
              </div>
            ))}
            <div
              style={{
                ...mono,
                color: '#6a6a6a',
                overflowWrap: 'anywhere',
                marginTop: 14,
              }}
            >
              root: {current.canonical_root}
            </div>
          </>
        ) : (
          <div style={{ ...mono, color: '#6a6a6a' }}>
            Select Work to inspect its status, next action, and Agent controls.
          </div>
        )}
      </section>
    </div>
  );
  const sessionPanel = visibleRun ? (
    <div style={{ marginTop: 8 }}>
      <ProjectWorkRunSession
        run={visibleRun}
        title={
          rows.find((row) => row.subject.endsWith(visibleRun.work ?? ''))
            ?.display.title
        }
        onClose={() => setVisibleRunId(null)}
      />
    </div>
  ) : null;
  const overlays = (
    <>
      {runPlan ? (
        <ProjectWorkRunConfirmation
          plan={runPlan.plan}
          busy={Boolean(runBusy)}
          onCancel={() => setRunPlan(undefined)}
          onConfirm={confirmRun}
        />
      ) : null}
      {newWorkOpen && requestedProject ? (
        <NewProjectWorkDialog
          project={requestedProject}
          projects={projects}
          onClose={() => setNewWorkOpen(false)}
          onCreated={() => {
            setNewWorkOpen(false);
            setProjectSection('work');
          }}
        />
      ) : null}
    </>
  );

  if (requestedProjectKey) {
    return (
      <div
        style={{
          display: 'flex',
          gap: 10,
          height: '100%',
          minHeight: 0,
          position: 'relative',
        }}
      >
        <ProjectNavigation
          project={requestedProject}
          section={projectSection}
          workCount={projectRows.length}
          workLoading={workLoading}
          onSection={setProjectSection}
        />
        <main
          style={{
            minWidth: 0,
            minHeight: 0,
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <section
            style={{
              ...panelStyle,
              marginBottom: 8,
              display: 'flex',
              justifyContent: 'space-between',
              gap: 16,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <h2 style={headingStyle}>
                {requestedProject?.name ?? projectNameFallback}
              </h2>
              <div
                title={requestedProjectPath}
                style={{
                  ...mono,
                  color: '#9cdcfe',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {requestedProject?.path ?? requestedProjectPath}
              </div>
              <div style={{ ...mono, color: '#4ec9b0', marginTop: 4 }}>
                {status}
              </div>
              {error || runError ? (
                <div style={{ ...mono, color: '#dcdcaa', marginTop: 4 }}>
                  {error || runError}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              disabled={!requestedProject}
              onClick={() => setNewWorkOpen(true)}
              style={{
                ...mono,
                alignSelf: 'center',
                border: '1px solid #4fc1ff',
                borderRadius: 6,
                background: '#0e639c',
                color: '#f1f1f1',
                padding: '7px 11px',
                cursor: requestedProject ? 'pointer' : 'default',
                fontWeight: 700,
              }}
            >
              + New Work
            </button>
          </section>
          {projectSection === 'files' ? (
            requestedProject ? (
              <ProjectFilesView
                project={requestedProject}
                projects={projects}
              />
            ) : (
              <ProjectWorkLoading projectName={projectNameFallback} />
            )
          ) : workLoading ? (
            <ProjectWorkLoading projectName={projectNameFallback} />
          ) : !requestedProject ? (
            <section style={{ ...panelStyle, color: '#f48771' }}>
              This Project is no longer available in the local Project catalog.
            </section>
          ) : (
            <>
              {workControls}
              {workColumns}
            </>
          )}
          {sessionPanel}
        </main>
        {overlays}
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        position: 'relative',
      }}
    >
      <section style={{ ...panelStyle, marginBottom: 8 }}>
        <h2 style={headingStyle}>All Work</h2>
        <div style={{ ...mono, color: '#4ec9b0' }}>{status}</div>
        <div style={{ ...mono, color: '#858585' }}>
          Home + {Math.max(0, (snapshot?.aggregate?.component_count ?? 1) - 1)}{' '}
          active local project workspace
          {(snapshot?.aggregate?.component_count ?? 1) === 2 ? '' : 's'} ·{' '}
          {rows.length} visible Work
        </div>
        {error ? (
          <div style={{ ...mono, color: '#dcdcaa' }}>{error}</div>
        ) : null}
      </section>
      {workControls}
      {workLoading ? (
        <ProjectWorkLoading projectName="All Work" />
      ) : (
        workColumns
      )}
      {sessionPanel}
      {overlays}
    </div>
  );
}

function WorkDashboardView({
  caps,
  shell,
}: {
  caps: KfxCapabilities;
  shell: Shell;
}) {
  if (!caps.projects) {
    return (
      <section style={panelStyle}>
        <div style={{ ...mono, color: '#f48771' }}>
          Projects capability unavailable
        </div>
      </section>
    );
  }
  return <GlobalWorkView shell={shell} projects={caps.projects} />;
}

export const View = WorkDashboardView;
