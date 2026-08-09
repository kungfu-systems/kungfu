import type { ProfileQueryViewSpec } from '@kungfu-tech/kfx';

export type AssignmentCardQuerySpec = {
  schema: 'kungfu.work-control.assignment-card-query/v1';
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

export type WorkControlAssignmentCardViewSpec = ProfileQueryViewSpec & {
  profileId: 'kungfu.work-control';
  memberId: 'work-control-views';
  viewId: 'assignment-cards';
  spec: {
    schema: 'kungfu.work-control.assignment-card-view/v1';
    questionId: 'observed-progress';
    reducer: 'kungfu.work-control.five-questions';
    assignmentCards: AssignmentCardQuerySpec;
  };
};

export const DEFAULT_ASSIGNMENT_CARD_QUERY: AssignmentCardQuerySpec = {
  schema: 'kungfu.work-control.assignment-card-query/v1',
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

const ASSIGNMENT_CARD_SECTIONS = new Set([
  'attention',
  'in-motion',
  'delegated',
  'closed',
]);
const ASSIGNMENT_CARD_TRUST = new Set([
  'established',
  'partial',
  'attention',
  'stale',
  'unknown',
]);
const ASSIGNMENT_CARD_SORTS = new Set([
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
    throw new Error(`assignment card query ${label} must be a string array`);
  }
  return [...new Set(value as string[])];
}

export function parseAssignmentCardQuerySpec(
  value: unknown,
): AssignmentCardQuerySpec {
  const query = objectValue(value) as Partial<AssignmentCardQuerySpec> | null;
  if (!query) throw new Error('assignment card query must be an object');
  if (query.schema !== 'kungfu.work-control.assignment-card-query/v1') {
    throw new Error('unsupported assignment card query schema');
  }
  const sections = stringList(query.sections, 'sections');
  const trust = stringList(query.trust, 'trust');
  if (sections.some((item) => !ASSIGNMENT_CARD_SECTIONS.has(item))) {
    throw new Error('assignment card query contains an unsupported section');
  }
  if (trust.some((item) => !ASSIGNMENT_CARD_TRUST.has(item))) {
    throw new Error(
      'assignment card query contains an unsupported trust state',
    );
  }
  if (!query.sort || !ASSIGNMENT_CARD_SORTS.has(query.sort.field)) {
    throw new Error('assignment card query requires a supported sort field');
  }
  if (!['asc', 'desc'].includes(query.sort.direction)) {
    throw new Error(
      'assignment card query requires asc or desc sort direction',
    );
  }
  if (!['all', 'yes', 'no'].includes(query.hasChildren ?? '')) {
    throw new Error('assignment card query requires a valid hasChildren value');
  }
  if (!['include', 'exclude', 'only'].includes(query.closed ?? '')) {
    throw new Error('assignment card query requires a valid closed value');
  }
  if (
    query.updatedWithinDays !== null &&
    (typeof query.updatedWithinDays !== 'number' ||
      !Number.isFinite(query.updatedWithinDays) ||
      query.updatedWithinDays < 0)
  ) {
    throw new Error(
      'assignment card query updatedWithinDays must be null or non-negative',
    );
  }
  if (typeof query.text !== 'string') {
    throw new Error('assignment card query text must be a string');
  }
  if (typeof query.hideClosedChildren !== 'boolean') {
    throw new Error('assignment card query hideClosedChildren must be boolean');
  }
  return {
    schema: query.schema,
    text: query.text,
    sections: sections as AssignmentCardQuerySpec['sections'],
    statuses: stringList(query.statuses, 'statuses'),
    trust: trust as AssignmentCardQuerySpec['trust'],
    actors: stringList(query.actors, 'actors'),
    tracks: stringList(query.tracks, 'tracks'),
    roles: stringList(query.roles, 'roles'),
    importance: stringList(query.importance, 'importance'),
    stages: stringList(query.stages, 'stages'),
    updatedWithinDays: query.updatedWithinDays as number | null,
    hasChildren: query.hasChildren as AssignmentCardQuerySpec['hasChildren'],
    closed: query.closed as AssignmentCardQuerySpec['closed'],
    hideClosedChildren: query.hideClosedChildren,
    sort: { ...query.sort },
  };
}

export function workControlAssignmentCardView(
  profileVersion: string,
  assignmentCards: AssignmentCardQuerySpec,
): WorkControlAssignmentCardViewSpec {
  return {
    kind: 'profile',
    profileId: 'kungfu.work-control',
    profileVersion,
    memberId: 'work-control-views',
    viewId: 'assignment-cards',
    spec: {
      schema: 'kungfu.work-control.assignment-card-view/v1',
      questionId: 'observed-progress',
      reducer: 'kungfu.work-control.five-questions',
      assignmentCards: parseAssignmentCardQuerySpec(assignmentCards),
    },
  };
}

export function assignmentCardQueryFromView(
  value: unknown,
): AssignmentCardQuerySpec | null {
  const view = objectValue(value);
  if (!view) return null;
  if (view.profileId !== 'kungfu.work-control') return null;
  if (view.kind === 'profile') {
    if (
      view.memberId !== 'work-control-views' ||
      view.viewId !== 'assignment-cards'
    ) {
      return null;
    }
    const spec = objectValue(view.spec);
    if (spec?.schema !== 'kungfu.work-control.assignment-card-view/v1') {
      throw new Error('unsupported Work Control assignment-card view schema');
    }
    if (
      spec.questionId !== 'observed-progress' ||
      spec.reducer !== 'kungfu.work-control.five-questions'
    ) {
      throw new Error('unsupported Work Control assignment-card view contract');
    }
    return parseAssignmentCardQuerySpec(spec.assignmentCards);
  }
  return null;
}
