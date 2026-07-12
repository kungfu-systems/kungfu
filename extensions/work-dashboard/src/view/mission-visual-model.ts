import type {
  AtlasGoal,
  AtlasMission,
  AtlasMissionControlReport,
} from '@kungfu-tech/api/capability';

export const MISSION_CONTROL_VISUAL_SPEC = {
  schema: 'kungfu.mission-control.visual-spec/v1',
  semanticOwner: 'kungfu.mission-control.query-profile/v1',
  defaultMode: 'situation',
  trajectory: {
    undeclaredFuture: 'visible',
    syntheticMilestones: 'forbidden',
    percentageWithoutDenominator: 'forbidden',
  },
  goals: {
    layout: 'responsive-card-field',
    hierarchy: 'mission-parent-goal-cluster',
    criticalChildPropagation: true,
  },
  trust: {
    source: 'purpose-bound-kfd-2-report',
    scalarScore: 'forbidden',
    missionInheritanceForGo: 'forbidden',
  },
  disclosure: {
    questions: 'internal-only',
    summary: 'visible',
    explanation: 'tooltip-or-drawer',
    audit: 'explicit-mode',
  },
} as const;

export type VisualTrustState =
  | 'established'
  | 'partial'
  | 'attention'
  | 'stale'
  | 'unknown';

export type TrustFacet = {
  id: 'claim' | 'assessment' | 'evidence' | 'freshness';
  state: VisualTrustState;
  detail: string;
};

export type TrustVisual = {
  state: VisualTrustState;
  label: string;
  glyph: string;
  facets: TrustFacet[];
  detail: string;
};

const TRUST_LABELS: Record<VisualTrustState, string> = {
  established: 'Established',
  partial: 'Partial',
  attention: 'Attention',
  stale: 'Stale',
  unknown: 'Unknown',
};

const TRUST_GLYPHS: Record<VisualTrustState, string> = {
  established: '◆',
  partial: '◒',
  attention: '!',
  stale: '↻',
  unknown: '?',
};

function trustFacet(
  id: TrustFacet['id'],
  state: VisualTrustState,
  detail: string,
): TrustFacet {
  return { id, state, detail };
}

export function deriveTrustVisual(
  report: AtlasMissionControlReport | null,
  error = '',
): TrustVisual {
  if (error) {
    return {
      state: 'attention',
      label: TRUST_LABELS.attention,
      glyph: TRUST_GLYPHS.attention,
      facets: [
        trustFacet('claim', 'unknown', 'Claim binding unavailable'),
        trustFacet('assessment', 'attention', error),
        trustFacet('evidence', 'unknown', 'Evidence was not resolved'),
        trustFacet('freshness', 'unknown', 'No assessment cut is available'),
      ],
      detail: error,
    };
  }
  if (!report) {
    return {
      state: 'unknown',
      label: TRUST_LABELS.unknown,
      glyph: TRUST_GLYPHS.unknown,
      facets: [
        trustFacet('claim', 'unknown', 'No purpose-bound report is loaded'),
        trustFacet('assessment', 'unknown', 'No assessment is loaded'),
        trustFacet('evidence', 'unknown', 'Evidence has not been evaluated'),
        trustFacet('freshness', 'unknown', 'No assessment cut is available'),
      ],
      detail: 'No purpose-bound KFD-2 TrustReport is loaded.',
    };
  }

  const assessmentState = String(report.assessment.state || 'unknown');
  const stale = /stale|invalidated|expired/i.test(assessmentState);
  const conflicts = report.profile.proof.conflicts.length;
  const unverifiable = report.profile.proof.unverifiable_inputs.length;
  const canonical =
    report.state.canonical_state && report.profile.proof.canonical_state;
  let state: VisualTrustState;
  if (stale) state = 'stale';
  else if (!canonical || conflicts > 0 || unverifiable > 0) state = 'attention';
  else if (report.fitness === 'fit') state = 'established';
  else if (report.fitness === 'warning') state = 'partial';
  else state = 'attention';

  const detail = [
    `fitness ${report.fitness}`,
    `assessment ${assessmentState}`,
    canonical ? 'canonical cut' : 'degraded cut',
    conflicts ? `${conflicts} conflict(s)` : '',
    unverifiable ? `${unverifiable} unverifiable input(s)` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    state,
    label: TRUST_LABELS[state],
    glyph: TRUST_GLYPHS[state],
    facets: [
      trustFacet(
        'claim',
        'established',
        `Bound claim ${report.assessment_key}`,
      ),
      trustFacet(
        'assessment',
        stale ? 'stale' : state === 'attention' ? 'attention' : 'established',
        assessmentState,
      ),
      trustFacet(
        'evidence',
        canonical && conflicts === 0 && unverifiable === 0
          ? 'established'
          : 'attention',
        canonical
          ? `${report.findings.length} finding(s) at a canonical cut`
          : 'The query cut is degraded',
      ),
      trustFacet(
        'freshness',
        stale ? 'stale' : 'established',
        stale ? assessmentState : 'The report is bound to its recorded cut',
      ),
    ],
    detail,
  };
}

