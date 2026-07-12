// ADR-0048 public query/changelog/view contracts. QueryDefinition remains
// the semantic owner; ViewSpec only selects a presentation of returned rows.

export type QueryEventPredicate = {
  field: string;
  equals: string;
};

export type QueryTemporalPattern = {
  schema: 'kungfu.query.temporal-pattern/v1';
  partition_by: string;
  order_by: string;
  sequence: [QueryEventPredicate, QueryEventPredicate];
  repeat: { min: number; max: number };
  within_ns: string;
  as_of_time: string;
  absence?: QueryEventPredicate;
};

export type QueryDefinition = {
  schema: 'kungfu.query.definition/v1';
  basis: Record<string, unknown>;
  object: 'episodes' | 'fact-state';
  subject_keys?: string[];
  limit: number;
  evidence: string;
  temporal_pattern?: QueryTemporalPattern;
};

export type QueryFrontier =
  | { kind: 'empty'; record_count: string }
  | {
      kind: 'manifest_frame_uid';
      manifest_frame_uid: string;
      record_count: string;
    }
  | {
      kind: 'system_time';
      system_time: string;
      record_count: string;
    };

export type QueryResultSchema = {
  schema: string;
  fields: { name: string; type: string; nullable: boolean }[];
};

export type QueryResumeToken = {
  schema: 'kungfu.query.resume-token/v1';
  definition: QueryDefinition;
  query_definition_hash: string;
  logical_plan_hash: string;
  from: QueryFrontier;
  from_result_hash: string;
  target: QueryFrontier;
  target_result_hash: string;
  next_message_index: number;
  batch_id: string;
  token_hash: string;
};

type ChangelogEnvelope = { message_id: string; index: number };

export type QueryChangelogMessage = ChangelogEnvelope &
  (
    | {
        type: 'SnapshotBegin';
        basis: Record<string, unknown>;
        result_schema: QueryResultSchema;
      }
    | {
        type: 'RowUpsert';
        key: string;
        row: Record<string, unknown>;
        evidence_ref: Record<string, unknown>;
      }
    | {
        type: 'RowRetract';
        key: string;
        before_hash: string;
        evidence_ref: Record<string, unknown>;
      }
    | {
        type: 'Progress';
        frontier: QueryFrontier;
        watermark: Record<string, unknown>;
      }
    | {
        type: 'SchemaChange';
        old_schema: QueryResultSchema;
        new_schema: QueryResultSchema;
        compatibility: string;
      }
    | {
        type: 'SnapshotEnd';
        result_hash: string;
        frontier: QueryFrontier;
      }
    | {
        type: 'Gap';
        expected: Record<string, unknown>;
        observed: Record<string, unknown>;
        recovery_hint: string;
      }
  );

export type QueryChangelogPage = {
  schema: 'kungfu.query.changelog/v1';
  batch_id: string;
  messages: QueryChangelogMessage[];
  resume_token: QueryResumeToken;
  complete: boolean;
};

export type TableViewSpec = {
  kind: 'table';
  columns: string[];
};
export type TimelineViewSpec = {
  kind: 'timeline';
  timeField: string;
  laneField?: string;
  labelField: string;
};
export type DiffViewSpec = {
  kind: 'diff';
  keyField: string;
  fields: string[];
};
export type CausalGraphViewSpec = {
  kind: 'causal-graph';
  idField: string;
  parentField: string;
  labelField: string;
};
export type AttentionViewSpec = {
  kind: 'attention';
  partitionField: string;
  repeatField: string;
  elapsedField: string;
  attributionField: string;
  evidenceField: string;
};
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
export type MissionControlViewSpec = {
  kind: 'mission-control';
  profileId: 'kungfu.mission-control';
  profileVersion: '1';
  questionId:
    | 'mission-intent'
    | 'observed-progress'
    | 'evidence-at-cut'
    | 'fitness-for-purpose'
    | 'next-responsibility';
  reducer: 'kungfu.mission-control.reducer/v1';
  goalCards?: GoalCardQuerySpec;
};
export type QueryViewSpec =
  | TableViewSpec
  | TimelineViewSpec
  | DiffViewSpec
  | CausalGraphViewSpec
  | AttentionViewSpec
  | MissionControlViewSpec;

export type GenericQueryViewSpec = Exclude<
  QueryViewSpec,
  MissionControlViewSpec
>;

export type SavedQueryView = {
  schema: 'kungfu.query.saved-view/v1';
  name: string;
  definition: QueryDefinition;
  view: QueryViewSpec;
};

export type SavedQueryEntry = {
  schema: 'kungfu.query.saved-query-entry/v1';
  query_id: string;
  revision: number;
  previous_revision: number;
  state: 'active' | 'deleted';
  event_id: string;
  system_time: number;
  saved_view_hash: string;
  journal_frame_uid: number;
  saved_view: SavedQueryView;
};

