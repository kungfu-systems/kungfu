import type {
  GlobalWorkFilter,
  GlobalWorkSnapshot,
  Profile,
  ProjectFileTreeEntry,
  ProjectRemovePlan,
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

type ProjectViewMemory = {
  section: 'files' | 'work';
  selectedFile?: ProjectFileTreeEntry;
};

const projectViewMemory = new Map<string, ProjectViewMemory>();

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
  projects,
  section,
  selectedFile,
  workCount,
  workLoading,
  onSection,
  onSelectFile,
}: {
  project: ProjectSummary | undefined;
  projects: Projects;
  section: 'files' | 'work';
  selectedFile: ProjectFileTreeEntry | undefined;
  workCount: number;
  workLoading: boolean;
  onSection: (section: 'files' | 'work') => void;
  onSelectFile: (entry: ProjectFileTreeEntry) => void;
}) {
  const [expandedPaths, setExpandedPaths] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const tree = React.useMemo(() => {
    if (!project) return { entries: [] as ProjectFileTreeEntry[], error: '' };
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
  }, [expandedPaths, project, projects]);
  const activate = (entry: ProjectFileTreeEntry) => {
    onSection('files');
    if (entry.kind === 'directory') {
      setExpandedPaths((current) => toggleProjectFileTreeEntry(current, entry));
    } else {
      onSelectFile(entry);
    }
  };
  return (
    <aside
      aria-label="Project sections"
      style={{
        ...panelStyle,
        width: 280,
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
          {tree.entries.length}
        </span>
      </button>
      {section === 'files' ? (
        <div
          role="tree"
          aria-label={`${project?.name ?? 'Project'} files`}
          style={{
            flex: 1,
            minHeight: 100,
            overflow: 'auto',
            border: '1px solid #3c3c3c',
            borderRadius: 6,
            padding: 4,
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
              style={{
                ...mono,
                display: 'block',
                width: '100%',
                border: 'none',
                borderRadius: 4,
                padding: '5px 6px',
                background:
                  selectedFile?.relativePath === entry.relativePath
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
          {tree.error ? (
            <div style={{ ...mono, color: '#f48771', padding: 6 }}>
              {tree.error}
            </div>
          ) : null}
          {!tree.error && tree.entries.length === 0 ? (
            <div style={{ ...mono, color: '#858585', padding: 6 }}>
              This Project folder is empty.
            </div>
          ) : null}
        </div>
      ) : null}
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
      <div style={{ ...mono, color: '#858585' }}>
        Files are read-only. Work remains governed by Kungfu.
      </div>
    </aside>
  );
}

function ProjectFilesView({
  project,
  projects,
  selected,
}: {
  project: ProjectSummary;
  projects: Projects;
  selected: ProjectFileTreeEntry | undefined;
}) {
  const [notice, setNotice] = React.useState('');
  const preview = React.useMemo(() => {
    if (!selected || selected.kind === 'directory') {
      return { value: undefined, error: '' };
    }
    try {
      return {
        value: projects.previewFile(project.path, selected.relativePath),
        error: '',
      };
    } catch (reason) {
      return {
        value: undefined,
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }
  }, [project.path, projects, selected]);

  React.useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

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
            Select a supported UTF-8 text file in the Project navigation.
          </div>
        </div>
        <button
          type="button"
          disabled={!preview.value}
          onClick={() => selected && void copyPath(selected)}
          style={{
            ...mono,
            border: '1px solid #4b4b4b',
            borderRadius: 5,
            background: '#2d2d30',
            color: '#f1f1f1',
            padding: '6px 9px',
            cursor: preview.value ? 'pointer' : 'default',
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
      {preview.error ? (
        <div
          style={{
            ...mono,
            color: '#dcdcaa',
            border: '1px solid #6b5b2a',
            borderRadius: 6,
            padding: 12,
          }}
        >
          {preview.error}
        </div>
      ) : preview.value ? (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            border: '1px solid #3c3c3c',
            borderRadius: 6,
            background: '#1e1e1e',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              ...mono,
              display: 'flex',
              justifyContent: 'space-between',
              gap: 12,
              padding: '8px 10px',
              borderBottom: '1px solid #3c3c3c',
              color: '#9cdcfe',
            }}
          >
            <span>{preview.value.relativePath}</span>
            <span style={{ color: '#858585', flexShrink: 0 }}>
              {preview.value.language} · {preview.value.size} bytes · read-only
            </span>
          </div>
          <pre
            aria-label={`${preview.value.name} contents`}
            style={{
              ...mono,
              flex: 1,
              minHeight: 0,
              margin: 0,
              padding: 14,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              color: '#d4d4d4',
              lineHeight: 1.55,
            }}
          >
            {preview.value.content}
          </pre>
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            border: '1px solid #3c3c3c',
            borderRadius: 6,
            display: 'grid',
            placeItems: 'center',
            padding: 20,
            background: '#1e1e1e',
            color: '#858585',
          }}
        >
          Choose AGENTS.md, README.md, WORK.md, or another supported text file
          from the navigation tree to inspect it here.
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
  const projectMemoryKey =
    shell.params.projectPath?.trim() || shell.params.projectId?.trim() || '';
  const initialProjectMemory = projectMemoryKey
    ? projectViewMemory.get(projectMemoryKey)
    : undefined;
  const [snapshot, setSnapshot] = React.useState<GlobalWorkSnapshot | null>(
    null,
  );
  const [selected, setSelected] = React.useState<string | null>(
    () => shell.params.workId?.trim() || null,
  );
  const [search, setSearch] = React.useState('');
  const [filter, setFilter] = React.useState<GlobalWorkFilter>('active');
  const [projectSection, setProjectSection] = React.useState<'files' | 'work'>(
    () =>
      initialProjectMemory?.section ??
      (shell.params.projectSection === 'work' ? 'work' : 'files'),
  );
  const [selectedProjectFile, setSelectedProjectFile] = React.useState<
    ProjectFileTreeEntry | undefined
  >(initialProjectMemory?.selectedFile);
  const [loadedProjectMemoryKey, setLoadedProjectMemoryKey] =
    React.useState(projectMemoryKey);
  const [projectMenuOpen, setProjectMenuOpen] = React.useState(false);
  const [removePlan, setRemovePlan] = React.useState<ProjectRemovePlan>();
  const [projectAdminBusy, setProjectAdminBusy] = React.useState('');
  const [projectAdminError, setProjectAdminError] = React.useState('');
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
    const remembered = projectMemoryKey
      ? projectViewMemory.get(projectMemoryKey)
      : undefined;
    setProjectSection(
      remembered?.section ??
        (shell.params.projectSection === 'work' ? 'work' : 'files'),
    );
    setSelectedProjectFile(remembered?.selectedFile);
    setLoadedProjectMemoryKey(projectMemoryKey);
    setProjectMenuOpen(false);
    setRemovePlan(undefined);
    setProjectAdminError('');
  }, [
    projectMemoryKey,
    shell.params.projectId,
    shell.params.projectPath,
    shell.params.projectSection,
  ]);
  React.useEffect(() => {
    if (!projectMemoryKey || loadedProjectMemoryKey !== projectMemoryKey)
      return;
    projectViewMemory.set(projectMemoryKey, {
      section: projectSection,
      selectedFile: selectedProjectFile,
    });
  }, [
    loadedProjectMemoryKey,
    projectMemoryKey,
    projectSection,
    selectedProjectFile,
  ]);

  React.useEffect(() => {
    if (
      projectSection === 'files' &&
      (shell.params.projectId?.trim() || shell.params.projectPath?.trim())
    ) {
      setStatus('Files ready · retained Work loads when selected');
      return undefined;
    }
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
  }, [ipc, projectSection, shell.params.projectId, shell.params.projectPath]);
  React.useEffect(() => {
    if (projectSection === 'files' && shell.params.projectPath?.trim()) {
      setProjectsCatalogReady(false);
      let active = true;
      const timer = window.setTimeout(() => {
        void projects
          .list()
          .then((catalog) => {
            if (active) setProjectsCatalog(catalog);
          })
          .catch(() => {
            // Files remain usable; catalog errors surface only when Work needs it.
          })
          .finally(() => {
            if (active) setProjectsCatalogReady(true);
          });
      }, 250);
      const unsubscribe = projects.subscribeRuns(setRuns);
      return () => {
        active = false;
        window.clearTimeout(timer);
        unsubscribe();
      };
    }
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
  }, [projectSection, projects, shell.params.projectPath]);

  const requestedProjectId = shell.params.projectId?.trim();
  const requestedProjectPath = shell.params.projectPath?.trim();
  const catalogProject =
    projectsCatalog?.projects.find(
      (project) => project.id === requestedProjectId,
    ) ??
    projectsCatalog?.projects.find(
      (project) => project.path === requestedProjectPath,
    );
  const requestedProject =
    catalogProject ??
    (requestedProjectPath
      ? {
          schema: 'kungfu.project/v1' as const,
          id: `project-path:${requestedProjectPath}`,
          name:
            requestedProjectPath.split(/[\\/]/u).filter(Boolean).at(-1) ??
            'Project',
          path: requestedProjectPath,
          available: true,
          selected: true,
          initialized: true,
          state: 'focused',
        }
      : undefined);
  const planProjectRemoval = () => {
    if (!requestedProject) return;
    setProjectMenuOpen(false);
    setProjectAdminBusy('Preparing safe removal…');
    setProjectAdminError('');
    void projects
      .list()
      .then((catalog) => {
        const project = catalog.projects.find(
          (candidate) => candidate.path === requestedProject.path,
        );
        if (!project) {
          throw new Error(
            'This Project is not present in the Projects catalog',
          );
        }
        return projects.planRemove(project.id);
      })
      .then(setRemovePlan)
      .catch((reason) =>
        setProjectAdminError(
          reason instanceof Error ? reason.message : String(reason),
        ),
      )
      .finally(() => setProjectAdminBusy(''));
  };
  const confirmProjectRemoval = () => {
    if (!removePlan) return;
    setProjectAdminBusy(`Removing ${removePlan.project.name} from Projects…`);
    setProjectAdminError('');
    void projects
      .remove(removePlan.project.id, removePlan.planRoot)
      .then(() => {
        setRemovePlan(undefined);
        setStatus('Removed from Projects · Project files and Work were kept');
      })
      .catch((reason) =>
        setProjectAdminError(
          reason instanceof Error ? reason.message : String(reason),
        ),
      )
      .finally(() => setProjectAdminBusy(''));
  };
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
      {removePlan ? (
        <dialog
          open
          aria-modal="true"
          aria-label="Confirm Project removal"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 60,
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
              Remove {removePlan.project.name} from Projects?
            </h3>
            <div style={{ ...mono, color: '#9cdcfe' }}>
              {removePlan.project.path}
            </div>
            <p>
              This only removes the machine-local Project locator. Project
              files, retained Work, and Kungfu evidence will not be deleted.
            </p>
            <p style={{ ...mono, color: '#dcdcaa' }}>
              Confirm once more to remove it from the Projects catalog.
            </p>
            {projectAdminError ? (
              <div style={{ ...mono, color: '#f48771', marginBottom: 10 }}>
                {projectAdminError}
              </div>
            ) : null}
            <div
              style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}
            >
              <button
                type="button"
                disabled={Boolean(projectAdminBusy)}
                onClick={() => setRemovePlan(undefined)}
                style={{ ...mono, padding: '7px 11px' }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={Boolean(projectAdminBusy)}
                onClick={confirmProjectRemoval}
                style={{
                  ...mono,
                  padding: '7px 11px',
                  border: '1px solid #f48771',
                  background: '#5a1d1d',
                  color: '#f1f1f1',
                }}
              >
                {projectAdminBusy || 'Remove from Projects'}
              </button>
            </div>
          </div>
        </dialog>
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
          projects={projects}
          section={projectSection}
          selectedFile={selectedProjectFile}
          workCount={projectRows.length}
          workLoading={workLoading}
          onSection={setProjectSection}
          onSelectFile={setSelectedProjectFile}
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
              {error || runError || projectAdminError ? (
                <div style={{ ...mono, color: '#dcdcaa', marginTop: 4 }}>
                  {error || runError || projectAdminError}
                </div>
              ) : null}
              {projectAdminBusy && !removePlan ? (
                <div style={{ ...mono, color: '#dcdcaa', marginTop: 4 }}>
                  ◌ {projectAdminBusy}
                </div>
              ) : null}
            </div>
            <div
              style={{
                alignSelf: 'center',
                display: 'flex',
                gap: 7,
                position: 'relative',
              }}
            >
              <button
                type="button"
                disabled={!requestedProject}
                onClick={() => setNewWorkOpen(true)}
                style={{
                  ...mono,
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
              <button
                type="button"
                aria-label="Project menu"
                aria-expanded={projectMenuOpen}
                disabled={!requestedProject || Boolean(projectAdminBusy)}
                onClick={() => setProjectMenuOpen((open) => !open)}
                style={{
                  ...mono,
                  border: '1px solid #4b4b4b',
                  borderRadius: 6,
                  background: '#2d2d30',
                  color: '#f1f1f1',
                  padding: '7px 10px',
                  cursor: requestedProject ? 'pointer' : 'default',
                }}
              >
                ⋯
              </button>
              {projectMenuOpen ? (
                <div
                  role="menu"
                  aria-label="Project actions"
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: 'calc(100% + 6px)',
                    zIndex: 20,
                    width: 250,
                    padding: 5,
                    border: '1px solid #4b4b4b',
                    borderRadius: 7,
                    background: '#252526',
                    boxShadow: '0 10px 30px rgba(0,0,0,.45)',
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={planProjectRemoval}
                    style={{
                      ...mono,
                      width: '100%',
                      padding: '8px 9px',
                      border: 'none',
                      borderRadius: 4,
                      background: 'transparent',
                      color: '#f0b7ad',
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                  >
                    Remove from Projects…
                  </button>
                </div>
              ) : null}
            </div>
          </section>
          {projectSection === 'files' ? (
            requestedProject ? (
              <ProjectFilesView
                project={requestedProject}
                projects={projects}
                selected={selectedProjectFile}
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
  return <ProjectWorkControlView shell={shell} projects={caps.projects} />;
}

export function ProjectWorkControlView({
  projects,
  shell,
}: {
  projects: Projects;
  shell: Shell;
}) {
  return <GlobalWorkView shell={shell} projects={projects} />;
}

export const View = WorkDashboardView;
