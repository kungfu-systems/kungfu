import type { ProfileQueryViewSpec } from '@kungfu-tech/kfx';

export type GoalCardQuerySpec = {
  schema: 'kungfu.mission-control.goal-card-query/v1';
  text: string;
  sections: Array<'attention' | 'in-motion' | 'delegated' | 'closed'>;
  statuses: string[];
  trust: Array<'established' | 'partial' | 'attention' | 'stale' | 'unknown'>;
  actors: string[];
  tracks: string[];
  roles: string[];
  importance: string[];
  stages: string[];
  updatedWithinDays: number | null;
  hasChildren: 'all' | 'yes' | 'no';
  closed: 'include' | 'exclude' | 'only';
  hideClosedChildren: boolean;
  sort: {
    field:
      | 'decision-priority'
      | 'updated'
      | 'importance'
      | 'trust-risk'
      | 'next-actor'
      | 'lifecycle'
      | 'name';
    direction: 'asc' | 'desc';
  };
};

export type MissionControlGoalCardViewSpec = ProfileQueryViewSpec & {
  profileId: 'kungfu.mission-control';
  memberId: 'mission-control-views';
  viewId: 'goal-cards';
  spec: {
    schema: 'kungfu.mission-control.goal-card-view/v1';
    questionId: 'observed-progress';
    reducer: 'kungfu.mission-control.five-questions';
    goalCards: GoalCardQuerySpec;
  };
};

export const DEFAULT_GOAL_CARD_QUERY: GoalCardQuerySpec = {
  schema: 'kungfu.mission-control.goal-card-query/v1',
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
};

const GOAL_CARD_SECTIONS = new Set([
  'attention',
  'in-motion',
  'delegated',
  'closed',
]);
const GOAL_CARD_TRUST = new Set([
  'established',
  'partial',
  'attention',
  'stale',
  'unknown',
]);
const GOAL_CARD_SORTS = new Set([
  'decision-priority',
  'updated',
  'importance',
  'trust-risk',
  'next-actor',
  'lifecycle',
  'name',
]);

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`goal card query ${label} must be a string array`);
  }
  return [...new Set(value as string[])];
}

export function parseGoalCardQuerySpec(value: unknown): GoalCardQuerySpec {
  const query = objectValue(value) as Partial<GoalCardQuerySpec> | null;
  if (!query) throw new Error('goal card query must be an object');
  if (query.schema !== 'kungfu.mission-control.goal-card-query/v1') {
    throw new Error('unsupported goal card query schema');
  }
  const sections = stringList(query.sections, 'sections');
  const trust = stringList(query.trust, 'trust');
  if (sections.some((item) => !GOAL_CARD_SECTIONS.has(item))) {
    throw new Error('goal card query contains an unsupported section');
  }
  if (trust.some((item) => !GOAL_CARD_TRUST.has(item))) {
    throw new Error('goal card query contains an unsupported trust state');
  }
  if (!query.sort || !GOAL_CARD_SORTS.has(query.sort.field)) {
    throw new Error('goal card query requires a supported sort field');
  }
  if (!['asc', 'desc'].includes(query.sort.direction)) {
    throw new Error('goal card query requires asc or desc sort direction');
  }
  if (!['all', 'yes', 'no'].includes(query.hasChildren ?? '')) {
    throw new Error('goal card query requires a valid hasChildren value');
  }
  if (!['include', 'exclude', 'only'].includes(query.closed ?? '')) {
    throw new Error('goal card query requires a valid closed value');
  }
  if (
    query.updatedWithinDays !== null &&
    (typeof query.updatedWithinDays !== 'number' ||
      !Number.isFinite(query.updatedWithinDays) ||
      query.updatedWithinDays < 0)
  ) {
    throw new Error(
      'goal card query updatedWithinDays must be null or non-negative',
    );
  }
  if (typeof query.text !== 'string') {
    throw new Error('goal card query text must be a string');
  }
  if (typeof query.hideClosedChildren !== 'boolean') {
    throw new Error('goal card query hideClosedChildren must be boolean');
  }
  return {
    schema: query.schema,
    text: query.text,
    sections: sections as GoalCardQuerySpec['sections'],
    statuses: stringList(query.statuses, 'statuses'),
    trust: trust as GoalCardQuerySpec['trust'],
    actors: stringList(query.actors, 'actors'),
    tracks: stringList(query.tracks, 'tracks'),
    roles: stringList(query.roles, 'roles'),
    importance: stringList(query.importance, 'importance'),
    stages: stringList(query.stages, 'stages'),
    updatedWithinDays: query.updatedWithinDays as number | null,
    hasChildren: query.hasChildren as GoalCardQuerySpec['hasChildren'],
    closed: query.closed as GoalCardQuerySpec['closed'],
    hideClosedChildren: query.hideClosedChildren,
    sort: { ...query.sort },
  };
}

export function missionControlGoalCardView(
  profileVersion: string,
  goalCards: GoalCardQuerySpec,
): MissionControlGoalCardViewSpec {
  return {
    kind: 'profile',
    profileId: 'kungfu.mission-control',
    profileVersion,
    memberId: 'mission-control-views',
    viewId: 'goal-cards',
    spec: {
      schema: 'kungfu.mission-control.goal-card-view/v1',
      questionId: 'observed-progress',
      reducer: 'kungfu.mission-control.five-questions',
      goalCards: parseGoalCardQuerySpec(goalCards),
    },
  };
}

export function goalCardQueryFromView(
  value: unknown,
): GoalCardQuerySpec | null {
  const view = objectValue(value);
  if (!view || view.profileId !== 'kungfu.mission-control') return null;
  if (view.kind === 'profile') {
    if (
      view.memberId !== 'mission-control-views' ||
      view.viewId !== 'goal-cards'
    ) {
      return null;
    }
    const spec = objectValue(view.spec);
    if (spec?.schema !== 'kungfu.mission-control.goal-card-view/v1') {
      throw new Error('unsupported Mission Control goal-card view schema');
    }
    if (
      spec.questionId !== 'observed-progress' ||
      spec.reducer !== 'kungfu.mission-control.five-questions'
    ) {
      throw new Error('unsupported Mission Control goal-card view contract');
    }
    return parseGoalCardQuerySpec(spec.goalCards);
  }
  // 4.0-alpha compatibility: legacy domain ViewSpecs remain readable and are
  // migrated to the generic Profile envelope on the next explicit save.
  return view.goalCards ? parseGoalCardQuerySpec(view.goalCards) : null;
}
