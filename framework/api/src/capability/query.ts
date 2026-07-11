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
  object: string;
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
export type QueryViewSpec =
  | TableViewSpec
  | TimelineViewSpec
  | DiffViewSpec
  | CausalGraphViewSpec
  | AttentionViewSpec;

export type SavedQueryView = {
  schema: 'kungfu.query.saved-view/v1';
  name: string;
  definition: QueryDefinition;
  view: QueryViewSpec;
};

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
    !['table', 'timeline', 'diff', 'causal-graph', 'attention'].includes(
      saved.view.kind,
    )
  ) {
    throw new Error('saved query view requires a supported ViewSpec');
  }
  if (typeof saved.name !== 'string' || saved.name.length === 0) {
    throw new Error('saved query view requires a name');
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
