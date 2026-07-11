// Work dashboard — the first screen: real-world work items and their state,
// not a trace list. Left pane lists items across the five lifecycle states;
// the detail pane shows one item's summary, next action, facts (checkpoints,
// decisions, validations, artifacts, linked runs) and lifecycle history.
// Linked runs point at the Rewind inspector, which stays the run-level
// forensic detail view.
import type {
  Atlas,
  AtlasGoal,
  AtlasImportInfo,
  AtlasMission,
  AtlasMissionControlReport,
  WorkItem,
  WorkspaceActionPreview,
  WorkspaceActionReceipt,
  WorkspaceActionVerification,
  WorkspaceAdvice,
  WorkspaceAuthorization,
  WorkspaceGuidance,
  WorkspaceGuidanceInspection,
  WorkspaceGuidanceIntent,
} from '@kungfu-tech/api/capability';
import { WORK_STATUS_NAMES } from '@kungfu-tech/api/capability';
import type { KfxCapabilities, Shell } from '@kungfu-tech/kfx';
import { headingStyle, mono, panelStyle } from '@kungfu-tech/kfx';
import React from 'react';

const STATUS_ORDER = ['active', 'blocked', 'waiting', 'ready', 'done'] as const;
const ATLAS_GOAL_STATUSES = [
  'active',
  'paused',
  'waiting',
  'blocked',
  'stage-ready',
  'ready',
  'completed',
] as const;

const STATUS_COLORS: Record<string, string> = {
  active: '#4ec9b0',
  blocked: '#f48771',
  waiting: '#dcdcaa',
  ready: '#9cdcfe',
  done: '#6a6a6a',
};

function statusName(item: WorkItem): string {
  return item.status !== undefined ? WORK_STATUS_NAMES[item.status] : 'unknown';
}

function StatusBadge({ name }: { name: string }) {
  return (
    <span style={{ ...mono, color: STATUS_COLORS[name] ?? '#cccccc' }}>
      [{name}]
    </span>
  );
}

function SmallButton({
  active = false,
  children,
  onClick,
}: {
  active?: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...mono,
        padding: '3px 8px',
        border: active ? '1px solid #2d8fcc' : '1px solid #3c3c3c',
        borderRadius: 4,
        cursor: 'pointer',
        background: active ? '#04395e' : 'transparent',
        color: active ? '#9cdcfe' : '#cccccc',
      }}
    >
      {children}
    </button>
  );
}

function TextInput({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      value={value}
      placeholder={placeholder}
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

type FactRow = { key: string; fields: Record<string, string | undefined> };

function FactRows({ label, rows }: { label: string; rows: FactRow[] }) {
  if (!rows.length) return null;
  return (
    <div style={{ marginBottom: 8 }}>
      <h2 style={headingStyle}>
        {label} · {rows.length}
      </h2>
      {rows.map((row) => (
        <div key={row.key} style={{ ...mono, color: '#ce9178' }}>
          {Object.entries(row.fields)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `${key}: ${value}`)
            .join(' · ')}
        </div>
      ))}
    </div>
  );
}

function AtlasGoalDetail({ goal }: { goal: AtlasGoal | null }) {
  if (!goal) {
    return (
      <section style={{ ...panelStyle, flex: 1 }}>
        <div style={{ ...mono, color: '#6a6a6a' }}>
          select an imported Atlas goal
        </div>
      </section>
    );
  }
  const rows: [string, string | boolean | undefined][] = [
    ['goal_id', goal.goal_id],
    ['status', goal.status],
    ['mission_id', goal.mission_id],
    ['lens', goal.lens],
    ['owner_agent', goal.owner_agent],
    ['source_branch', goal.source_branch],
    ['worktree_path', goal.worktree_path],
    ['external_repo_path', goal.external_repo_path],
    ['external_branch', goal.external_branch],
    ['external_head', goal.external_head],
    ['external_ready_ref', goal.external_ready_ref],
    ['latest_marker', goal.latest_marker],
    ['archived', goal.archived],
  ];
  return (
    <section style={{ ...panelStyle, flex: 1, minWidth: 0 }}>
      <h2 style={headingStyle}>{goal.goal_id}</h2>
      <div style={{ ...mono, color: '#cccccc', marginBottom: 6 }}>
        [{goal.status ?? 'unknown'}] {goal.title ?? ''}
      </div>
      {goal.summary && (
        <div style={{ ...mono, color: '#858585', marginBottom: 8 }}>
          {goal.summary}
        </div>
      )}
      {goal.next_action && (
        <div style={{ ...mono, color: '#dcdcaa', marginBottom: 8 }}>
          next: {goal.next_action}
        </div>
      )}
      <h2 style={headingStyle}>Projection fields</h2>
      {rows
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => (
          <div
            key={key}
            style={{
              ...mono,
              color: '#9cdcfe',
              overflowWrap: 'anywhere',
              marginBottom: 2,
            }}
          >
            {key}: {String(value)}
          </div>
        ))}
    </section>
  );
}

