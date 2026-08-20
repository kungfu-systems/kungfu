import { mono, panelStyle } from '@kungfu-tech/kfx';
import React from 'react';
import type { AgentProgressRow } from './agent-progress';
import {
  type GoalCluster,
  type GoalSection,
  MISSION_CONTROL_VISUAL_SPEC,
  type TrustVisual,
  type VisualTrustState,
  deriveTrustVisual,
  goalStatusGlyph,
  missionIntent,
  missionStage,
  queryGoalClusters,
  responsibilityActions,
} from './initiative-visual-model';
import type {
  AtlasGoal,
  AtlasMission,
  WorkControlAuthorityReport,
} from './work-control-profile';
import type { GoalCardQuerySpec } from './work-control-query';

const COLORS = {
  canvas: '#11161d',
  panel: '#171d26',
  elevated: '#1d2632',
  border: '#313b49',
  subtleBorder: '#252e3a',
  text: '#e5e9ef',
  muted: '#8c98a8',
  cyan: '#59c9d8',
  blue: '#75a7ff',
  green: '#55c6a9',
  amber: '#e2b65b',
  red: '#ed7b72',
  violet: '#b59cff',
};

const TRUST_COLORS: Record<VisualTrustState, string> = {
  established: COLORS.green,
  partial: COLORS.amber,
  attention: COLORS.red,
  stale: COLORS.violet,
  unknown: COLORS.muted,
};

const SECTION_META: Record<
  GoalSection,
  { label: string; glyph: string; color: string }
> = {
  attention: { label: 'Attention', glyph: '!', color: COLORS.red },
  'in-motion': { label: 'In motion', glyph: '●', color: COLORS.green },
  delegated: { label: 'Delegated', glyph: '◐', color: COLORS.amber },
  closed: { label: 'Closed', glyph: '✓', color: COLORS.muted },
};

const compactButton = (active = false): React.CSSProperties => ({
  ...mono,
  border: `1px solid ${active ? COLORS.cyan : COLORS.border}`,
  borderRadius: 6,
  padding: '4px 8px',
  color: active ? COLORS.cyan : COLORS.muted,
  background: active ? '#15313b' : 'transparent',
  cursor: 'pointer',
});

export function TrustGlyph({
  visual,
  compact = false,
}: {
  visual: TrustVisual;
  compact?: boolean;
}) {
  const size = compact ? 30 : 58;
  const facetSize = compact ? 5 : 9;
  return (
    <button
      type="button"
      aria-label={`KFD-2 trust ${visual.label}. ${visual.detail}`}
      title={`KFD-2 ${visual.label}\n${visual.detail}`}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        border: `2px solid ${TRUST_COLORS[visual.state]}`,
        display: 'grid',
        placeItems: 'center',
        position: 'relative',
        flexShrink: 0,
        background: '#111821',
        color: TRUST_COLORS[visual.state],
        outlineOffset: 3,
        padding: 0,
        cursor: 'help',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          ...mono,
          fontSize: compact ? 12 : 20,
          lineHeight: 1,
          fontWeight: 700,
        }}
      >
        {visual.glyph}
      </span>
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: compact ? 3 : 5,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gridTemplateRows: '1fr 1fr',
          pointerEvents: 'none',
        }}
      >
        {visual.facets.map((facet, index) => (
          <i
            key={facet.id}
            title={`${facet.id}: ${facet.detail}`}
            style={{
              width: facetSize,
              height: facetSize,
              borderRadius: index % 2 ? '0 50% 50% 0' : '50% 0 0 50%',
              background: TRUST_COLORS[facet.state],
              opacity: facet.state === 'unknown' ? 0.35 : 0.9,
              justifySelf: index % 2 ? 'end' : 'start',
              alignSelf: index > 1 ? 'end' : 'start',
            }}
          />
        ))}
      </span>
    </button>
  );
}

