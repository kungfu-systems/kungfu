import type {
  AssignmentRuntime,
  GlobalWorkFilter,
  GlobalWorkRow,
  GlobalWorkSnapshot,
  ProjectFileTreeEntry,
  ProjectRemovePlan,
  ProjectSummary,
  ProjectWorkCapturePlan,
  ProjectWorkCaptureReceipt,
  ProjectWorkInventory,
  ProjectWorkRunPlan,
  ProjectWorkRunSnapshot,
  Projects,
  ProjectsCatalog,
  WorkClosePlan,
  WorkReviewPlan,
} from '@kungfu-tech/api/capability';
import {
  filterGlobalWork,
  parseGlobalWorkSnapshot,
  projectFileTreeLabel,
  toggleProjectFileTreeEntry,
} from '@kungfu-tech/api/capability';
import type { KfxCapabilities, Shell } from '@kungfu-tech/kfx';
import {
  ProjectWorkCloseConfirmation,
  ProjectWorkReviewConfirmation,
  ProjectWorkRunConfirmation,
  ProjectWorkRunSession,
  controlButtonStyle,
  controlMenuItemStyle,
  controlMenuStyle,
  headingStyle,
  mono,
  panelStyle,
} from '@kungfu-tech/kfx';
import React from 'react';

import {
  type GlobalWorkObserverEvent,
  type GlobalWorkObserverIpc,
  observeAssignmentRuntimeStatus,
  subscribeGlobalWorkObserver,
} from './global-work-observer';
import {
  ProjectWorkList,
  resolveSelectedProjectWorkRow,
} from './project-work-list';
export { resolveSelectedProjectWorkRow } from './project-work-list';
import {
  RESTORING_RETAINED_AGENT_RESULT,
  assignmentSelector,
  isProjectWorkReviewable,
  isProjectWorkSettled,
  preferredProjectReviewRun,
  resolveWorkProject,
  settleRetainedProjectRunBusy,
  shouldRestoreRetainedProjectRun,
} from './project-work-run';
// The GUI application surface is the versioned Runtime Client.  Domain-specific
// Profile reads remain in work-control-profile.ts only as an explicit read-only
// native client seam; no GUI transition can enter there.
export function openProfileApplication(runtime: AssignmentRuntime) {
  return runtime;
}

export { openKfd3ProfileApplication } from './work-control-profile';

type NodeHost = {
  require: NodeRequire;
  process: NodeJS.Process;
};

type ProjectViewMemory = {
  section: 'files' | 'work';
  selectedFile?: ProjectFileTreeEntry;
  agentProvider?: AgentProvider;
};

type AgentProvider = 'codex' | 'claude' | 'opencode';

const AGENT_PROVIDERS: AgentProvider[] = ['codex', 'claude', 'opencode'];
const LAST_AGENT_PROVIDER_KEY = 'kungfu.project-work.last-agent-provider';

function retainedAgentProvider(): AgentProvider {
  try {
    const value = window.localStorage.getItem(LAST_AGENT_PROVIDER_KEY);
    return AGENT_PROVIDERS.includes(value as AgentProvider)
      ? (value as AgentProvider)
      : 'codex';
  } catch {
    return 'codex';
  }
}

function agentProviderLabel(provider: AgentProvider): string {
  return provider === 'opencode'
    ? 'OpenCode'
    : provider[0].toUpperCase() + provider.slice(1);
}

const projectViewMemory = new Map<string, ProjectViewMemory>();

export function projectInventoryWorkRows(
  inventory: ProjectWorkInventory | undefined,
  project: ProjectSummary | undefined,
): GlobalWorkRow[] {
  if (!inventory || !project) return [];
  return inventory.works.map((work) => ({
    canonical_root: work.stateRoot || work.requestRoot,
    object_kind: 'assignment',
    subject: `kungfu:${work.assignmentId}`,
    display: {
      title: work.title,
      status: work.settled
        ? work.phase || 'completed'
        : work.phase || 'captured',
      next_actions: work.settled
        ? []
        : work.phase
          ? []
          : ['Choose an Agent to admit and run this Work'],
    },
    observations: [
      {
        workspace_id: project.id,
        availability: 'available',
      },
    ],
  }));
}

