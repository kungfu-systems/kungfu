import type {
  WorkControlAssignment,
  WorkControlAuthorityReport,
  WorkControlInitiative,
} from './work-control-profile';
import type { AssignmentCardQuerySpec } from './work-control-query';

export const WORK_CONTROL_VISUAL_SPEC = {
  schema: 'kungfu.work-control.visual-spec/v1',
  semanticOwner: 'kungfu.work-control.query-profile/v1',
  defaultMode: 'situation',
  trajectory: {
    undeclaredFuture: 'visible',
    syntheticMilestones: 'forbidden',
    percentageWithoutDenominator: 'forbidden',
  },
  assignments: {
    layout: 'responsive-card-field',
    hierarchy: 'initiative-parent-assignment-cluster',
    criticalChildPropagation: true,
  },
  trust: {
    source: 'purpose-bound-kfd-2-report',
    scalarScore: 'forbidden',
    initiativeInheritanceForAssignment: 'forbidden',
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
  report: WorkControlAuthorityReport | null,
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
  report: WorkControlAuthorityReport | null,
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

export type AssignmentSection =
  | 'attention'
  | 'in-motion'
  | 'delegated'
  | 'closed';

export type AssignmentClusterMember = {
  assignment: WorkControlAssignment;
  depth: number;
};

export type AssignmentCluster = {
  key: string;
  parent: WorkControlAssignment;
  members: AssignmentClusterMember[];
  section: AssignmentSection;
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

export function classifyAssignmentCluster(
  members: AssignmentClusterMember[],
  trustByAssignment: Readonly<Record<string, VisualTrustState>> = {},
): AssignmentSection {
  const statuses = members.map(({ assignment }) =>
    assignment.archived ? 'archived' : (assignment.status ?? 'unknown'),
  );
  const trustStates = members.map(
    ({ assignment }) =>
      trustByAssignment[assignment.assignment_id] ?? 'unknown',
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

export function buildAssignmentClusters(
  assignments: WorkControlAssignment[],
  trustByAssignment: Readonly<Record<string, VisualTrustState>> = {},
): AssignmentCluster[] {
  const byId = new Map(
    assignments.map((assignment) => [assignment.assignment_id, assignment]),
  );
  const children = new Map<string, WorkControlAssignment[]>();
  for (const assignment of assignments) {
    const parent = assignment.parent_assignment_id;
    if (!parent || !byId.has(parent) || parent === assignment.assignment_id)
      continue;
    const rows = children.get(parent) ?? [];
    rows.push(assignment);
    children.set(parent, rows);
  }
  for (const rows of children.values()) {
    rows.sort((left, right) =>
      left.assignment_id.localeCompare(right.assignment_id),
    );
  }

  const roots = assignments
    .filter((assignment) => {
      const parent = assignment.parent_assignment_id;
      return (
        !parent || !byId.has(parent) || parent === assignment.assignment_id
      );
    })
    .sort((left, right) =>
      left.assignment_id.localeCompare(right.assignment_id),
    );
  const visited = new Set<string>();
  const clusters: AssignmentCluster[] = [];

  const collect = (
    assignment: WorkControlAssignment,
    depth: number,
    members: AssignmentClusterMember[],
  ) => {
    if (visited.has(assignment.assignment_id)) return;
    visited.add(assignment.assignment_id);
    members.push({ assignment, depth });
    for (const child of children.get(assignment.assignment_id) ?? []) {
      collect(child, depth + 1, members);
    }
  };

  const appendCluster = (parent: WorkControlAssignment) => {
    const members: AssignmentClusterMember[] = [];
    collect(parent, 0, members);
    clusters.push({
      key: parent.assignment_id,
      parent,
      members,
      section: classifyAssignmentCluster(members, trustByAssignment),
    });
  };
  roots.forEach(appendCluster);
  assignments
    .filter((assignment) => !visited.has(assignment.assignment_id))
    .sort((left, right) =>
      left.assignment_id.localeCompare(right.assignment_id),
    )
    .forEach(appendCluster);
  return clusters;
}

function isClosedAssignment(assignment: WorkControlAssignment): boolean {
  return Boolean(
    assignment.archived || CLOSED_STATUSES.has(assignment.status ?? ''),
  );
}

function assignmentSearchText(assignment: WorkControlAssignment): string {
  return [
    assignment.assignment_id,
    assignment.title,
    assignment.summary,
    assignment.responsibility,
    assignment.next_action,
    assignment.owner_agent,
    assignment.initiative_track,
    assignment.initiative_role,
    assignment.initiative_stage,
    assignment.status,
  ]
    .filter(Boolean)
    .join('\n')
    .toLocaleLowerCase();
}

function includesOrEmpty(values: string[], actual = ''): boolean {
  return values.length === 0 || values.includes(actual);
}

function memberMatches(
  assignment: WorkControlAssignment,
  query: AssignmentCardQuerySpec,
  trustByAssignment: Readonly<Record<string, VisualTrustState>>,
  asOfMs: number,
): boolean {
  const closed = isClosedAssignment(assignment);
  if (query.closed === 'exclude' && closed) return false;
  if (query.closed === 'only' && !closed) return false;
  if (
    query.text.trim() &&
    !assignmentSearchText(assignment).includes(
      query.text.trim().toLocaleLowerCase(),
    )
  ) {
    return false;
  }
  if (!includesOrEmpty(query.statuses, assignment.status)) return false;
  if (
    !includesOrEmpty(
      query.trust,
      trustByAssignment[assignment.assignment_id] ?? 'unknown',
    )
  ) {
    return false;
  }
  if (!includesOrEmpty(query.actors, assignment.owner_agent)) return false;
  if (!includesOrEmpty(query.tracks, assignment.initiative_track)) return false;
  if (!includesOrEmpty(query.roles, assignment.initiative_role)) return false;
  if (!includesOrEmpty(query.importance, assignment.initiative_importance))
    return false;
  if (!includesOrEmpty(query.stages, assignment.initiative_stage)) return false;
  if (query.updatedWithinDays !== null) {
    const updated = Date.parse(assignment.updated_at ?? '');
    const windowMs = query.updatedWithinDays * 86_400_000;
    if (!Number.isFinite(updated) || updated < asOfMs - windowMs) return false;
  }
  return true;
}

const SECTION_PRIORITY: Record<AssignmentSection, number> = {
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

function clusterImportance(cluster: AssignmentCluster): number {
  return Math.max(
    0,
    ...cluster.members.map(
      ({ assignment }) =>
        IMPORTANCE_PRIORITY[assignment.initiative_importance ?? ''] ?? 0,
    ),
  );
}

function clusterTrustRisk(
  cluster: AssignmentCluster,
  trustByAssignment: Readonly<Record<string, VisualTrustState>>,
): number {
  return Math.max(
    0,
    ...cluster.members.map(
      ({ assignment }) =>
        TRUST_RISK_PRIORITY[
          trustByAssignment[assignment.assignment_id] ?? 'unknown'
        ],
    ),
  );
}

function clusterUpdated(cluster: AssignmentCluster): number {
  return Math.max(
    0,
    ...cluster.members.map(
      ({ assignment }) => Date.parse(assignment.updated_at ?? '') || 0,
    ),
  );
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

function compareClusters(
  left: AssignmentCluster,
  right: AssignmentCluster,
  query: AssignmentCardQuerySpec,
  trustByAssignment: Readonly<Record<string, VisualTrustState>>,
): number {
  const direction = query.sort.direction === 'desc' ? -1 : 1;
  let value = 0;
  switch (query.sort.field) {
    case 'decision-priority': {
      const fields: Array<[number, number]> = [
        [SECTION_PRIORITY[left.section], SECTION_PRIORITY[right.section]],
        [
          clusterTrustRisk(left, trustByAssignment),
          clusterTrustRisk(right, trustByAssignment),
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
        clusterTrustRisk(left, trustByAssignment) -
        clusterTrustRisk(right, trustByAssignment);
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
        left.parent.title || left.parent.assignment_id,
        right.parent.title || right.parent.assignment_id,
      );
      break;
  }
  return value === 0 ? compareText(left.key, right.key) : value * direction;
}

export function queryAssignmentClusters(
  assignments: WorkControlAssignment[],
  query: AssignmentCardQuerySpec,
  trustByAssignment: Readonly<Record<string, VisualTrustState>> = {},
  asOfMs = Date.now(),
): AssignmentCluster[] {
  const clusters = buildAssignmentClusters(assignments, trustByAssignment);
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
      const matching = cluster.members.filter(({ assignment }) =>
        memberMatches(assignment, query, trustByAssignment, asOfMs),
      );
      if (matching.length === 0) return null;
      const parentMatches = matching.some(
        ({ assignment }) =>
          assignment.assignment_id === cluster.parent.assignment_id,
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
          ({ assignment, depth }) =>
            depth === 0 || !isClosedAssignment(assignment),
        );
      }
      return { ...cluster, members, matchCount: matching.length };
    })
    .filter((cluster): cluster is AssignmentCluster => cluster !== null)
    .sort((left, right) =>
      compareClusters(left, right, query, trustByAssignment),
    );
}

export function initiativeIntent(
  initiative: WorkControlInitiative | null,
): string {
  if (!initiative) return '';
  return (
    initiative.north_star ||
    initiative.intent ||
    initiative.why_it_matters ||
    ''
  ).trim();
}

export function initiativeStage(
  initiative: WorkControlInitiative | null,
): string {
  return initiative?.stage_name?.trim() || 'Undeclared stage';
}

export function assignmentStatusGlyph(status = 'unknown'): string {
  if (status === 'blocked') return '!';
  if (CLOSED_STATUSES.has(status)) return '✓';
  if (MOTION_STATUSES.has(status)) return '●';
  if (DELEGATED_STATUSES.has(status)) return '◐';
  return '○';
}