function StageTrajectory({
  mission,
  trust,
}: {
  mission: AtlasMission;
  trust: TrustVisual;
}) {
  const stage = missionStage(mission);
  const paused = ['paused', 'waiting', 'reviewing'].includes(
    mission.status ?? '',
  );
  const attention = ['attention', 'stale'].includes(trust.state);
  const node = (glyph: string, label: string, color: string, title: string) => (
    <button
      type="button"
      title={title}
      aria-label={`${label}. ${title}`}
      style={{
        minWidth: 86,
        textAlign: 'center',
        outlineOffset: 3,
        border: 0,
        padding: 0,
        background: 'transparent',
        cursor: 'help',
      }}
    >
      <div
        aria-hidden="true"
        style={{ ...mono, color, fontSize: 22, lineHeight: 1.1 }}
      >
        {glyph}
      </div>
      <div
        style={{
          ...mono,
          marginTop: 5,
          color,
          fontSize: 10,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </div>
    </button>
  );
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          minWidth: 0,
          padding: '8px 2px 2px',
        }}
      >
        {node('◆', 'Declared', COLORS.green, 'Mission declaration is present')}
        <div
          aria-hidden="true"
          style={{
            height: 2,
            flex: 1,
            minWidth: 30,
            marginTop: 10,
            background: `linear-gradient(90deg, ${COLORS.green}, ${
              attention ? COLORS.red : COLORS.cyan
            })`,
          }}
        />
        {node(
          paused ? 'Ⅱ' : '◉',
          stage,
          attention ? COLORS.red : paused ? COLORS.amber : COLORS.cyan,
          mission.stage_summary || `Current declared stage: ${stage}`,
        )}
        <div
          aria-hidden="true"
          style={{
            height: 0,
            flex: 1,
            minWidth: 30,
            marginTop: 10,
            borderTop: `2px dashed ${COLORS.border}`,
          }}
        />
        {node(
          '◇',
          'Open future',
          COLORS.muted,
          'No later Mission milestone is declared; the UI does not invent one',
        )}
      </div>
      {attention && (
        <button
          type="button"
          title={trust.detail}
          style={{
            ...mono,
            color: TRUST_COLORS[trust.state],
            fontSize: 11,
            marginLeft: '47%',
            marginTop: -2,
            border: 0,
            padding: 0,
            background: 'transparent',
            cursor: 'help',
          }}
        >
          ↘ {trust.glyph}
        </button>
      )}
    </div>
  );
}

