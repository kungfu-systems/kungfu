import type {
  AtlasGoal,
  AtlasMission,
  AtlasMissionControlReport,
} from '@kungfu-tech/api/capability';
import { mono, panelStyle } from '@kungfu-tech/kfx';
import React from 'react';
import {
  type GoalCluster,
  type GoalSection,
  MISSION_CONTROL_VISUAL_SPEC,
  type TrustVisual,
  type VisualTrustState,
  buildGoalClusters,
  deriveTrustVisual,
  goalStatusGlyph,
  missionIntent,
  missionStage,
  responsibilityActions,
} from './mission-visual-model';

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
  report: AtlasMissionControlReport | null;
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
            {expanded ? '▾' : '▸'} {children.length} child Go
            {children.length === 1 ? '' : 's'} · {completed}/
            {cluster.members.length} closed
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
  onSelectGoal,
}: {
  goals: AtlasGoal[];
  selectedGoalId: string | null;
  trustByGoal: Readonly<Record<string, VisualTrustState>>;
  onSelectGoal: (goalId: string) => void;
}) {
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
  const clusters = React.useMemo(
    () => buildGoalClusters(goals, trustByGoal),
    [goals, trustByGoal],
  );
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

type DetailTab = 'summary' | 'timeline' | 'trust' | 'evidence' | 'relations';

export function GoalDetailDrawer({
  goal,
  mission,
  trust,
  onClose,
  onClaimCompletion,
}: {
  goal: AtlasGoal;
  mission: AtlasMission | null;
  trust: TrustVisual;
  onClose: () => void;
  onClaimCompletion: () => void;
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
        <button type="button" onClick={onClose} style={compactButton()}>
          close
        </button>
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
            {row('goal id', goal.goal_id)}
            {row('stage', goal.mission_stage)}
            {row('role', goal.mission_role)}
            {row('importance', goal.mission_importance)}
            {row('track', goal.mission_track)}
          </>
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