function MissionTrustPanel({
  report,
  error,
  title = 'Mission TrustReport',
}: {
  report: AtlasMissionControlReport | null;
  error: string;
  title?: string;
}) {
  if (error) {
    return (
      <section style={{ ...panelStyle }}>
        <h2 style={headingStyle}>{title}</h2>
        <div style={{ ...mono, color: '#f48771' }}>{error}</div>
      </section>
    );
  }
  if (!report) {
    return (
      <section style={{ ...panelStyle }}>
        <h2 style={headingStyle}>{title}</h2>
        <div style={{ ...mono, color: '#6a6a6a' }}>
          select a Mission to run its purpose-bound progress assessment
        </div>
      </section>
    );
  }
  const fitnessColor =
    report.fitness === 'fit'
      ? '#4ec9b0'
      : report.fitness === 'warning'
        ? '#dcdcaa'
        : '#f48771';
  const profile = report.profile;
  const cost = profile.cost;
  return (
    <section style={{ ...panelStyle }}>
      <h2 style={headingStyle}>Cost / State / Proof</h2>
      <div style={{ ...mono, color: '#9cdcfe', marginBottom: 4 }}>
        cost: {cost.status} · state: {profile.state.value} · proof:{' '}
        {profile.proof.canonical_state ? 'canonical' : 'degraded'}
      </div>
      <div style={{ ...mono, color: '#cccccc', marginBottom: 6 }}>
        tokens: {cost.tokens.input_tokens} in / {cost.tokens.output_tokens} out
        {' · '}
        usd: {cost.cost_usd_known ? cost.cost_usd : 'unknown'}
        {' · '}
        attribution: {cost.attribution.worst}
        {cost.attribution.ambiguous ? ' (ambiguous)' : ''}
      </div>
      <h2 style={headingStyle}>{title}</h2>
      <div style={{ ...mono, color: fitnessColor, marginBottom: 6 }}>
        {report.fitness} · {report.assessment.state} ·{' '}
        {report.state.canonical_state ? 'canonical cut' : 'degraded cut'}
      </div>
      {report.findings.map((finding) => (
        <div key={finding} style={{ ...mono, color: '#cccccc' }}>
          finding: {finding}
        </div>
      ))}
      <details style={{ marginTop: 8 }}>
        <summary style={{ ...mono, color: '#9cdcfe', cursor: 'pointer' }}>
          proof and residual risk
        </summary>
        <div style={{ ...mono, color: '#858585', overflowWrap: 'anywhere' }}>
          assessment: {report.assessment_key}
        </div>
        <div style={{ ...mono, color: '#858585', overflowWrap: 'anywhere' }}>
          report: {report.report_hash ?? '-'}
        </div>
        <div style={{ ...mono, color: '#858585', overflowWrap: 'anywhere' }}>
          definition: {report.query_definition_root}
        </div>
        <div style={{ ...mono, color: '#858585', overflowWrap: 'anywhere' }}>
          proof: {report.query_proof_root}
        </div>
        {cost.proof_episodes.map((episode) => (
          <div
            key={episode.run_id}
            style={{ ...mono, color: '#858585', overflowWrap: 'anywhere' }}
          >
            cost episode: {episode.run_id} · {episode.episode_root}
          </div>
        ))}
        {cost.missing.no_linked_cost_fact && (
          <div style={{ ...mono, color: '#dcdcaa' }}>
            missing: no CostSnapshot is linked to an admitted Go
          </div>
        )}
        {cost.missing.unsealed_runs.map((runId) => (
          <div key={runId} style={{ ...mono, color: '#dcdcaa' }}>
            missing: unsealed cost run {runId}
          </div>
        ))}
        {report.known_limits.map((risk) => (
          <div key={risk} style={{ ...mono, color: '#dcdcaa' }}>
            residual risk: {risk}
          </div>
        ))}
      </details>
    </section>
  );
}

function AtlasUnavailableView() {
  return (
    <section style={{ ...panelStyle, height: '100%' }}>
      <div style={{ ...mono, color: '#c46b6b' }}>
        atlas capability is not available in this runtime
      </div>
    </section>
  );
}