function mergeProjectWorkRows(
  globalRows: GlobalWorkRow[],
  inventoryRows: GlobalWorkRow[],
): GlobalWorkRow[] {
  const authoritativeAssignments = new Set(
    globalRows.map((row) => assignmentSelector(row.subject)).filter(Boolean),
  );
  return [
    ...globalRows,
    ...inventoryRows.filter(
      (row) => !authoritativeAssignments.has(assignmentSelector(row.subject)),
    ),
  ];
}

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
  border: `1px solid ${selected ? '#4fc1ff' : '#3c3c3c'}`,
  borderRadius: 6,
  background: selected ? '#04395e' : '#252526',
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
  works,
  selectedWorkRoot,
  workFilter,
  workSearch,
  workCount,
  workLoading,
  onSection,
  onSelectFile,
  onSelectWork,
  onWorkFilter,
  onWorkSearch,
}: {
  project: ProjectSummary | undefined;
  projects: Projects;
  section: 'files' | 'work';
  selectedFile: ProjectFileTreeEntry | undefined;
  works: GlobalWorkRow[];
  selectedWorkRoot?: string;
  workFilter: GlobalWorkFilter;
  workSearch: string;
  workCount: number;
  workLoading: boolean;
  onSection: (section: 'files' | 'work') => void;
  onSelectFile: (entry: ProjectFileTreeEntry) => void;
  onSelectWork: (row: GlobalWorkRow) => void;
  onWorkFilter: (filter: GlobalWorkFilter) => void;
  onWorkSearch: (value: string) => void;
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
        aria-current={section === 'work' ? 'page' : undefined}
        aria-expanded={section === 'work'}
        onClick={() => onSection('work')}
        style={{
          ...projectNavButtonStyle(section === 'work'),
          padding: '11px 10px',
        }}
      >
        <span>
          <strong style={{ display: 'block' }}>Work</strong>
          <span style={{ color: '#9aa7b2', fontSize: 10 }}>
            Create, run, review
          </span>
        </span>
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
      {section === 'work' ? (
        <div
          style={{
            flex: 1,
            minHeight: 100,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            overflow: 'hidden',
          }}
        >
          <TextInput value={workSearch} onChange={onWorkSearch} />
          <fieldset
            aria-label="Filter Project Work"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              minInlineSize: 0,
              margin: 0,
              padding: 0,
              border: 0,
            }}
          >
            {(['active', 'completed', 'all'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => onWorkFilter(value)}
                style={{
                  ...mono,
                  minWidth: 0,
                  padding: '4px 3px',
                  border: `1px solid ${
                    workFilter === value ? '#4fc1ff' : '#3c3c3c'
                  }`,
                  background: workFilter === value ? '#04395e' : '#252526',
                  color: workFilter === value ? '#f1f1f1' : '#cccccc',
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {value}
              </button>
            ))}
          </fieldset>
          <ProjectWorkList
            compact
            rows={works}
            currentRoot={selectedWorkRoot}
            onSelect={onSelectWork}
          />
        </div>
      ) : null}
      <button
        type="button"
        aria-current={section === 'files' ? 'page' : undefined}
        aria-expanded={section === 'files'}
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
  onCreated: (
    plan: ProjectWorkCapturePlan,
    receipt: ProjectWorkCaptureReceipt,
  ) => void;
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
      .then((receipt) => onCreated(plan, receipt))
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
      aria-label={`Create Work in ${project.name}`}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        boxSizing: 'border-box',
        width: 'auto',
        maxWidth: 'none',
        height: 'auto',
        maxHeight: 'none',
        margin: 0,
        border: 'none',
        background: 'rgba(8, 12, 18, 0.62)',
        backdropFilter: 'blur(1px)',
        color: '#e6edf3',
        colorScheme: 'dark',
        fontSize: 15,
        lineHeight: 1.5,
        display: 'grid',
        placeItems: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          width: 'min(680px, 90vw)',
          background: '#20262e',
          color: '#e6edf3',
          border: '1px solid #52606d',
          borderRadius: 10,
          padding: 22,
          boxShadow: '0 18px 48px rgba(0,0,0,.55)',
        }}
      >
        <h3 style={{ marginTop: 0, color: '#f4f7fa', fontSize: 20 }}>
          New Work · {project.name}
        </h3>
        <label style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
          <span style={{ ...mono, color: '#d7dde5', fontSize: 14 }}>
            What should the Agent do?
          </span>
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
              padding: 10,
              border: '1px solid #52606d',
              borderRadius: 6,
              background: '#111820',
              color: '#f4f7fa',
              fontSize: 15,
              lineHeight: 1.5,
            }}
          />
        </label>
        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ ...mono, color: '#d7dde5', fontSize: 14 }}>
            How will you know the Work is correct?
          </span>
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
              padding: 10,
              border: '1px solid #52606d',
              borderRadius: 6,
              background: '#111820',
              color: '#f4f7fa',
              fontSize: 15,
              lineHeight: 1.5,
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
          <button
            type="button"
            style={{ ...projectActionStyle, fontSize: 13 }}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            style={{ ...projectActionStyle, fontSize: 13 }}
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
                fontSize: 13,
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
  assignmentRuntime,
}: {
  shell: Shell;
  projects: Projects;
  assignmentRuntime: AssignmentRuntime;
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
  const [selectedAssignmentId, setSelectedAssignmentId] = React.useState<
    string | null
  >(null);
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
  const [agentProvider, setAgentProvider] = React.useState<AgentProvider>(
    () => initialProjectMemory?.agentProvider ?? retainedAgentProvider(),
  );
  const [agentMenuOpen, setAgentMenuOpen] = React.useState(false);
  const [status, setStatus] = React.useState('Connecting All Work…');
  const [error, setError] = React.useState('');
  const [assignmentRuntimeStatus, setAssignmentRuntimeStatus] = React.useState(
    'Work Runtime connecting…',
  );
  const [projectsCatalog, setProjectsCatalog] =
    React.useState<ProjectsCatalog>();
  const [projectsCatalogReady, setProjectsCatalogReady] = React.useState(false);
  const [projectInventory, setProjectInventory] =
    React.useState<ProjectWorkInventory>();
  const [projectInventoryError, setProjectInventoryError] = React.useState('');
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
  const [reviewPlan, setReviewPlan] = React.useState<{
    runId: string;
    plan: WorkReviewPlan;
  }>();
  const [closePlan, setClosePlan] = React.useState<{
    plan: WorkClosePlan;
    continueAfter: boolean;
  }>();
  const [runBusy, setRunBusy] = React.useState('');
  const [runError, setRunError] = React.useState('');
  const [retainedRestoreState, setRetainedRestoreState] = React.useState<{
    key: string;
    status: 'loading' | 'settled' | 'failed';
  }>();
  const lastNotification = React.useRef({ key: '', at: 0 });
  const sessionPanelRef = React.useRef<HTMLDivElement>(null);
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

  React.useEffect(
    () =>
      observeAssignmentRuntimeStatus(
        assignmentRuntime,
        setAssignmentRuntimeStatus,
      ),
    [assignmentRuntime],
  );
  React.useEffect(() => {
    const requestedWorkId = shell.params.workId?.trim();
    if (!requestedWorkId) return;
    setSelected(requestedWorkId);
    setSelectedAssignmentId(null);
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
    setAgentProvider(remembered?.agentProvider ?? retainedAgentProvider());
    setLoadedProjectMemoryKey(projectMemoryKey);
    setAgentMenuOpen(false);
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
      agentProvider,
    });
  }, [
    loadedProjectMemoryKey,
    projectMemoryKey,
    projectSection,
    selectedProjectFile,
    agentProvider,
  ]);
  React.useEffect(() => {
    try {
      window.localStorage.setItem(LAST_AGENT_PROVIDER_KEY, agentProvider);
    } catch {
      // The in-memory Project view still retains the selection for this process.
    }
  }, [agentProvider]);

  React.useEffect(() => {
    if (
      projectSection === 'files' &&
      (shell.params.projectId?.trim() || shell.params.projectPath?.trim())
    ) {
      setStatus('Files ready · retained Work restores in the background');
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
  const projectInventoryRequest = React.useRef<{
    path: string;
    promise: Promise<ProjectWorkInventory | undefined>;
  }>();
  const refreshProjectInventory = React.useCallback(() => {
    if (!requestedProject?.path) return Promise.resolve(undefined);
    if (projectInventoryRequest.current?.path === requestedProject.path) {
      return projectInventoryRequest.current.promise;
    }
    const request = projects
      .works(requestedProject.path)
      .then((inventory) => {
        setProjectInventory(inventory);
        setProjectInventoryError('');
        return inventory;
      })
      .catch((reason) => {
        setProjectInventoryError(
          reason instanceof Error ? reason.message : String(reason),
        );
        return undefined;
      });
    projectInventoryRequest.current = {
      path: requestedProject.path,
      promise: request,
    };
    void request.then(() => {
      if (projectInventoryRequest.current?.promise === request) {
        projectInventoryRequest.current = undefined;
      }
    });
    return request;
  }, [projects, requestedProject?.path]);
  React.useEffect(() => {
    if (!requestedProject?.path) return undefined;
    if (projectSection === 'work') {
      void refreshProjectInventory();
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void refreshProjectInventory();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [projectSection, refreshProjectInventory, requestedProject?.path]);
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
  const inventoryRows = projectInventoryWorkRows(
    projectInventory?.projectPath === requestedProject?.path
      ? projectInventory
      : undefined,
    requestedProject,
  );
  const projectRows = requestedProject
    ? mergeProjectWorkRows(
        allAssignmentRows.filter(
          (row) =>
            resolveWorkProject(
              row.observations,
              projectsCatalog?.projects ?? [],
            )?.id === requestedProject.id,
        ),
        inventoryRows,
      )
    : [];
  const visibleInventoryRows = inventoryRows.filter((row) => {
    const completed = Boolean(
      projectInventory?.works.find(
        (work) => work.assignmentId === assignmentSelector(row.subject),
      )?.settled,
    );
    return (
      filter === 'all' || (filter === 'completed' ? completed : !completed)
    );
  });
  const rows = requestedProject
    ? mergeProjectWorkRows(
        filteredAssignmentRows.filter(
          (row) =>
            resolveWorkProject(
              row.observations,
              projectsCatalog?.projects ?? [],
            )?.id === requestedProject.id,
        ),
        visibleInventoryRows,
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
  const current = resolveSelectedProjectWorkRow(
    rows,
    visible,
    selected,
    selectedAssignmentId,
  );
  const currentProject = current
    ? resolveWorkProject(current.observations, projectsCatalog?.projects ?? [])
    : undefined;
  const workSelector =
    current?.object_kind === 'assignment'
      ? assignmentSelector(current.subject)
      : undefined;
  const currentInventoryWork = projectInventory?.works.find(
    (work) => work.assignmentId === workSelector,
  );
  const currentRetainedRun = runs.find(
    (run) =>
      run.workspace === currentProject?.path &&
      run.work === workSelector &&
      Boolean(run.receipt),
  );
  const currentReviewRun = preferredProjectReviewRun(
    runs,
    currentRetainedRun?.id,
  );
  const currentReviewRunning = Boolean(currentReviewRun?.running);
  const currentReviewPassed =
    currentReviewRun?.reviewReceipt?.status === 'review-passed';
  const currentWorkSettled = isProjectWorkSettled(currentInventoryWork);
  const currentReviewableRun =
    currentRetainedRun?.receipt?.status === 'agent-finished' &&
    isProjectWorkReviewable(currentInventoryWork)
      ? currentRetainedRun
      : undefined;
  const retainedRestoreKey =
    currentProject?.path &&
    currentInventoryWork &&
    shouldRestoreRetainedProjectRun(currentInventoryWork, current)
      ? [
          currentProject.path,
          currentInventoryWork.initiativeId,
          currentInventoryWork.assignmentId,
        ].join('|')
      : undefined;
  const retainedRestoreStatus =
    retainedRestoreKey && retainedRestoreState?.key === retainedRestoreKey
      ? retainedRestoreState.status
      : 'loading';
  const retainedRunRestorePending = Boolean(
    retainedRestoreKey &&
      !currentRetainedRun &&
      retainedRestoreStatus === 'loading',
  );
  const retainedRunRestoreFailed = Boolean(
    retainedRestoreKey &&
      !currentRetainedRun &&
      retainedRestoreStatus === 'failed',
  );
  const retainedRunId = currentRetainedRun?.id;
  const retainedProjectPath = currentProject?.path;
  const retainedInitiativeId = currentInventoryWork?.initiativeId;
  const retainedAssignmentId = currentInventoryWork?.assignmentId;
  const visibleRun = runs.find((run) => run.id === visibleRunId) ?? null;
  const openVisibleRun = (runId: string) => {
    setVisibleRunId(runId);
    window.requestAnimationFrame(() => {
      sessionPanelRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
      sessionPanelRef.current?.focus({ preventScroll: true });
    });
  };
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
  const prepareReview = (run: ProjectWorkRunSnapshot) => {
    setRunBusy('Preparing a fresh independent review…');
    setRunError('');
    void refreshProjectInventory()
      .then((inventory) => {
        const work = inventory?.works.find(
          (candidate) => candidate.assignmentId === run.work,
        );
        if (isProjectWorkSettled(work)) {
          setStatus('Work is complete · retained evidence is available');
          return undefined;
        }
        if (!isProjectWorkReviewable(work)) {
          throw new Error(
            work?.phase
              ? `Review changes is not available while Work is ${work.phase}`
              : 'Review changes is waiting for the current native Work phase',
          );
        }
        return projects.planReview(run.id);
      })
      .then((plan) => {
        if (plan) setReviewPlan({ runId: run.id, plan });
      })
      .catch((reason) =>
        setRunError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setRunBusy(''));
  };
  const prepareClose = (continueAfter: boolean) => {
    if (!currentProject || !currentInventoryWork) return;
    setRunBusy('Preparing exact Work settlement…');
    setRunError('');
    void projects
      .planClose(currentProject.path, currentInventoryWork)
      .then((plan) => setClosePlan({ plan, continueAfter }))
      .catch((reason) =>
        setRunError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setRunBusy(''));
  };
  const restoredWorkKeys = React.useRef(new Set<string>());
  React.useEffect(() => {
    if (
      !retainedRestoreKey ||
      !retainedProjectPath ||
      !retainedInitiativeId ||
      !retainedAssignmentId
    )
      return;
    if (retainedRunId) {
      return;
    }
    const key = retainedRestoreKey;
    if (restoredWorkKeys.current.has(key)) return;
    restoredWorkKeys.current.add(key);
    let active = true;
    setRetainedRestoreState({ key, status: 'loading' });
    setRunBusy(RESTORING_RETAINED_AGENT_RESULT);
    setRunError('');
    void projects
      .resumeRun(retainedProjectPath, {
        initiativeId: retainedInitiativeId,
        assignmentId: retainedAssignmentId,
      })
      .then(() => {
        if (!active) return;
        setRetainedRestoreState({ key, status: 'settled' });
      })
      .catch((reason) => {
        if (active) {
          restoredWorkKeys.current.delete(key);
          setRetainedRestoreState({ key, status: 'failed' });
          setRunError(
            reason instanceof Error ? reason.message : String(reason),
          );
        }
      })
      .finally(() => {
        setRunBusy(settleRetainedProjectRunBusy);
      });
    return () => {
      active = false;
    };
  }, [
    projects,
    retainedAssignmentId,
    retainedInitiativeId,
    retainedProjectPath,
    retainedRestoreKey,
    retainedRunId,
  ]);
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
  const confirmReview = () => {
    if (!reviewPlan) return;
    const pending = projects.review(
      reviewPlan.runId,
      reviewPlan.plan,
      () => undefined,
    );
    setReviewPlan(undefined);
    setVisibleRunId(
      preferredProjectReviewRun(projects.runs(), reviewPlan.runId)?.id ??
        reviewPlan.runId,
    );
    setRunBusy('Starting independent review…');
    void pending
      .then(() => {
        void refreshProjectInventory();
      })
      .catch((reason) =>
        setRunError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setRunBusy(''));
  };
  const confirmClose = () => {
    if (!closePlan) return;
    const requestedContinuation = closePlan.continueAfter;
    const pending = projects.close(closePlan.plan);
    setClosePlan(undefined);
    setRunBusy('Settling Work and retaining portable evidence…');
    setRunError('');
    void pending
      .then((receipt) => {
        if (!receipt.ok || receipt.status !== 'completed') {
          throw new Error(
            receipt.message || `Work settlement ended as ${receipt.status}`,
          );
        }
        setVisibleRunId(null);
        return refreshProjectInventory().then(() => {
          if (requestedContinuation) setNewWorkOpen(true);
        });
      })
      .catch((reason) =>
        setRunError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setRunBusy(''));
  };
  const orderedProviders = [
    agentProvider,
    ...AGENT_PROVIDERS.filter((provider) => provider !== agentProvider),
  ];

  const workLoading = requestedProject
    ? !projectInventory || !projectsCatalogReady
    : !snapshot || !projectsCatalogReady;
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
  const selectWork = (row: GlobalWorkRow) => {
    setSelected(row.canonical_root);
    setSelectedAssignmentId(assignmentSelector(row.subject));
    if (requestedProject?.path) void refreshProjectInventory();
  };
  const workDetail = (
    <section style={{ ...panelStyle, flex: 1, minHeight: 0, overflow: 'auto' }}>
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
                {currentWorkSettled
                  ? 'Work completed'
                  : currentReviewRunning
                    ? 'Independent review running'
                    : currentReviewPassed
                      ? 'Independent review passed'
                      : retainedRunRestorePending
                        ? 'Restoring Agent result'
                        : currentReviewableRun
                          ? 'Review Agent result'
                          : 'Run with an Agent'}
              </h2>
              <div style={{ ...mono, color: '#858585', marginBottom: 8 }}>
                {currentWorkSettled
                  ? `Project · ${currentProject.name}. The approved result and portable Work evidence are retained.`
                  : currentReviewRunning
                    ? `Project · ${currentProject.name}. A fresh read-only reviewer is checking the retained Agent result.`
                    : currentReviewPassed
                      ? `Project · ${currentProject.name}. The retained Agent result passed independent review.`
                      : retainedRunRestorePending
                        ? `Project · ${currentProject.name}. Recovering the retained Agent result and its next action.`
                        : currentReviewableRun
                          ? `Project · ${currentProject.name}. The retained Agent result requires an independent review.`
                          : `Project · ${currentProject.name}. Preview the exact effects before the Agent starts.`}
              </div>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                {currentWorkSettled ? (
                  <>
                    <span
                      style={{
                        ...mono,
                        padding: '6px 10px',
                        border: '1px solid #4ec9b0',
                        borderRadius: 5,
                        background: '#184b32',
                        color: '#d8f3dc',
                        fontWeight: 700,
                      }}
                    >
                      COMPLETED · EVIDENCE RETAINED
                    </span>
                    <button
                      type="button"
                      onClick={() => setNewWorkOpen(true)}
                      style={{
                        ...mono,
                        padding: '6px 10px',
                        border: '1px solid #4fc1ff',
                        borderRadius: 5,
                        background: '#0e639c',
                        color: '#f1f1f1',
                        cursor: 'pointer',
                        fontWeight: 700,
                      }}
                    >
                      Create next Work
                    </button>
                  </>
                ) : retainedRunRestorePending || retainedRunRestoreFailed ? (
                  <button
                    type="button"
                    disabled
                    style={{
                      ...mono,
                      padding: '6px 10px',
                      border: '1px solid #5a5a5a',
                      borderRadius: 5,
                      background: '#3a3a3a',
                      color: '#c8c8c8',
                    }}
                  >
                    {retainedRunRestorePending
                      ? 'Restoring Agent result…'
                      : 'Agent result unavailable'}
                  </button>
                ) : currentReviewRunning || currentReviewPassed ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        if (currentReviewRun)
                          openVisibleRun(currentReviewRun.id);
                      }}
                      style={{
                        ...mono,
                        padding: '6px 10px',
                        border: '1px solid #4fc1ff',
                        borderRadius: 5,
                        background: '#0e639c',
                        color: '#f1f1f1',
                        cursor: 'pointer',
                        fontWeight: 700,
                      }}
                    >
                      Open Review
                    </button>
                    {currentReviewPassed ? (
                      <>
                        <button
                          type="button"
                          disabled={Boolean(runBusy || closePlan)}
                          onClick={() => prepareClose(false)}
                          style={{
                            ...mono,
                            padding: '6px 10px',
                            border: '1px solid #4ec9b0',
                            borderRadius: 5,
                            background: '#184b32',
                            color: '#f1f1f1',
                            cursor: runBusy || closePlan ? 'wait' : 'pointer',
                            fontWeight: 700,
                          }}
                        >
                          Settle Work…
                        </button>
                        <button
                          type="button"
                          disabled={Boolean(runBusy || closePlan)}
                          onClick={() => prepareClose(true)}
                          style={{
                            ...mono,
                            padding: '6px 10px',
                            border: '1px solid #d7ba7d',
                            borderRadius: 5,
                            background: '#3b321f',
                            color: '#f1f1f1',
                            cursor: runBusy || closePlan ? 'wait' : 'pointer',
                          }}
                        >
                          Continue with new Work…
                        </button>
                      </>
                    ) : null}
                  </>
                ) : currentReviewableRun ? (
                  <button
                    type="button"
                    disabled={Boolean(runBusy || reviewPlan)}
                    onClick={() => prepareReview(currentReviewableRun)}
                    style={{
                      ...mono,
                      padding: '6px 10px',
                      border: '1px solid #4fc1ff',
                      borderRadius: 5,
                      background: '#0e639c',
                      color: '#f1f1f1',
                      cursor: runBusy || reviewPlan ? 'wait' : 'pointer',
                      fontWeight: 700,
                    }}
                  >
                    Review changes
                  </button>
                ) : (
                  <div
                    style={{
                      display: 'inline-flex',
                      position: 'relative',
                      alignItems: 'stretch',
                    }}
                  >
                    <button
                      type="button"
                      disabled={Boolean(runBusy)}
                      onClick={() => prepareRun(agentProvider)}
                      style={{
                        ...controlButtonStyle({
                          tone: 'primary',
                          disabled: Boolean(runBusy),
                        }),
                        borderRight: 'none',
                        borderRadius: '5px 0 0 5px',
                        cursor: runBusy ? 'wait' : 'pointer',
                      }}
                    >
                      Run Agent · {agentProviderLabel(agentProvider)}
                    </button>
                    <button
                      type="button"
                      aria-label="Choose Agent"
                      aria-expanded={agentMenuOpen}
                      disabled={Boolean(runBusy)}
                      onClick={() => setAgentMenuOpen((open) => !open)}
                      style={{
                        ...controlButtonStyle({
                          tone: 'primary',
                          disabled: Boolean(runBusy),
                        }),
                        width: 32,
                        padding: 0,
                        borderRadius: '0 5px 5px 0',
                        background: '#0b5686',
                        cursor: runBusy ? 'wait' : 'pointer',
                      }}
                    >
                      ▾
                    </button>
                    {agentMenuOpen ? (
                      <div
                        role="menu"
                        aria-label="Agent choices"
                        style={{
                          ...controlMenuStyle,
                          top: 'calc(100% + 4px)',
                          left: 0,
                          minWidth: '100%',
                        }}
                      >
                        {orderedProviders.map((provider) => (
                          <button
                            key={provider}
                            type="button"
                            role="menuitemradio"
                            aria-checked={provider === agentProvider}
                            onClick={() => {
                              setAgentProvider(provider);
                              setAgentMenuOpen(false);
                            }}
                            style={{
                              ...controlMenuItemStyle(
                                provider === agentProvider,
                              ),
                            }}
                          >
                            {provider === agentProvider ? '✓ ' : ''}
                            {agentProviderLabel(provider)}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )}
                {currentReviewRun &&
                !currentReviewRunning &&
                !currentReviewPassed ? (
                  <button
                    type="button"
                    onClick={() => openVisibleRun(currentReviewRun.id)}
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
                    Open Review
                  </button>
                ) : null}
                {currentRetainedRun ? (
                  <button
                    type="button"
                    onClick={() => openVisibleRun(currentRetainedRun.id)}
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
      <ProjectWorkList
        rows={visible}
        currentRoot={current?.canonical_root}
        onSelect={selectWork}
      />
      {workDetail}
    </div>
  );
  const sessionPanel = visibleRun ? (
    <div ref={sessionPanelRef} tabIndex={-1} style={{ marginTop: 8 }}>
      <ProjectWorkRunSession
        run={visibleRun}
        title={
          rows.find((row) => row.subject.endsWith(visibleRun.work ?? ''))
            ?.display.title
        }
        onClose={() => setVisibleRunId(null)}
        onReview={
          visibleRun.receipt?.status === 'agent-finished' &&
          isProjectWorkReviewable(
            projectInventory?.works.find(
              (work) => work.assignmentId === visibleRun.work,
            ),
          )
            ? () => prepareReview(visibleRun)
            : undefined
        }
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
      {reviewPlan ? (
        <ProjectWorkReviewConfirmation
          plan={reviewPlan.plan}
          busy={Boolean(runBusy)}
          onCancel={() => setReviewPlan(undefined)}
          onConfirm={confirmReview}
        />
      ) : null}
      {closePlan ? (
        <ProjectWorkCloseConfirmation
          plan={closePlan.plan}
          continueAfter={closePlan.continueAfter}
          busy={Boolean(runBusy)}
          onCancel={() => setClosePlan(undefined)}
          onConfirm={confirmClose}
        />
      ) : null}
      {newWorkOpen && requestedProject ? (
        <NewProjectWorkDialog
          project={requestedProject}
          projects={projects}
          onClose={() => setNewWorkOpen(false)}
          onCreated={(plan, receipt) => {
            setNewWorkOpen(false);
            setProjectSection('work');
            void refreshProjectInventory().then(() => {
              setSelected(receipt.requestRoot);
              setSelectedAssignmentId(plan.assignmentId);
            });
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
          works={visible}
          selectedWorkRoot={current?.canonical_root}
          workFilter={filter}
          workSearch={search}
          workCount={projectRows.length}
          workLoading={workLoading}
          onSection={setProjectSection}
          onSelectFile={setSelectedProjectFile}
          onSelectWork={selectWork}
          onWorkFilter={setFilter}
          onWorkSearch={setSearch}
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
              {projectInventoryError ? (
                <div style={{ ...mono, color: '#dcdcaa', marginTop: 6 }}>
                  Retained Project Work could not refresh:{' '}
                  {projectInventoryError}
                </div>
              ) : null}
              {workDetail}
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
        <div style={{ ...mono, color: '#858585' }}>
          {assignmentRuntimeStatus}
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
  if (!caps.assignmentRuntime) {
    return (
      <section style={panelStyle}>
        <div style={{ ...mono, color: '#f48771' }}>
          Work Runtime capability unavailable
        </div>
      </section>
    );
  }
  return (
    <ProjectWorkControlView
      shell={shell}
      projects={caps.projects}
      assignmentRuntime={caps.assignmentRuntime}
    />
  );
}

export function ProjectWorkControlView({
  projects,
  shell,
  assignmentRuntime,
}: {
  projects: Projects;
  shell: Shell;
  assignmentRuntime: AssignmentRuntime;
}) {
  return (
    <GlobalWorkView
      shell={shell}
      projects={projects}
      assignmentRuntime={assignmentRuntime}
    />
  );
}

export const View = WorkDashboardView;