export type SavedQueryCatalog = {
  schema: 'kungfu.query.saved-query-catalog/v1';
  runtime_dir: string;
  entries: SavedQueryEntry[];
  count: number;
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

const GOAL_CARD_SECTIONS: ReadonlySet<string> = new Set(
  DEFAULT_GOAL_CARD_QUERY.sections.concat([
    'attention',
    'in-motion',
    'delegated',
    'closed',
  ]),
);
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

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`goal card query ${label} must be a string array`);
  }
  return [...new Set(value as string[])];
}

export function parseGoalCardQuerySpec(value: unknown): GoalCardQuerySpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('goal card query must be an object');
  }
  const query = value as Partial<GoalCardQuerySpec>;
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

export type QueryChangelogState = {
  rows: Record<string, Record<string, unknown>>;
  evidence: Record<string, Record<string, unknown>>;
  changes: Record<
    string,
    {
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    }
  >;
  appliedMessageIds: string[];
  resultSchema: QueryResultSchema | null;
  frontier: QueryFrontier;
  resultHash: string;
  gap: Extract<QueryChangelogMessage, { type: 'Gap' }> | null;
};

export function emptyQueryChangelogState(): QueryChangelogState {
  return {
    rows: {},
    evidence: {},
    changes: {},
    appliedMessageIds: [],
    resultSchema: null,
    frontier: { kind: 'empty', record_count: '0' },
    resultHash: '',
    gap: null,
  };
}

function frontierValue(frontier: QueryFrontier): bigint {
  return BigInt(frontier.record_count);
}

export function applyQueryChangelogPage(
  current: QueryChangelogState,
  page: QueryChangelogPage,
): QueryChangelogState {
  const state: QueryChangelogState = {
    ...current,
    rows: { ...current.rows },
    evidence: { ...current.evidence },
    changes: { ...current.changes },
    appliedMessageIds: [...current.appliedMessageIds],
  };
  const applied = new Set(state.appliedMessageIds);
  for (const message of page.messages) {
    if (applied.has(message.message_id)) continue;
    if (state.gap) break;
    switch (message.type) {
      case 'SnapshotBegin':
        state.rows = {};
        state.evidence = {};
        state.changes = {};
        state.resultSchema = message.result_schema;
        state.resultHash = '';
        break;
      case 'RowUpsert':
        state.changes[message.key] = {
          before: state.rows[message.key] ?? null,
          after: message.row,
        };
        state.rows[message.key] = message.row;
        state.evidence[message.key] = message.evidence_ref;
        break;
      case 'RowRetract':
        state.changes[message.key] = {
          before: state.rows[message.key] ?? null,
          after: null,
        };
        delete state.rows[message.key];
        state.evidence[message.key] = message.evidence_ref;
        break;
      case 'SchemaChange':
        state.resultSchema = message.new_schema;
        break;
      case 'SnapshotEnd':
        if (frontierValue(message.frontier) < frontierValue(state.frontier)) {
          throw new Error('query changelog frontier regressed');
        }
        state.frontier = message.frontier;
        state.resultHash = message.result_hash;
        break;
      case 'Progress':
        if (frontierValue(message.frontier) < frontierValue(state.frontier)) {
          throw new Error('query changelog frontier regressed');
        }
        state.frontier = message.frontier;
        break;
      case 'Gap':
        state.gap = message;
        break;
    }
    applied.add(message.message_id);
    state.appliedMessageIds.push(message.message_id);
  }
  return state;
}

export function parseSavedQueryView(value: unknown): SavedQueryView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('saved query view must be an object');
  }
  const saved = value as Partial<SavedQueryView>;
  if (saved.schema !== 'kungfu.query.saved-view/v1') {
    throw new Error('unsupported saved query view schema');
  }
  if (
    !saved.definition ||
    saved.definition.schema !== 'kungfu.query.definition/v1'
  ) {
    throw new Error('saved query view requires a QueryDefinition');
  }
  if (
    !saved.view ||
    ![
      'table',
      'timeline',
      'diff',
      'causal-graph',
      'attention',
      'mission-control',
    ].includes(saved.view.kind)
  ) {
    throw new Error('saved query view requires a supported ViewSpec');
  }
  if (typeof saved.name !== 'string' || saved.name.length === 0) {
    throw new Error('saved query view requires a name');
  }
  if (saved.view.kind === 'mission-control' && saved.view.goalCards) {
    saved.view.goalCards = parseGoalCardQuerySpec(saved.view.goalCards);
  }
  return saved as SavedQueryView;
}

export function queryRows(
  state: QueryChangelogState,
): Record<string, unknown>[] {
  return Object.entries(state.rows)
    .sort(([left], [right]) =>
      left.localeCompare(right, undefined, { numeric: true }),
    )
    .map(([, row]) => row);
}