function AtlasProjectionView({ atlas }: { atlas: Atlas }) {
  const [repoRoot, setRepoRoot] = React.useState(atlas.defaultRepoRoot);
  const [missions, setMissions] = React.useState<AtlasMission[]>(() =>
    atlas.missions(),
  );
  const [goals, setGoals] = React.useState<AtlasGoal[]>(() => atlas.goals());
  const [info, setInfo] = React.useState<AtlasImportInfo | null>(() =>
    atlas.importInfo(),
  );
  const [selectedMission, setSelectedMission] = React.useState<string>('all');
  const [statusFilter, setStatusFilter] = React.useState<string>('all');
  const [selectedGoal, setSelectedGoal] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string>('');
  const [trustReport, setTrustReport] =
    React.useState<AtlasMissionControlReport | null>(null);
  const [trustError, setTrustError] = React.useState<string>('');
  const [completionReport, setCompletionReport] =
    React.useState<AtlasMissionControlReport | null>(null);
  const [completionError, setCompletionError] = React.useState<string>('');
  const [newMissionId, setNewMissionId] = React.useState('');
  const [newMissionTitle, setNewMissionTitle] = React.useState('');
  const [newMissionIntent, setNewMissionIntent] = React.useState('');
  const [newGoalId, setNewGoalId] = React.useState('');
  const [newGoalTitle, setNewGoalTitle] = React.useState('');
  const [newGoalObjective, setNewGoalObjective] = React.useState('');
  const [claimStatement, setClaimStatement] = React.useState('');
  const [evidenceEpisodes, setEvidenceEpisodes] = React.useState('');
  const [bundlePath, setBundlePath] = React.useState('');
  const [importBundlePath, setImportBundlePath] = React.useState('');
  const actor = 'work-dashboard';

  const reload = React.useCallback(() => {
    setInfo(atlas.importInfo());
    setMissions(atlas.missions());
    setGoals(atlas.goals());
  }, [atlas]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  React.useEffect(() => {
    if (selectedMission === 'all') {
      setTrustReport(null);
      setTrustError('');
      setCompletionReport(null);
      setCompletionError('');
      return;
    }
    try {
      setTrustReport(atlas.assessMission(selectedMission));
      setTrustError('');
    } catch (error) {
      setTrustReport(null);
      setTrustError((error as Error).message);
    }
  }, [atlas, selectedMission]);

  const importNow = () => {
    if (!repoRoot.trim()) {
      setMessage('enter an Atlas repo path before importing');
      return;
    }
    try {
      const result = atlas.importRepo(repoRoot);
      const missionControl = result.mission_control;
      setMessage(
        `imported ${result.missions} missions / ${result.goals} goals / ${result.markers} markers (${result.warnings.length} warning)${
          missionControl
            ? ` · Mission Control ${missionControl.status}: ${missionControl.admitted ?? 0} admitted / ${missionControl.already_present ?? 0} already present`
            : ''
        }`,
      );
      reload();
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  const createMissionNow = () => {
    try {
      const result = atlas.createMission(newMissionId, {
        title: newMissionTitle,
        intent: newMissionIntent,
        actor,
        actorType: 'user',
      });
      setMessage(
        `created ${result.mission_subject}: ${result.receipt.status}${
          result.receipt.reused ? ' (reused)' : ''
        }`,
      );
      reload();
      setSelectedMission(newMissionId);
      setNewMissionId('');
      setNewMissionTitle('');
      setNewMissionIntent('');
    } catch (error) {
      setMessage((error as Error).message);
    }
  };

  const exportMissionNow = (mode: 'full' | 'thin') => {
    if (selectedMission === 'all' || !bundlePath.trim()) {
      setMessage('select a Mission and enter an export path');
      return;
    }
    try {
      const result = atlas.exportMission(selectedMission, bundlePath, { mode });
      setMessage(
        `exported ${result.mode} bundle: ${result.status} · ${result.episode_count} Episodes · ${result.out}`,
      );
    } catch (error) {
      setMessage((error as Error).message);
    }
  };

  const importMissionNow = (execute: boolean) => {
    if (!importBundlePath.trim()) {
      setMessage('enter a Mission bundle path');
      return;
    }
    try {
      const result = atlas.importMission(importBundlePath, { execute });
      setMessage(
        `${result.mode} bundle ${result.status} · accepted=${result.accepted} · missing=${result.missing_material_count}${
          result.diagnosis ? ` · ${result.diagnosis}` : ''
        }`,
      );
      reload();
    } catch (error) {
      setMessage((error as Error).message);
    }
  };

  const createGoNow = () => {
    if (selectedMission === 'all') {
      setMessage('select a Mission before creating a Go');
      return;
    }
    try {
      const result = atlas.createGo(selectedMission, {
        goalId: newGoalId,
        title: newGoalTitle,
        objective: newGoalObjective,
        actor,
        actorType: 'user',
      });
      setMessage(
        `created ${result.go_subject}: ${result.receipt.status}${
          result.receipt.reused ? ' (reused)' : ''
        }`,
      );
      setTrustReport(atlas.assessMission(selectedMission));
      setNewGoalId('');
      setNewGoalTitle('');
      setNewGoalObjective('');
    } catch (error) {
      setMessage((error as Error).message);
    }
  };

  const claimAndAssessNow = () => {
    if (selectedMission === 'all' || !selectedGoal) {
      setCompletionError('select a Mission and Go before claiming completion');
      return;
    }
    try {
      const evidenceEpisodeIds = evidenceEpisodes
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      atlas.claimCompletion(selectedMission, selectedGoal, {
        statement: claimStatement,
        actor,
        actorType: 'user',
        evidenceEpisodeIds,
      });
      setCompletionReport(
        atlas.assessCompletion(selectedMission, selectedGoal),
      );
      setCompletionError('');
      setTrustReport(atlas.assessMission(selectedMission));
    } catch (error) {
      setCompletionReport(null);
      setCompletionError((error as Error).message);
    }
  };

  const effectiveGoals = new Map(goals.map((goal) => [goal.goal_id, goal]));
  for (const row of trustReport?.state.goals ?? []) {
    const goal = row.payload?.record;
    if (goal?.goal_id) effectiveGoals.set(goal.goal_id, goal);
  }
  const allGoals = [...effectiveGoals.values()];
  const visibleGoals = allGoals.filter(
    (goal) =>
      (selectedMission === 'all' || goal.mission_id === selectedMission) &&
      (statusFilter === 'all' || goal.status === statusFilter),
  );
  const currentGoal =
    visibleGoals.find((goal) => goal.goal_id === selectedGoal) ??
    allGoals.find((goal) => goal.goal_id === selectedGoal) ??
    null;
  const goalCounts = new Map<string, number>();
  for (const goal of allGoals) {
    const status = goal.status ?? 'unknown';
    goalCounts.set(status, (goalCounts.get(status) ?? 0) + 1);
  }

  return (
    <div style={{ display: 'flex', gap: 12, height: '100%', minHeight: 0 }}>
      <section style={{ ...panelStyle, width: 440, flexShrink: 0 }}>
        <h2 style={headingStyle}>Mission Control</h2>
        <div style={{ ...mono, color: '#858585', marginBottom: 8 }}>
          Atlas bridge + Kungfu-native facts · authority remains explicit
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <input
            value={repoRoot}
            placeholder="Atlas repo path"
            onChange={(e) => setRepoRoot(e.target.value)}
            style={{
              ...mono,
              flex: 1,
              minWidth: 0,
              border: '1px solid #3c3c3c',
              borderRadius: 4,
              background: '#1e1e1e',
              color: '#cccccc',
              padding: '4px 6px',
            }}
          />
          <SmallButton onClick={importNow}>import</SmallButton>
          <SmallButton onClick={reload}>refresh</SmallButton>
        </div>
        {info && (
          <div style={{ ...mono, color: '#9cdcfe', marginBottom: 6 }}>
            {info.missions} missions · {info.goals} goals · {info.markers}{' '}
            markers
          </div>
        )}
        {message && (
          <div style={{ ...mono, color: '#dcdcaa', marginBottom: 8 }}>
            {message}
          </div>
        )}
        <div
          style={{
            display: 'grid',
            gap: 5,
            marginBottom: 10,
            padding: 8,
            border: '1px solid #3c3c3c',
            borderRadius: 4,
          }}
        >
          <h2 style={headingStyle}>Create native Mission</h2>
          <TextInput
            value={newMissionId}
            placeholder="stable Mission id"
            onChange={setNewMissionId}
          />
          <TextInput
            value={newMissionTitle}
            placeholder="title"
            onChange={setNewMissionTitle}
          />
          <TextInput
            value={newMissionIntent}
            placeholder="long-running intent"
            onChange={setNewMissionIntent}
          />
          <SmallButton onClick={createMissionNow}>create Mission</SmallButton>
        </div>
        <div
          style={{
            display: 'grid',
            gap: 5,
            marginBottom: 10,
            padding: 8,
            border: '1px solid #3c3c3c',
            borderRadius: 4,
          }}
        >
          <h2 style={headingStyle}>Portable Mission bundle</h2>
          <TextInput
            value={bundlePath}
            placeholder="export path (.json)"
            onChange={setBundlePath}
          />
          <div style={{ display: 'flex', gap: 5 }}>
            <SmallButton onClick={() => exportMissionNow('full')}>
              export full
            </SmallButton>
            <SmallButton onClick={() => exportMissionNow('thin')}>
              export thin
            </SmallButton>
          </div>
          <TextInput
            value={importBundlePath}
            placeholder="import bundle path"
            onChange={setImportBundlePath}
          />
          <div style={{ display: 'flex', gap: 5 }}>
            <SmallButton onClick={() => importMissionNow(false)}>
              validate
            </SmallButton>
            <SmallButton onClick={() => importMissionNow(true)}>
              materialize
            </SmallButton>
          </div>
        </div>
        {selectedMission !== 'all' && (
          <div
            style={{
              display: 'grid',
              gap: 5,
              marginBottom: 10,
              padding: 8,
              border: '1px solid #3c3c3c',
              borderRadius: 4,
            }}
          >
            <h2 style={headingStyle}>Create native Go</h2>
            <TextInput
              value={newGoalId}
              placeholder="stable Go id"
              onChange={setNewGoalId}
            />
            <TextInput
              value={newGoalTitle}
              placeholder="title"
              onChange={setNewGoalTitle}
            />
            <TextInput
              value={newGoalObjective}
              placeholder="bounded objective"
              onChange={setNewGoalObjective}
            />
            <SmallButton onClick={createGoNow}>create Go</SmallButton>
          </div>
        )}
        <h2 style={headingStyle}>Missions · {missions.length}</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <button
            type="button"
            onClick={() => setSelectedMission('all')}
            style={{
              ...mono,
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              background: selectedMission === 'all' ? '#04395e' : 'transparent',
              color: '#cccccc',
              padding: '4px 8px',
              textAlign: 'left',
            }}
          >
            all missions
          </button>
          {missions.map((mission) => (
            <button
              key={mission.mission_id}
              type="button"
              onClick={() => setSelectedMission(mission.mission_id)}
              style={{
                ...mono,
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                background:
                  selectedMission === mission.mission_id
                    ? '#04395e'
                    : 'transparent',
                color: '#cccccc',
                padding: '4px 8px',
                textAlign: 'left',
              }}
            >
              <span style={{ color: '#4ec9b0' }}>{mission.mission_id}</span>
              <div style={{ color: '#858585', fontSize: 11 }}>
                {mission.title ?? ''} {mission.stage_name ?? ''}
              </div>
            </button>
          ))}
        </div>
      </section>
      <section style={{ ...panelStyle, width: 440, flexShrink: 0 }}>
        <h2 style={headingStyle}>Goals · {visibleGoals.length}</h2>
        <div
          style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}
        >
          <SmallButton
            active={statusFilter === 'all'}
            onClick={() => setStatusFilter('all')}
          >
            all {allGoals.length}
          </SmallButton>
          {ATLAS_GOAL_STATUSES.map((status) => (
            <SmallButton
              key={status}
              active={statusFilter === status}
              onClick={() => setStatusFilter(status)}
            >
              {status} {goalCounts.get(status) ?? 0}
            </SmallButton>
          ))}
        </div>
        {visibleGoals.length ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {visibleGoals.map((goal) => (
              <li key={goal.goal_id}>
                <button
                  type="button"
                  onClick={() => setSelectedGoal(goal.goal_id)}
                  style={{
                    ...mono,
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '4px 8px',
                    border: 'none',
                    borderRadius: 4,
                    cursor: 'pointer',
                    background:
                      selectedGoal === goal.goal_id ? '#04395e' : 'transparent',
                    color: '#cccccc',
                  }}
                >
                  <span style={{ color: '#9cdcfe' }}>
                    [{goal.status ?? 'unknown'}]
                  </span>{' '}
                  {goal.title ?? goal.goal_id}
                  <div style={{ color: '#858585', fontSize: 11 }}>
                    {goal.goal_id}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div style={{ ...mono, color: '#6a6a6a' }}>
            no imported goals match this filter
          </div>
        )}
        {selectedGoal && selectedMission !== 'all' && (
          <div
            style={{
              display: 'grid',
              gap: 5,
              marginTop: 10,
              padding: 8,
              border: '1px solid #3c3c3c',
              borderRadius: 4,
            }}
          >
            <h2 style={headingStyle}>Claim completion</h2>
            <TextInput
              value={claimStatement}
              placeholder="what this Go establishes"
              onChange={setClaimStatement}
            />
            <TextInput
              value={evidenceEpisodes}
              placeholder="evidence Episode ids, comma-separated"
              onChange={setEvidenceEpisodes}
            />
            <SmallButton onClick={claimAndAssessNow}>
              claim and assess
            </SmallButton>
          </div>
        )}
      </section>
      <div
        style={{
          display: 'flex',
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <MissionTrustPanel report={trustReport} error={trustError} />
        {(completionReport || completionError) && (
          <MissionTrustPanel
            title="Completion TrustReport"
            report={completionReport}
            error={completionError}
          />
        )}
        <AtlasGoalDetail goal={currentGoal} />
      </div>
    </div>
  );
}

function DetailView({
  caps,
  shell,
  item,
}: {
  caps: KfxCapabilities;
  shell: Shell;
  item: WorkItem;
}) {
  const time = (nanos: bigint) =>
    caps.ledger.formatNanos(nanos, '%m-%d %H:%M:%S');
  return (
    <section style={{ ...panelStyle, flex: 1 }}>
      <h2 style={headingStyle}>
        {item.workId} · {item.kind ?? 'task'}
      </h2>
      <div style={{ ...mono, fontSize: 13, marginBottom: 4 }}>
        <StatusBadge name={statusName(item)} /> {item.title}
      </div>
      {item.summary && (
        <div style={{ ...mono, color: '#858585', marginBottom: 8 }}>
          {item.summary}
        </div>
      )}
      {item.nextAction && (
        <div style={{ ...mono, color: '#dcdcaa', marginBottom: 8 }}>
          next: {item.nextAction}
        </div>
      )}
      <FactRows
        label="Checkpoints"
        rows={item.checkpoints.map((row) => ({
          key: String(row.time),
          fields: { time: time(row.time), note: row.note },
        }))}
      />
      <FactRows
        label="Decisions"
        rows={item.decisions.map((row) => ({
          key: String(row.time),
          fields: {
            time: time(row.time),
            decision: row.decision,
            by: row.decidedBy,
          },
        }))}
      />
      <FactRows
        label="Validations"
        rows={item.validations.map((row) => ({
          key: String(row.time),
          fields: {
            time: time(row.time),
            result: row.result === 0 ? 'pass' : 'fail',
            command: row.command,
            note: row.note,
          },
        }))}
      />
      <FactRows
        label="Artifacts"
        rows={item.artifacts.map((row) => ({
          key: String(row.time),
          fields: { time: time(row.time), ref: row.ref, kind: row.kind },
        }))}
      />
      {item.runs.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <h2 style={headingStyle}>Linked runs · {item.runs.length}</h2>
          {item.runs.map((row) => (
            <button
              key={String(row.time)}
              type="button"
              onClick={() =>
                row.runId && shell.open('rewind', { run: row.runId })
              }
              style={{
                ...mono,
                display: 'block',
                padding: '2px 0',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                color: '#9cdcfe',
                textAlign: 'left',
              }}
            >
              {time(row.time)} · {row.runId} → open in Rewind
            </button>
          ))}
        </div>
      )}
      <h2 style={headingStyle}>History</h2>
      {item.history.map((row) => (
        <div
          key={`${row.time}-${row.event}-${row.status ?? ''}`}
          style={{ ...mono, color: '#9cdcfe' }}
        >
          {time(row.time)}{' '}
          {row.event === 'created'
            ? 'created'
            : `-> ${row.status !== undefined ? WORK_STATUS_NAMES[row.status] : '?'}${
                row.reason ? ` (${row.reason})` : ''
              }`}
        </div>
      ))}
    </section>
  );
}

function WorkspaceGuidancePanel({
  workspace,
}: {
  workspace: WorkspaceGuidance;
}) {
  const [source, setSource] = React.useState(workspace.workspaceRoot);
  const [inspection, setInspection] =
    React.useState<WorkspaceGuidanceInspection | null>(null);
  const [advice, setAdvice] = React.useState<WorkspaceAdvice | null>(null);
  const [intent, setIntent] = React.useState<WorkspaceGuidanceIntent>(
    'create-project-workspace',
  );
  const [preview, setPreview] = React.useState<WorkspaceActionPreview | null>(
    null,
  );
  const [authorization, setAuthorization] =
    React.useState<WorkspaceAuthorization | null>(null);
  const [receipt, setReceipt] = React.useState<WorkspaceActionReceipt | null>(
    null,
  );
  const [verification, setVerification] =
    React.useState<WorkspaceActionVerification | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const resetAfterAdvice = () => {
    setPreview(null);
    setAuthorization(null);
    setReceipt(null);
    setVerification(null);
  };
  const inspectNow = () => {
    try {
      const nextInspection = workspace.inspect(source);
      const nextAdvice = workspace.advise(source);
      setInspection(nextInspection);
      setAdvice(nextAdvice);
      setIntent(nextAdvice.recommended_intent ?? 'keep-home');
      resetAfterAdvice();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const previewNow = () => {
    try {
      setPreview(workspace.preview(source, intent));
      setAuthorization(null);
      setReceipt(null);
      setVerification(null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const authorizeNow = (decision: 'approve' | 'deny') => {
    if (!preview) return;
    try {
      setAuthorization(
        workspace.authorize(
          source,
          intent,
          preview.preview_id,
          decision,
          'work-dashboard-user',
        ),
      );
      setReceipt(null);
      setVerification(null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const applyNow = () => {
    if (!authorization || authorization.decision !== 'approve') return;
    try {
      setReceipt(workspace.apply(source, authorization.authorization_id));
      setVerification(null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const verifyNow = () => {
    if (!receipt) return;
    try {
      setVerification(workspace.verify(receipt.receipt_id));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div
      style={{
        display: 'grid',
        gap: 5,
        marginTop: 8,
        paddingTop: 8,
        borderTop: '1px solid #3c3c3c',
      }}
    >
      <div style={{ display: 'flex', gap: 5 }}>
        <TextInput
          value={source}
          placeholder="source directory to inspect"
          onChange={setSource}
        />
        <SmallButton onClick={inspectNow}>inspect + advise</SmallButton>
      </div>
      {inspection && advice && (
        <div style={{ ...mono, color: '#cccccc' }}>
          <span style={{ color: '#9cdcfe' }}>{advice.state}</span> ·{' '}
          {advice.reason_codes.join(', ')} · captures{' '}
          {inspection.unassigned_capture_count} · cut{' '}
          {inspection.cut_id.slice(-12)}
        </div>
      )}
      {advice && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {advice.options.map((option) => (
            <SmallButton
              key={option}
              active={intent === option}
              onClick={() => {
                setIntent(option);
                resetAfterAdvice();
              }}
            >
              {option}
            </SmallButton>
          ))}
          <SmallButton onClick={previewNow}>preview effects</SmallButton>
        </div>
      )}
      {preview && (
        <div style={{ ...mono, color: '#ce9178' }}>
          effects: {preview.effects.map((effect) => effect.effect).join(', ')} ·
          skips Git/network · authorization {preview.authorization_class}
          <div style={{ display: 'flex', gap: 5, marginTop: 5 }}>
            <SmallButton onClick={() => authorizeNow('approve')}>
              approve exact preview
            </SmallButton>
            <SmallButton onClick={() => authorizeNow('deny')}>deny</SmallButton>
          </div>
        </div>
      )}
      {authorization && (
        <div style={{ ...mono, color: '#dcdcaa' }}>
          authorization {authorization.decision} ·{' '}
          {authorization.authorization_id.slice(-12)}{' '}
          {authorization.decision === 'approve' && (
            <SmallButton onClick={applyNow}>
              apply authorized action
            </SmallButton>
          )}
        </div>
      )}
      {receipt && (
        <div style={{ ...mono, color: '#4ec9b0' }}>
          receipt {receipt.receipt_id.slice(-12)} · reused=
          {String(receipt.reused)}{' '}
          <SmallButton onClick={verifyNow}>verify receipt</SmallButton>
        </div>
      )}
      {verification && (
        <div
          style={{ ...mono, color: verification.ok ? '#4ec9b0' : '#f48771' }}
        >
          verification {verification.ok ? 'passed' : 'failed'}
          {verification.errors.length
            ? ` · ${verification.errors.join(', ')}`
            : ''}
        </div>
      )}
      {error && <div style={{ ...mono, color: '#f48771' }}>{error}</div>}
    </div>
  );
}

function AgentWorkInboxSummary({
  items,
  workspace,
}: {
  items: WorkItem[];
  workspace?: WorkspaceGuidance;
}) {
  if (!items.length) {
    if (!workspace) return null;
    return (
      <section style={{ ...panelStyle, marginBottom: 8 }}>
        <h2 style={headingStyle}>Workspace guidance</h2>
        <div style={{ ...mono, color: '#858585' }}>
          Inspect a source without changing it, then review and authorize exact
          effects.
        </div>
        <WorkspaceGuidancePanel workspace={workspace} />
      </section>
    );
  }
  const evidenceCount = items.reduce(
    (count, item) => count + item.runs.length + item.artifacts.length,
    0,
  );
  const answers = [
    ['What are we trying to achieve?', 'Not yet declared.'],
    ['What actually happened?', `${items.length} unassigned capture(s).`],
    [
      'What does the evidence establish?',
      `${evidenceCount} linked run / receipt reference(s).`,
    ],
    ['Is it fit for purpose?', 'insufficient — no purpose is attached.'],
    [
      'Who should act next?',
      'User or agent: attach a Mission/Go or declare purpose.',
    ],
  ];
  return (
    <section style={{ ...panelStyle, marginBottom: 8 }}>
      <h2 style={headingStyle}>Agent Work Inbox · {items.length}</h2>
      {answers.map(([question, answer]) => (
        <div key={question} style={{ ...mono, marginBottom: 3 }}>
          <span style={{ color: '#9cdcfe' }}>{question}</span>{' '}
          <span style={{ color: '#cccccc' }}>{answer}</span>
        </div>
      ))}
      {workspace && <WorkspaceGuidancePanel workspace={workspace} />}
    </section>
  );
}

function WorkDashboardView({
  caps,
  shell,
}: {
  caps: KfxCapabilities;
  shell: Shell;
}) {
  const [view, setView] = React.useState<'work' | 'atlas'>(
    shell.params?.view === 'atlas' ? 'atlas' : 'work',
  );
  const [items, setItems] = React.useState<WorkItem[]>(() => caps.work.items());
  const [filter, setFilter] = React.useState<string>('all');
  const [selected, setSelected] = React.useState<string | null>(
    () =>
      items.find((item) => item.kind === 'agent-work-inbox')?.workId ?? null,
  );

  const reload = React.useCallback(() => {
    caps.work.refresh();
    setItems(caps.work.items());
  }, [caps.work]);

  // the shell owns the refresh timer; this kfx only subscribes
  React.useEffect(() => shell.onRefresh(reload), [shell, reload]);

  const counts = new Map<string, number>();
  for (const item of items) {
    const name = statusName(item);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const visible =
    filter === 'all'
      ? items
      : items.filter((item) => statusName(item) === filter);
  const current = items.find((item) => item.workId === selected) ?? null;
  const inboxItems = items.filter((item) => item.kind === 'agent-work-inbox');

  const filterButton = (name: string, count?: number) => (
    <button
      key={name}
      type="button"
      onClick={() => setFilter(name)}
      style={{
        ...mono,
        padding: '3px 8px',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        background: filter === name ? '#04395e' : 'transparent',
        color: filter === name ? '#9cdcfe' : (STATUS_COLORS[name] ?? '#cccccc'),
      }}
    >
      {name}
      {count !== undefined ? ` ${count}` : ''}
    </button>
  );

  if (view === 'atlas') {
    const atlas = caps.atlas;
    return (
      <div style={{ height: '100%', minHeight: 0 }}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
          <SmallButton onClick={() => setView('work')}>work</SmallButton>
          <SmallButton active onClick={() => setView('atlas')}>
            atlas
          </SmallButton>
        </div>
        {atlas ? (
          <AtlasProjectionView atlas={atlas} />
        ) : (
          <AtlasUnavailableView />
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
      }}
    >
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        <SmallButton active onClick={() => setView('work')}>
          work
        </SmallButton>
        <SmallButton onClick={() => setView('atlas')}>atlas</SmallButton>
      </div>
      <AgentWorkInboxSummary items={inboxItems} workspace={caps.workspace} />
      <div
        style={{
          display: 'flex',
          gap: 12,
          flex: 1,
          minHeight: 0,
        }}
      >
        <section style={{ ...panelStyle, width: 380, flexShrink: 0 }}>
          <h2 style={headingStyle}>
            {inboxItems.length
              ? `Agent Work Inbox ${inboxItems.length} · All Work ${items.length}`
              : `Work · ${items.length}`}
          </h2>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 4,
              marginBottom: 8,
            }}
          >
            {filterButton('all', items.length)}
            {STATUS_ORDER.map((name) =>
              filterButton(name, counts.get(name) ?? 0),
            )}
            <button
              type="button"
              onClick={reload}
              style={{
                ...mono,
                padding: '3px 8px',
                border: '1px solid #3c3c3c',
                borderRadius: 4,
                cursor: 'pointer',
                background: 'transparent',
                color: '#cccccc',
              }}
            >
              refresh
            </button>
          </div>
          {visible.length ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {visible.map((item) => (
                <li key={item.workId}>
                  <button
                    type="button"
                    onClick={() => setSelected(item.workId)}
                    style={{
                      ...mono,
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '4px 8px',
                      border: 'none',
                      borderRadius: 4,
                      cursor: 'pointer',
                      background:
                        selected === item.workId ? '#04395e' : 'transparent',
                      color: '#cccccc',
                    }}
                  >
                    <StatusBadge name={statusName(item)} />{' '}
                    {item.title ?? item.workId}
                    {item.nextAction && (
                      <div style={{ color: '#858585', fontSize: 11 }}>
                        next: {item.nextAction}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div style={{ ...mono, color: '#6a6a6a' }}>
              no work items — create one with `kungfu work create "..."`
            </div>
          )}
        </section>
        {current ? (
          <DetailView caps={caps} shell={shell} item={current} />
        ) : (
          <section style={{ ...panelStyle, flex: 1 }}>
            <div style={{ ...mono, color: '#6a6a6a' }}>
              select a work item — its facts, next action, history and linked
              runs appear here
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

export const View = WorkDashboardView;