export type ResponsibilityAction = {
  actor: string;
  subject: string;
  action: string;
  source: string;
};

export function responsibilityActions(
  report: AtlasMissionControlReport | null,
): ResponsibilityAction[] {
  const answer = report?.query_profile?.answers.find(
    (row) => row.question_id === 'next-responsibility',
  );
  const values = answer?.data.declared_actions;
  if (!Array.isArray(values)) return [];
  return values
    .filter(
      (value): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null,
    )
    .map((value) => ({
      actor: String(value.actor ?? ''),
      subject: String(value.subject ?? ''),
      action: String(value.action ?? ''),
      source: String(value.source ?? ''),
    }))
    .filter((value) => value.action);
}

export type GoalSection = 'attention' | 'in-motion' | 'delegated' | 'closed';

export type GoalClusterMember = {
  goal: AtlasGoal;
  depth: number;
};

export type GoalCluster = {
  key: string;
  parent: AtlasGoal;
  members: GoalClusterMember[];
  section: GoalSection;
};

const CLOSED_STATUSES = new Set(['completed', 'done', 'merged', 'archived']);
const MOTION_STATUSES = new Set([
  'active',
  'stage-ready',
  'ready',
  'reviewing',
]);
const DELEGATED_STATUSES = new Set([
  'paused',
  'waiting',
  'waiting-for-decision',
  'proposed',
]);

export function classifyGoalCluster(
  members: GoalClusterMember[],
  trustByGoal: Readonly<Record<string, VisualTrustState>> = {},
): GoalSection {
  const statuses = members.map(({ goal }) =>
    goal.archived ? 'archived' : (goal.status ?? 'unknown'),
  );
  const trustStates = members.map(
    ({ goal }) => trustByGoal[goal.goal_id] ?? 'unknown',
  );
  if (
    statuses.includes('blocked') ||
    trustStates.includes('attention') ||
    trustStates.includes('stale')
  ) {
    return 'attention';
  }
  if (statuses.some((status) => MOTION_STATUSES.has(status)))
    return 'in-motion';
  if (
    statuses.length > 0 &&
    statuses.every((status) => CLOSED_STATUSES.has(status))
  ) {
    return 'closed';
  }
  if (statuses.some((status) => DELEGATED_STATUSES.has(status)))
    return 'delegated';
  return 'delegated';
}

export function buildGoalClusters(
  goals: AtlasGoal[],
  trustByGoal: Readonly<Record<string, VisualTrustState>> = {},
): GoalCluster[] {
  const byId = new Map(goals.map((goal) => [goal.goal_id, goal]));
  const children = new Map<string, AtlasGoal[]>();
  for (const goal of goals) {
    const parent = goal.mission_parent_goal;
    if (!parent || !byId.has(parent) || parent === goal.goal_id) continue;
    const rows = children.get(parent) ?? [];
    rows.push(goal);
    children.set(parent, rows);
  }
  for (const rows of children.values()) {
    rows.sort((left, right) => left.goal_id.localeCompare(right.goal_id));
  }

  const roots = goals
    .filter((goal) => {
      const parent = goal.mission_parent_goal;
      return !parent || !byId.has(parent) || parent === goal.goal_id;
    })
    .sort((left, right) => left.goal_id.localeCompare(right.goal_id));
  const visited = new Set<string>();
  const clusters: GoalCluster[] = [];

  const collect = (
    goal: AtlasGoal,
    depth: number,
    members: GoalClusterMember[],
  ) => {
    if (visited.has(goal.goal_id)) return;
    visited.add(goal.goal_id);
    members.push({ goal, depth });
    for (const child of children.get(goal.goal_id) ?? []) {
      collect(child, depth + 1, members);
    }
  };

  const appendCluster = (parent: AtlasGoal) => {
    const members: GoalClusterMember[] = [];
    collect(parent, 0, members);
    clusters.push({
      key: parent.goal_id,
      parent,
      members,
      section: classifyGoalCluster(members, trustByGoal),
    });
  };
  roots.forEach(appendCluster);
  goals
    .filter((goal) => !visited.has(goal.goal_id))
    .sort((left, right) => left.goal_id.localeCompare(right.goal_id))
    .forEach(appendCluster);
  return clusters;
}

export function missionIntent(mission: AtlasMission | null): string {
  if (!mission) return '';
  return (
    mission.north_star ||
    mission.intent ||
    mission.why_it_matters ||
    ''
  ).trim();
}

export function missionStage(mission: AtlasMission | null): string {
  return mission?.stage_name?.trim() || 'Undeclared stage';
}

export function goalStatusGlyph(status = 'unknown'): string {
  if (status === 'blocked') return '!';
  if (CLOSED_STATUSES.has(status)) return '✓';
  if (MOTION_STATUSES.has(status)) return '●';
  if (DELEGATED_STATUSES.has(status)) return '◐';
  return '○';
}