export function MissionSituationOverview({
  mission,
  report,
  error,
  dashboardCut,
  refreshing,
}: {
  mission: AtlasMission | null;
  report: WorkControlAuthorityReport | null;
  error: string;
  dashboardCut: string;
  refreshing: boolean;
}) {
  if (!mission) {
    return (
      <section
        style={{
          ...panelStyle,
          minHeight: 190,
          display: 'grid',
          placeItems: 'center',
          background: COLORS.canvas,
          border: `1px dashed ${COLORS.border}`,
        }}
      >
        <div style={{ ...mono, color: COLORS.muted }}>
          Select a Mission to resolve its situation.
        </div>
      </section>
    );
  }
  const trust = deriveTrustVisual(report, error);
  const actions = responsibilityActions(report);
  const proofCount =
    report?.profile.proof.verified_fact_episode_roots?.length ?? 0;
  const intent = missionIntent(mission);
  return (
    <section
      data-visual-spec={MISSION_CONTROL_VISUAL_SPEC.schema}
      style={{
        ...panelStyle,
        padding: 18,
        background:
          'radial-gradient(circle at 82% 0%, rgba(89,201,216,0.13), transparent 36%), linear-gradient(145deg, #171d26, #11161d)',
        border: `1px solid ${COLORS.border}`,
        borderRadius: 12,
        boxShadow: '0 14px 34px rgba(0,0,0,0.22)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 14,
          alignItems: 'flex-start',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              ...mono,
              fontSize: 20,
              fontWeight: 700,
              color: COLORS.text,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {mission.title || mission.mission_id}
          </div>
          {intent && (
            <div
              style={{
                color: '#bac4d1',
                fontSize: 13,
                lineHeight: 1.45,
                marginTop: 5,
                maxWidth: 760,
              }}
            >
              {intent}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <span
            title="Mission lifecycle state"
            style={{
              ...mono,
              color: mission.status === 'active' ? COLORS.green : COLORS.amber,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 999,
              padding: '4px 8px',
            }}
          >
            ● {mission.status || 'unknown'}
          </span>
          {mission.active_lens && (
            <span
              title="Current Mission lens"
              style={{
                ...mono,
                color: COLORS.blue,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 999,
                padding: '4px 8px',
              }}
            >
              ◇ {mission.active_lens}
            </span>
          )}
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns:
            'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
          gap: 18,
          alignItems: 'center',
          marginTop: 16,
        }}
      >
        <StageTrajectory mission={mission} trust={trust} />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: 12,
            alignItems: 'center',
            padding: 12,
            border: `1px solid ${COLORS.subtleBorder}`,
            borderRadius: 10,
            background: 'rgba(12,17,23,0.56)',
          }}
        >
          <TrustGlyph visual={trust} />
          <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
            <div style={{ ...mono, color: TRUST_COLORS[trust.state] }}>
              KFD-2 · {trust.label}
            </div>
            <div style={{ ...mono, color: COLORS.muted, fontSize: 10 }}>
              ▱ {proofCount} proof Episode root{proofCount === 1 ? '' : 's'}
              {' · '}
              {refreshing
                ? '↻ refreshing'
                : `cut ${dashboardCut.slice(-10) || '—'}`}
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          marginTop: 15,
          paddingTop: 12,
          borderTop: `1px solid ${COLORS.subtleBorder}`,
          overflowX: 'auto',
        }}
      >
        {actions.length ? (
          actions.slice(0, 6).map((action, index) => (
            <button
              key={`${action.subject}-${action.action}`}
              type="button"
              title={`${action.action}\n${action.source}`}
              aria-label={`${index === 0 ? 'Next actor' : 'Declared actor'} ${
                action.actor || action.subject
              }: ${action.action}`}
              style={{
                ...mono,
                border: `1px solid ${index === 0 ? COLORS.cyan : COLORS.border}`,
                borderRadius: 999,
                background: index === 0 ? '#16323c' : COLORS.panel,
                color: index === 0 ? COLORS.cyan : COLORS.muted,
                padding: index === 0 ? '7px 11px' : '5px 9px',
                cursor: 'help',
                whiteSpace: 'nowrap',
              }}
            >
              {index === 0 ? '◎' : '○'}{' '}
              {action.actor || action.subject || 'Unassigned'}
              {index === 0 ? ' ↗' : ''}
            </button>
          ))
        ) : (
          <span
            title="No responsible actor or next action is declared at this cut"
            style={{ ...mono, color: COLORS.muted }}
          >
            ○ Unassigned responsibility
          </span>
        )}
      </div>
    </section>
  );
}

function GoalTrustMark({ state }: { state: VisualTrustState }) {
  return (
    <span
      title={`Go-level KFD-2: ${state}. Mission trust is not inherited.`}
      aria-label={`Go-level KFD-2 ${state}`}
      style={{
        ...mono,
        color: TRUST_COLORS[state],
        border: `1px solid ${TRUST_COLORS[state]}`,
        borderRadius: 999,
        padding: '2px 6px',
        fontSize: 9,
      }}
    >
      K2 {state === 'established' ? '◆' : state === 'unknown' ? '?' : '!'}
    </span>
  );
}

