import type {
  AtlasGoal,
  AtlasMission,
  AtlasMissionControlReport,
  GoalCardQuerySpec,
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
  matchCount?: number;
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

function isClosedGoal(goal: AtlasGoal): boolean {
  return Boolean(goal.archived || CLOSED_STATUSES.has(goal.status ?? ''));
}

function goalSearchText(goal: AtlasGoal): string {
  return [
    goal.goal_id,
    goal.title,
    goal.summary,
    goal.mission_why_matters,
    goal.next_action,
    goal.owner_agent,
    goal.mission_track,
    goal.mission_role,
    goal.mission_stage,
    goal.status,
  ]
    .filter(Boolean)
    .join('\n')
    .toLocaleLowerCase();
}

function includesOrEmpty(values: string[], actual = ''): boolean {
  return values.length === 0 || values.includes(actual);
}

function memberMatches(
  goal: AtlasGoal,
  query: GoalCardQuerySpec,
  trustByGoal: Readonly<Record<string, VisualTrustState>>,
  asOfMs: number,
): boolean {
  const closed = isClosedGoal(goal);
  if (query.closed === 'exclude' && closed) return false;
  if (query.closed === 'only' && !closed) return false;
  if (
    query.text.trim() &&
    !goalSearchText(goal).includes(query.text.trim().toLocaleLowerCase())
  ) {
    return false;
  }
  if (!includesOrEmpty(query.statuses, goal.status)) return false;
  if (!includesOrEmpty(query.trust, trustByGoal[goal.goal_id] ?? 'unknown')) {
    return false;
  }
  if (!includesOrEmpty(query.actors, goal.owner_agent)) return false;
  if (!includesOrEmpty(query.tracks, goal.mission_track)) return false;
  if (!includesOrEmpty(query.roles, goal.mission_role)) return false;
  if (!includesOrEmpty(query.importance, goal.mission_importance)) return false;
  if (!includesOrEmpty(query.stages, goal.mission_stage)) return false;
  if (query.updatedWithinDays !== null) {
    const updated = Date.parse(goal.updated_at ?? '');
    const windowMs = query.updatedWithinDays * 86_400_000;
    if (!Number.isFinite(updated) || updated < asOfMs - windowMs) return false;
  }
  return true;
}

const SECTION_PRIORITY: Record<GoalSection, number> = {
  attention: 4,
  'in-motion': 3,
  delegated: 2,
  closed: 1,
};
const IMPORTANCE_PRIORITY: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};
const TRUST_RISK_PRIORITY: Record<VisualTrustState, number> = {
  attention: 5,
  stale: 4,
  unknown: 3,
  partial: 2,
  established: 1,
};

function clusterImportance(cluster: GoalCluster): number {
  return Math.max(
    0,
    ...cluster.members.map(
      ({ goal }) => IMPORTANCE_PRIORITY[goal.mission_importance ?? ''] ?? 0,
    ),
  );
}

function clusterTrustRisk(
  cluster: GoalCluster,
  trustByGoal: Readonly<Record<string, VisualTrustState>>,
): number {
  return Math.max(
    0,
    ...cluster.members.map(
      ({ goal }) => TRUST_RISK_PRIORITY[trustByGoal[goal.goal_id] ?? 'unknown'],
    ),
  );
}

function clusterUpdated(cluster: GoalCluster): number {
  return Math.max(
    0,
    ...cluster.members.map(
      ({ goal }) => Date.parse(goal.updated_at ?? '') || 0,
    ),
  );
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

function compareClusters(
  left: GoalCluster,
  right: GoalCluster,
  query: GoalCardQuerySpec,
  trustByGoal: Readonly<Record<string, VisualTrustState>>,
): number {
  const direction = query.sort.direction === 'desc' ? -1 : 1;
  let value = 0;
  switch (query.sort.field) {
    case 'decision-priority': {
      const fields: Array<[number, number]> = [
        [SECTION_PRIORITY[left.section], SECTION_PRIORITY[right.section]],
        [
          clusterTrustRisk(left, trustByGoal),
          clusterTrustRisk(right, trustByGoal),
        ],
        [clusterImportance(left), clusterImportance(right)],
        [clusterUpdated(left), clusterUpdated(right)],
      ];
      for (const [leftValue, rightValue] of fields) {
        if (leftValue !== rightValue)
          return (leftValue - rightValue) * direction;
      }
      break;
    }
    case 'updated':
      value = clusterUpdated(left) - clusterUpdated(right);
      break;
    case 'importance':
      value = clusterImportance(left) - clusterImportance(right);
      break;
    case 'trust-risk':
      value =
        clusterTrustRisk(left, trustByGoal) -
        clusterTrustRisk(right, trustByGoal);
      break;
    case 'next-actor':
      value = compareText(
        left.parent.owner_agent ?? '',
        right.parent.owner_agent ?? '',
      );
      break;
    case 'lifecycle':
      value = SECTION_PRIORITY[left.section] - SECTION_PRIORITY[right.section];
      break;
    case 'name':
      value = compareText(
        left.parent.title || left.parent.goal_id,
        right.parent.title || right.parent.goal_id,
      );
      break;
  }
  return value === 0 ? compareText(left.key, right.key) : value * direction;
}

export function queryGoalClusters(
  goals: AtlasGoal[],
  query: GoalCardQuerySpec,
  trustByGoal: Readonly<Record<string, VisualTrustState>> = {},
  asOfMs = Date.now(),
): GoalCluster[] {
  const clusters = buildGoalClusters(goals, trustByGoal);
  return clusters
    .filter(
      (cluster) =>
        query.sections.length === 0 || query.sections.includes(cluster.section),
    )
    .filter((cluster) => {
      const hasChildren = cluster.members.length > 1;
      return (
        query.hasChildren === 'all' ||
        (query.hasChildren === 'yes' && hasChildren) ||
        (query.hasChildren === 'no' && !hasChildren)
      );
    })
    .map((cluster) => {
      const matching = cluster.members.filter(({ goal }) =>
        memberMatches(goal, query, trustByGoal, asOfMs),
      );
      if (matching.length === 0) return null;
      const parentMatches = matching.some(
        ({ goal }) => goal.goal_id === cluster.parent.goal_id,
      );
      let members = parentMatches ? cluster.members : matching;
      if (!parentMatches) {
        members = [
          cluster.members[0],
          ...members.filter(({ depth }) => depth > 0),
        ];
      }
      if (query.hideClosedChildren) {
        members = members.filter(
          ({ goal, depth }) => depth === 0 || !isClosedGoal(goal),
        );
      }
      return { ...cluster, members, matchCount: matching.length };
    })
    .filter((cluster): cluster is GoalCluster => cluster !== null)
    .sort((left, right) => compareClusters(left, right, query, trustByGoal));
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
