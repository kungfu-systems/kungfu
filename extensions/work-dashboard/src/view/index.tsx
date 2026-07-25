import type { Profile } from '@kungfu-tech/api/capability';
import type { KfxCapabilities, Shell } from '@kungfu-tech/kfx';
import { headingStyle, mono, panelStyle } from '@kungfu-tech/kfx';
import React from 'react';

import {
  type GlobalWorkObserverEvent,
  type GlobalWorkObserverIpc,
  subscribeGlobalWorkObserver,
} from './global-work-observer';
import { openMissionControlProfile } from './mission-control-profile';

// Preserve the qualified Profile application service without restoring its
// retired legacy presentation. The visible Work view is intentionally
// read-only.
export function openProfileApplication(profile: Profile, defaultRepoRoot = '') {
  const application = openMissionControlProfile(profile, defaultRepoRoot);
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
    assessMissionAsync: (
      ...args: Parameters<typeof application.assessMissionAsync>
    ) => application.assessMissionAsync(...args),
    reviewCompletion: (
      ...args: Parameters<typeof application.reviewCompletion>
    ) => application.reviewCompletion(...args),
    decideContinuation: (
      ...args: Parameters<typeof application.decideContinuation>
    ) => application.decideContinuation(...args),
    importRepo: (...args: Parameters<typeof application.importRepo>) =>
      application.importRepo(...args),
    cutoverAuthority: (
      ...args: Parameters<typeof application.cutoverAuthority>
    ) => application.cutoverAuthority(...args),
    rollbackAuthority: (
      ...args: Parameters<typeof application.rollbackAuthority>
    ) => application.rollbackAuthority(...args),
    exportMission: (...args: Parameters<typeof application.exportMission>) =>
      application.exportMission(...args),
    importMission: (...args: Parameters<typeof application.importMission>) =>
      application.importMission(...args),
    intentPlan: (...args: Parameters<typeof profile.intentPlan>) =>
      profile.intentPlan(...args),
  };
}

type GlobalWorkRow = {
  canonical_root: string;
  object_kind: 'initiative' | 'assignment';
  subject: string;
  display: {
    title?: string;
    status?: string;
    portfolio_state?: string;
    next_actions?: string[];
  };
  observations: Array<{ workspace_id?: string; availability?: string }>;
  conflict?: boolean;
};

type GlobalWorkSnapshot = {
  schema: 'kungfu.gui.global-work-snapshot/v1';
  observed_at?: string;
  aggregate?: {
    state?: string;
    component_count?: number;
    available_component_count?: number;
    unknown_component_count?: number;
  };
  verification?: { ok?: boolean };
  global_work?: {
    visible_work?: GlobalWorkRow[];
    visible_work_count?: number;
    canonical_work_count?: number;
    conflict_count?: number;
    label_collision_count?: number;
  };
};

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
      placeholder="filter Work or workspace"
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

function GlobalWorkView({
  shell,
}: {
  shell: Shell;
}) {
  const host = window as unknown as NodeHost;
  const [snapshot, setSnapshot] = React.useState<GlobalWorkSnapshot | null>(
    null,
  );
  const [selected, setSelected] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState('connecting live global Work…');
  const [error, setError] = React.useState('');
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
    let dispose: (() => Promise<void>) | undefined;
    let stopped = false;
    const receive = (event: GlobalWorkObserverEvent) => {
      if (stopped) return;
      if (event.kind === 'error') {
        setError(event.error);
        setStatus('cached view · live recovery pending');
        return;
      }
      const next = event.snapshot as GlobalWorkSnapshot;
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
            title: 'Work updated',
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

  const rows = snapshot?.global_work?.visible_work ?? [];
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <section style={{ ...panelStyle, marginBottom: 8 }}>
        <h2 style={headingStyle}>Work · Live global view</h2>
        <div style={{ ...mono, color: '#4ec9b0' }}>{status}</div>
        <div style={{ ...mono, color: '#858585' }}>
          Home + {Math.max(0, (snapshot?.aggregate?.component_count ?? 1) - 1)}{' '}
          active local project workspace
          {(snapshot?.aggregate?.component_count ?? 1) === 2 ? '' : 's'} ·{' '}
          {snapshot?.global_work?.visible_work_count ?? 0} current Work
        </div>
        {error ? (
          <div style={{ ...mono, color: '#dcdcaa' }}>{error}</div>
        ) : null}
      </section>
      <TextInput value={search} onChange={setSearch} />
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
        </section>
        <section style={{ ...panelStyle, flex: 1, overflow: 'auto' }}>
          {current ? (
            <>
              <h2 style={headingStyle}>
                {current.display.title || current.subject}
              </h2>
              <div style={{ ...mono, color: '#9cdcfe' }}>
                {current.object_kind} · {current.subject}
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
              <h2 style={{ ...headingStyle, marginTop: 14 }}>Owning views</h2>
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
              no current Work across active local workspaces
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function WorkDashboardView({
  shell,
}: {
  caps: KfxCapabilities;
  shell: Shell;
}) {
  return <GlobalWorkView shell={shell} />;
}

export const View = WorkDashboardView;