function GoalCard({
  cluster,
  expanded,
  selectedGoalId,
  trustByGoal,
  onToggle,
  onSelectGoal,
}: {
  cluster: GoalCluster;
  expanded: boolean;
  selectedGoalId: string | null;
  trustByGoal: Readonly<Record<string, VisualTrustState>>;
  onToggle: () => void;
  onSelectGoal: (goalId: string) => void;
}) {
  const parent = cluster.parent;
  const children = cluster.members.slice(1);
  const meta = SECTION_META[cluster.section];
  const parentTrust = trustByGoal[parent.goal_id] ?? 'unknown';
  const completed = cluster.members.filter(({ goal }) =>
    ['completed', 'done', 'merged', 'archived'].includes(goal.status ?? ''),
  ).length;
  return (
    <article
      style={{
        minWidth: 0,
        border: `1px solid ${
          selectedGoalId === parent.goal_id ? COLORS.cyan : COLORS.border
        }`,
        borderRadius: 11,
        background: `linear-gradient(145deg, ${COLORS.elevated}, ${COLORS.panel})`,
        boxShadow: '0 8px 22px rgba(0,0,0,0.2)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => onSelectGoal(parent.goal_id)}
        style={{
          display: 'block',
          width: '100%',
          border: 0,
          background: 'transparent',
          color: COLORS.text,
          textAlign: 'left',
          padding: 13,
          cursor: 'pointer',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <span style={{ ...mono, color: meta.color, fontSize: 11 }}>
            {goalStatusGlyph(parent.status)} {parent.status || 'unknown'}
          </span>
          <GoalTrustMark state={parentTrust} />
        </div>
        <div
          style={{
            marginTop: 9,
            fontSize: 14,
            lineHeight: 1.3,
            fontWeight: 650,
            color: COLORS.text,
          }}
        >
          {parent.title || parent.goal_id}
        </div>
        {(parent.mission_why_matters || parent.summary) && (
          <div
            style={{
              marginTop: 6,
              color: '#aeb8c5',
              fontSize: 11,
              lineHeight: 1.4,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {parent.mission_why_matters || parent.summary}
          </div>
        )}
        <div
          style={{
            ...mono,
            display: 'flex',
            gap: 7,
            flexWrap: 'wrap',
            color: COLORS.muted,
            fontSize: 9,
            marginTop: 10,
          }}
        >
          {parent.mission_stage && <span>◉ {parent.mission_stage}</span>}
          {parent.mission_role && <span>◇ {parent.mission_role}</span>}
          {parent.owner_agent && <span>◎ {parent.owner_agent}</span>}
        </div>
        {parent.next_action && (
          <div
            style={{
              ...mono,
              marginTop: 10,
              paddingTop: 8,
              borderTop: `1px solid ${COLORS.subtleBorder}`,
              color: COLORS.amber,
              fontSize: 10,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            ↗ {parent.next_action}
          </div>
        )}
      </button>
      {children.length > 0 && (
        <div style={{ borderTop: `1px solid ${COLORS.subtleBorder}` }}>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            style={{
              ...mono,
              width: '100%',
              border: 0,
              background: '#151b23',
              color: COLORS.muted,
              padding: '7px 12px',
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            {expanded ? '▾' : '▸'} {children.length} visible child Go
            {children.length === 1 ? '' : 's'} · {completed}/
            {cluster.members.length} closed
            {cluster.matchCount !== undefined
              ? ` · ${cluster.matchCount} matched`
              : ''}
          </button>
          {expanded && (
            <div style={{ padding: '5px 8px 8px', background: '#121820' }}>
              {children.map(({ goal, depth }) => (
                <button
                  key={goal.goal_id}
                  type="button"
                  onClick={() => onSelectGoal(goal.goal_id)}
                  style={{
                    ...mono,
                    display: 'grid',
                    gridTemplateColumns: '18px minmax(0,1fr) auto',
                    alignItems: 'center',
                    gap: 5,
                    width: '100%',
                    border: 0,
                    borderRadius: 6,
                    background:
                      selectedGoalId === goal.goal_id
                        ? '#17313a'
                        : 'transparent',
                    color: COLORS.text,
                    padding: `6px 7px 6px ${7 + Math.min(depth - 1, 3) * 12}px`,
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ color: SECTION_META[cluster.section].color }}>
                    {goalStatusGlyph(goal.status)}
                  </span>
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {goal.title || goal.goal_id}
                  </span>
                  <GoalTrustMark
                    state={trustByGoal[goal.goal_id] ?? 'unknown'}
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export function GoalCardField({
  goals,
  selectedGoalId,
  trustByGoal,
  query,
  asOfTime,
  savedViewId,
  saveState,
  onQueryChange,
  onSave,
  onSelectGoal,
}: {
  goals: AtlasGoal[];
  selectedGoalId: string | null;
  trustByGoal: Readonly<Record<string, VisualTrustState>>;
  query: GoalCardQuerySpec;
  asOfTime: string;
  savedViewId: string;
  saveState: string;
  onQueryChange: (query: GoalCardQuerySpec) => void;
  onSave: () => void;
  onSelectGoal: (goalId: string) => void;
}) {
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
  const clusters = React.useMemo(
    () =>
      queryGoalClusters(
        goals,
        query,
        trustByGoal,
        Date.parse(asOfTime) || Date.now(),
      ),
    [goals, query, trustByGoal, asOfTime],
  );
  const optionValues = React.useMemo(() => {
    const values = (field: keyof AtlasGoal) =>
      [
        ...new Set(
          goals.map((goal) => String(goal[field] ?? '')).filter(Boolean),
        ),
      ].sort();
    return {
      statuses: values('status'),
      actors: values('owner_agent'),
      tracks: values('mission_track'),
      roles: values('mission_role'),
      importance: values('mission_importance'),
      stages: values('mission_stage'),
    };
  }, [goals]);
  const update = (patch: Partial<GoalCardQuerySpec>) =>
    onQueryChange({ ...query, ...patch });
  const toggleSection = (section: GoalSection) =>
    update({
      sections: query.sections.includes(section)
        ? query.sections.filter((value) => value !== section)
        : [...query.sections, section],
    });
  const activeFilterCount = [
    query.text.trim(),
    ...query.sections,
    ...query.statuses,
    ...query.trust,
    ...query.actors,
    ...query.tracks,
    ...query.roles,
    ...query.importance,
    ...query.stages,
    query.updatedWithinDays === null ? '' : String(query.updatedWithinDays),
    query.hasChildren === 'all' ? '' : query.hasChildren,
    query.closed === 'include' ? '' : query.closed,
    query.hideClosedChildren ? 'hide-closed-children' : '',
  ].filter(Boolean).length;
  const single = (
    field: 'statuses' | 'actors' | 'tracks' | 'roles' | 'importance' | 'stages',
    value: string,
  ) =>
    update({ [field]: value ? [value] : [] } as Pick<
      GoalCardQuerySpec,
      typeof field
    >);
  const reset = () =>
    onQueryChange({
      schema: 'kungfu.work-control.goal-card-query/v1',
      text: '',
      sections: [],
      statuses: [],
      trust: [],
      actors: [],
      tracks: [],
      roles: [],
      importance: [],
      stages: [],
      updatedWithinDays: null,
      hasChildren: 'all',
      closed: 'include',
      hideClosedChildren: false,
      sort: { field: 'decision-priority', direction: 'desc' },
    });
  const toggle = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  if (!goals.length) {
    return (
      <section style={{ ...panelStyle, border: `1px dashed ${COLORS.border}` }}>
        <div style={{ ...mono, color: COLORS.muted }}>
          No admitted Go is attached to this Mission.
        </div>
      </section>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <section
        aria-label="Go card query controls"
        style={{
          display: 'grid',
          gap: 8,
          padding: 10,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 10,
          background: COLORS.panel,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            alignItems: 'center',
          }}
        >
          <input
            aria-label="Search Go cards"
            value={query.text}
            placeholder="Search Go cards"
            onChange={(event) => update({ text: event.target.value })}
            style={{
              ...mono,
              flex: '1 1 220px',
              minWidth: 140,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 6,
              background: COLORS.canvas,
              color: COLORS.text,
              padding: '6px 8px',
            }}
          />
          {(Object.keys(SECTION_META) as GoalSection[]).map((section) => (
            <button
              key={section}
              type="button"
              onClick={() => toggleSection(section)}
              style={compactButton(query.sections.includes(section))}
            >
              {SECTION_META[section].glyph} {SECTION_META[section].label}
            </button>
          ))}
          <select
            aria-label="Sort Go cards"
            value={query.sort.field}
            onChange={(event) =>
              update({
                sort: {
                  field: event.target
                    .value as GoalCardQuerySpec['sort']['field'],
                  direction: event.target.value === 'name' ? 'asc' : 'desc',
                },
              })
            }
            style={{ ...compactButton(), background: COLORS.canvas }}
          >
            <option value="decision-priority">Decision priority</option>
            <option value="updated">Recently updated</option>
            <option value="importance">Importance</option>
            <option value="trust-risk">Trust risk</option>
            <option value="next-actor">Next actor</option>
            <option value="lifecycle">Lifecycle</option>
            <option value="name">Name</option>
          </select>
          <button
            type="button"
            title="Reverse sort direction"
            aria-label={`Sort ${query.sort.direction === 'asc' ? 'ascending' : 'descending'}`}
            onClick={() =>
              update({
                sort: {
                  ...query.sort,
                  direction: query.sort.direction === 'asc' ? 'desc' : 'asc',
                },
              })
            }
            style={compactButton()}
          >
            {query.sort.direction === 'asc' ? '↑' : '↓'}
          </button>
        </div>
        <details>
          <summary style={{ ...mono, color: COLORS.muted, cursor: 'pointer' }}>
            Filters {activeFilterCount ? `· ${activeFilterCount} active` : ''}
          </summary>
          <div
            style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}
          >
            {(
              [
                ['statuses', 'Status', optionValues.statuses],
                ['actors', 'Actor', optionValues.actors],
                ['tracks', 'Track', optionValues.tracks],
                ['roles', 'Role', optionValues.roles],
                ['importance', 'Importance', optionValues.importance],
                ['stages', 'Stage', optionValues.stages],
              ] as const
            ).map(([field, label, values]) => (
              <select
                key={field}
                aria-label={`Filter by ${label}`}
                value={query[field][0] ?? ''}
                onChange={(event) => single(field, event.target.value)}
                style={{ ...compactButton(), background: COLORS.canvas }}
              >
                <option value="">All {label.toLocaleLowerCase()}</option>
                {values.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            ))}
            <select
              aria-label="Filter by KFD-2 trust"
              value={query.trust[0] ?? ''}
              onChange={(event) =>
                update({
                  trust: event.target.value
                    ? [event.target.value as VisualTrustState]
                    : [],
                })
              }
              style={{ ...compactButton(), background: COLORS.canvas }}
            >
              <option value="">All KFD-2</option>
              {Object.keys(TRUST_COLORS).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by updated time"
              value={query.updatedWithinDays ?? ''}
              onChange={(event) =>
                update({
                  updatedWithinDays: event.target.value
                    ? Number(event.target.value)
                    : null,
                })
              }
              style={{ ...compactButton(), background: COLORS.canvas }}
            >
              <option value="">Any update time</option>
              <option value="1">Updated 24h</option>
              <option value="7">Updated 7d</option>
              <option value="14">Updated 14d</option>
              <option value="30">Updated 30d</option>
            </select>
            <select
              aria-label="Filter by child relationship"
              value={query.hasChildren}
              onChange={(event) =>
                update({
                  hasChildren: event.target
                    .value as GoalCardQuerySpec['hasChildren'],
                })
              }
              style={{ ...compactButton(), background: COLORS.canvas }}
            >
              <option value="all">Any hierarchy</option>
              <option value="yes">Has children</option>
              <option value="no">No children</option>
            </select>
            <select
              aria-label="Filter closed Go cards"
              value={query.closed}
              onChange={(event) =>
                update({
                  closed: event.target.value as GoalCardQuerySpec['closed'],
                })
              }
              style={{ ...compactButton(), background: COLORS.canvas }}
            >
              <option value="include">Include closed</option>
              <option value="exclude">Exclude closed</option>
              <option value="only">Closed only</option>
            </select>
            <label style={{ ...mono, color: COLORS.muted, padding: '5px 2px' }}>
              <input
                type="checkbox"
                checked={query.hideClosedChildren}
                onChange={(event) =>
                  update({ hideClosedChildren: event.target.checked })
                }
              />{' '}
              Hide closed children
            </label>
          </div>
        </details>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            alignItems: 'center',
          }}
        >
          <span style={{ ...mono, color: COLORS.muted }}>
            {clusters.length} cluster{clusters.length === 1 ? '' : 's'} ·{' '}
            {savedViewId}
          </span>
          <button type="button" onClick={onSave} style={compactButton(true)}>
            Save workspace view
          </button>
          <button type="button" onClick={reset} style={compactButton()}>
            Reset
          </button>
          {saveState && (
            <span style={{ ...mono, color: COLORS.green }}>{saveState}</span>
          )}
        </div>
      </section>
      {(Object.keys(SECTION_META) as GoalSection[]).map((section) => {
        const rows = clusters.filter((cluster) => cluster.section === section);
        if (!rows.length) return null;
        const meta = SECTION_META[section];
        return (
          <section key={section} aria-label={`${meta.label} Go cards`}>
            <div
              style={{
                ...mono,
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                color: meta.color,
                margin: '1px 2px 7px',
                fontSize: 11,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}
            >
              <span aria-hidden="true">{meta.glyph}</span>
              {meta.label}
              <span style={{ color: COLORS.muted }}>{rows.length}</span>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(270px, 1fr))',
                gap: 10,
                alignItems: 'start',
              }}
            >
              {rows.map((cluster) => (
                <GoalCard
                  key={cluster.key}
                  cluster={cluster}
                  expanded={expanded.has(cluster.key)}
                  selectedGoalId={selectedGoalId}
                  trustByGoal={trustByGoal}
                  onToggle={() => toggle(cluster.key)}
                  onSelectGoal={onSelectGoal}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

type DetailTab =
  | 'summary'
  | 'live'
  | 'timeline'
  | 'trust'
  | 'evidence'
  | 'relations';

export function GoalDetailDrawer({
  goal,
  mission,
  trust,
  onClose,
  onClaimCompletion,
  onOpenConsole,
  agentProgress,
  agentProgressError,
  formatTime,
}: {
  goal: AtlasGoal;
  mission: AtlasMission | null;
  trust: TrustVisual;
  onClose: () => void;
  onClaimCompletion: () => void;
  onOpenConsole: () => void;
  agentProgress: AgentProgressRow[];
  agentProgressError: string;
  formatTime: (nanos: bigint) => string;
}) {
  const [tab, setTab] = React.useState<DetailTab>('summary');
  const row = (label: string, value?: string | boolean) =>
    value === undefined || value === '' ? null : (
      <div
        key={label}
        style={{
          display: 'grid',
          gridTemplateColumns: '105px minmax(0,1fr)',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <span style={{ ...mono, color: COLORS.muted, fontSize: 10 }}>
          {label}
        </span>
        <span
          style={{
            ...mono,
            color: COLORS.text,
            fontSize: 10,
            overflowWrap: 'anywhere',
          }}
        >
          {String(value)}
        </span>
      </div>
    );
  return (
    <aside
      aria-label={`Go details: ${goal.title || goal.goal_id}`}
      style={{
        position: 'absolute',
        zIndex: 30,
        top: 0,
        right: 0,
        bottom: 0,
        width: 'min(460px, 92vw)',
        display: 'flex',
        flexDirection: 'column',
        background: '#151b23',
        borderLeft: `1px solid ${COLORS.border}`,
        boxShadow: '-20px 0 50px rgba(0,0,0,0.48)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
          padding: 16,
          borderBottom: `1px solid ${COLORS.border}`,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ ...mono, color: COLORS.muted, fontSize: 10 }}>
            {goalStatusGlyph(goal.status)} {goal.status || 'unknown'}
          </div>
          <div
            style={{
              marginTop: 5,
              color: COLORS.text,
              fontSize: 16,
              fontWeight: 650,
              lineHeight: 1.35,
            }}
          >
            {goal.title || goal.goal_id}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            onClick={onOpenConsole}
            style={compactButton(true)}
            title="Open an Episode-backed Agent Console for this Go"
          >
            ▶ Agent
          </button>
          <button type="button" onClick={onClose} style={compactButton()}>
            close
          </button>
        </div>
      </div>
      <div
        role="tablist"
        aria-label="Go detail sections"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 4,
          padding: '9px 12px',
          borderBottom: `1px solid ${COLORS.subtleBorder}`,
        }}
      >
        {(
          [
            'summary',
            'live',
            'timeline',
            'trust',
            'evidence',
            'relations',
          ] as DetailTab[]
        ).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            style={compactButton(tab === name)}
          >
            {name}
            {name === 'live' && agentProgress.length > 0
              ? ` ${agentProgress.length}`
              : ''}
          </button>
        ))}
      </div>
      <div style={{ padding: 16, overflow: 'auto', flex: 1 }}>
        {tab === 'summary' && (
          <>
            {(goal.mission_why_matters || goal.summary) && (
              <div
                style={{ color: '#bac4d1', lineHeight: 1.5, marginBottom: 16 }}
              >
                {goal.mission_why_matters || goal.summary}
              </div>
            )}
            {goal.next_action && (
              <div
                style={{
                  ...mono,
                  color: COLORS.amber,
                  background: '#241f16',
                  border: '1px solid #4b4028',
                  borderRadius: 8,
                  padding: 10,
                  marginBottom: 14,
                }}
              >
                ↗ {goal.next_action}
              </div>
            )}
            {agentProgress[0] && (
              <button
                type="button"
                onClick={() => setTab('live')}
                style={{
                  ...mono,
                  width: '100%',
                  color:
                    agentProgress[0].severity === 'error'
                      ? COLORS.red
                      : agentProgress[0].signal === 'waiting' ||
                          agentProgress[0].signal === 'blocker'
                        ? COLORS.amber
                        : COLORS.cyan,
                  background: '#111820',
                  border: `1px solid ${COLORS.subtleBorder}`,
                  borderRadius: 8,
                  padding: 10,
                  marginBottom: 14,
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                live · {agentProgress[0].signal} ·{' '}
                {agentProgress[0].phase || 'agent'}
                <div style={{ marginTop: 5, color: COLORS.text }}>
                  {agentProgress[0].message}
                </div>
              </button>
            )}
            {row('goal id', goal.goal_id)}
            {row('stage', goal.mission_stage)}
            {row('role', goal.mission_role)}
            {row('importance', goal.mission_importance)}
            {row('track', goal.mission_track)}
          </>
        )}
        {tab === 'live' && (
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ ...mono, color: COLORS.muted, lineHeight: 1.45 }}>
              Live Agent Console observations from the control runtime. These do
              not change Go state or prove completion.
            </div>
            {agentProgressError && (
              <div style={{ ...mono, color: COLORS.red }}>
                progress unavailable · {agentProgressError}
              </div>
            )}
            {!agentProgressError && agentProgress.length === 0 && (
              <div style={{ ...mono, color: COLORS.muted }}>
                No progress observation has arrived for this Go yet.
              </div>
            )}
            {agentProgress.map((progress) => (
              <div
                key={`${progress.runId}-${progress.genTime}`}
                style={{
                  border: `1px solid ${COLORS.subtleBorder}`,
                  borderRadius: 8,
                  background: '#111820',
                  padding: 10,
                }}
              >
                <div
                  style={{
                    ...mono,
                    color:
                      progress.severity === 'error'
                        ? COLORS.red
                        : progress.signal === 'waiting' ||
                            progress.signal === 'blocker'
                          ? COLORS.amber
                          : COLORS.cyan,
                    fontSize: 10,
                  }}
                >
                  {formatTime(progress.genTime)} · {progress.signal} ·{' '}
                  {progress.phase || 'agent'}
                  {progress.pct !== undefined ? ` · ${progress.pct}%` : ''}
                </div>
                <div style={{ color: COLORS.text, marginTop: 6 }}>
                  {progress.message}
                </div>
                {progress.nextAction && (
                  <div style={{ ...mono, color: COLORS.amber, marginTop: 6 }}>
                    next · {progress.nextAction}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {tab === 'timeline' && (
          <>
            <div style={{ ...mono, color: COLORS.muted, marginBottom: 12 }}>
              Projection coordinates at the current cut
            </div>
            {row('updated', goal.updated_at || 'not projected')}
            {row('status', goal.status)}
            {row('source branch', goal.source_branch)}
            {row('latest marker', goal.latest_marker)}
          </>
        )}
        {tab === 'trust' && (
          <div style={{ display: 'grid', justifyItems: 'start', gap: 12 }}>
            <TrustGlyph visual={trust} />
            <div style={{ ...mono, color: TRUST_COLORS[trust.state] }}>
              KFD-2 {trust.label}
            </div>
            <div style={{ color: COLORS.muted, lineHeight: 1.45 }}>
              {trust.detail}
            </div>
            <button
              type="button"
              onClick={onClaimCompletion}
              style={compactButton()}
            >
              claim completion + assess
            </button>
          </div>
        )}
        {tab === 'evidence' && (
          <>
            {row('external ref', goal.external_ready_ref)}
            {row('external head', goal.external_head)}
            {row('latest marker', goal.latest_marker)}
            {row('worktree', goal.worktree_path)}
            {!goal.external_ready_ref && !goal.latest_marker && (
              <div style={{ ...mono, color: COLORS.muted }}>
                No Go-level proof pointer is projected at this cut.
              </div>
            )}
          </>
        )}
        {tab === 'relations' && (
          <>
            {row('mission', mission?.title || goal.mission_id)}
            {row('parent Go', goal.mission_parent_goal)}
            {row('owner', goal.owner_agent)}
            {row('lens', goal.lens)}
            {row('track', goal.mission_track)}
          </>
        )}
      </div>
    </aside>
  );
}
