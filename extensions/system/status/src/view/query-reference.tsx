import {
  type GenericQueryViewSpec,
  type KfxCapabilities,
  type QueryChangelogState,
  type QueryResumeToken,
  type QueryViewSpec,
  type SavedQueryEntry,
  type SavedQueryView,
  type SavedQueryViewInspection,
  applyQueryChangelogPage,
  emptyQueryChangelogState,
  headingStyle,
  inspectSavedQueryView,
  mono,
  panelStyle,
  queryRows,
} from '@kungfu-tech/kfx';
import { GenericQueryView } from '@kungfu-tech/kfx/query-view';
import React from 'react';

function cell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function evidenceLabel(state: QueryChangelogState, key: string): string {
  const evidence = state.evidence[key];
  if (!evidence) return 'missing evidence';
  const status = String(evidence.content_root_status ?? 'unverifiable');
  const determinism = String(evidence.determinism ?? 'unverifiable');
  return `${status} · ${determinism}`;
}

function rowKey(row: Record<string, unknown>): string {
  return String(row.match_id ?? row.episode_id ?? 'unknown');
}

export function QueryTableReference({
  state,
  spec,
}: {
  state: QueryChangelogState;
  spec: Extract<QueryViewSpec, { kind: 'table' }>;
}) {
  const rows = queryRows(state);
  return (
    <table style={{ ...mono, borderCollapse: 'collapse', width: '100%' }}>
      <thead>
        <tr>
          {spec.columns.map((column) => (
            <th key={column} style={{ textAlign: 'left', padding: 4 }}>
              {column}
            </th>
          ))}
          <th style={{ textAlign: 'left', padding: 4 }}>evidence</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const key = rowKey(row);
          return (
            <tr key={key}>
              {spec.columns.map((column) => (
                <td
                  key={column}
                  style={{ padding: 4, borderTop: '1px solid #333' }}
                >
                  {cell(row[column])}
                </td>
              ))}
              <td
                style={{
                  padding: 4,
                  borderTop: '1px solid #333',
                  color: '#dcdcaa',
                }}
              >
                {evidenceLabel(state, key)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function QueryTimelineReference({
  state,
  spec,
}: {
  state: QueryChangelogState;
  spec: Extract<QueryViewSpec, { kind: 'timeline' }>;
}) {
  const rows = queryRows(state).sort((left, right) =>
    cell(left[spec.timeField]).localeCompare(
      cell(right[spec.timeField]),
      undefined,
      {
        numeric: true,
      },
    ),
  );
  return (
    <ol style={{ ...mono, margin: 0, paddingLeft: 24 }}>
      {rows.map((row) => {
        const key = rowKey(row);
        return (
          <li key={key} style={{ padding: '4px 0' }}>
            <span style={{ color: '#9cdcfe' }}>
              {cell(row[spec.timeField])}
            </span>{' '}
            {spec.laneField ? `${cell(row[spec.laneField])} · ` : ''}
            {cell(row[spec.labelField])}{' '}
            <span style={{ color: '#dcdcaa' }}>
              ({evidenceLabel(state, key)})
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function QueryDiffReference({
  state,
  spec,
}: {
  state: QueryChangelogState;
  spec: Extract<QueryViewSpec, { kind: 'diff' }>;
}) {
  return (
    <div style={mono}>
      {Object.entries(state.changes).map(([key, change]) => {
        return (
          <div key={key} style={{ padding: 6, borderBottom: '1px solid #333' }}>
            <strong style={{ color: '#9cdcfe' }}>{key}</strong>
            {spec.fields.map((field) => (
              <div key={field}>
                {field}:{' '}
                <span style={{ color: '#f48771' }}>
                  {cell(change.before?.[field])}
                </span>{' '}
                →{' '}
                <span style={{ color: '#4ec9b0' }}>
                  {cell(change.after?.[field])}
                </span>
              </div>
            ))}
            <div style={{ color: '#dcdcaa' }}>{evidenceLabel(state, key)}</div>
          </div>
        );
      })}
    </div>
  );
}

export function QueryCausalGraphReference({
  state,
  spec,
}: {
  state: QueryChangelogState;
  spec: Extract<QueryViewSpec, { kind: 'causal-graph' }>;
}) {
  return (
    <div style={mono}>
      {queryRows(state).map((row) => {
        const key = String(row[spec.idField] ?? 'unknown');
        const parent = row[spec.parentField];
        return (
          <div key={key} style={{ padding: '4px 0' }}>
            <span style={{ color: '#9cdcfe' }}>{key}</span>
            <span style={{ color: '#858585' }}> ← {cell(parent)}</span> ·{' '}
            {cell(row[spec.labelField])}{' '}
            <span style={{ color: '#dcdcaa' }}>
              ({evidenceLabel(state, key)})
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function QueryAttentionReference({
  state,
  spec,
}: {
  state: QueryChangelogState;
  spec: Extract<QueryViewSpec, { kind: 'attention' }>;
}) {
  return (
    <div style={mono}>
      {queryRows(state).map((row) => {
        const key = rowKey(row);
        return (
          <article
            key={key}
            style={{ padding: 8, borderLeft: '3px solid #dcdcaa', margin: 6 }}
          >
            <strong style={{ color: '#dcdcaa' }}>attention required</strong>{' '}
            <span style={{ color: '#9cdcfe' }}>
              {cell(row[spec.partitionField])}
            </span>
            <div>
              {cell(row[spec.repeatField])} repeats · elapsed{' '}
              {cell(row[spec.elapsedField])} ns
            </div>
            <div>recorded attribution: {cell(row[spec.attributionField])}</div>
            <div>matched evidence: {cell(row[spec.evidenceField])}</div>
            <div style={{ color: '#858585' }}>
              Temporal qualification only; no causal claim is inferred.
            </div>
            <div style={{ color: '#dcdcaa' }}>{evidenceLabel(state, key)}</div>
          </article>
        );
      })}
    </div>
  );
}

function referenceView(state: QueryChangelogState, spec: QueryViewSpec) {
  if (spec.kind !== 'profile') {
    return <GenericQueryView state={state} spec={spec} />;
  }
  return (
    <div style={{ ...mono, color: '#cccccc' }}>
      <div style={{ color: '#9cdcfe', marginBottom: 6 }}>
        {spec.profileId}@{spec.profileVersion} · {spec.viewId}
      </div>
      <div>
        {queryRows(state).length} canonical fact row(s) are available. Rendering
        requires the owning Profile KFX member {spec.memberId}; the generic
        catalog preserves the QueryDefinition and does not interpret
        profile-owned semantics.
      </div>
    </div>
  );
}

const specs: Record<GenericQueryViewSpec['kind'], GenericQueryViewSpec> = {
  table: {
    kind: 'table',
    columns: [
      'episode_id',
      'status',
      'begin_time',
      'end_time',
      'content_root_status',
    ],
  },
  timeline: {
    kind: 'timeline',
    timeField: 'begin_time',
    laneField: 'status',
    labelField: 'episode_id',
  },
  diff: {
    kind: 'diff',
    keyField: 'episode_id',
    fields: ['status', 'record_count', 'frame_count', 'content_root_status'],
  },
  'causal-graph': {
    kind: 'causal-graph',
    idField: 'episode_id',
    parentField: 'parent_episode_id',
    labelField: 'status',
  },
  attention: {
    kind: 'attention',
    partitionField: 'partition_key',
    repeatField: 'repeat_count',
    elapsedField: 'elapsed_ns',
    attributionField: 'attribution_counts',
    evidenceField: 'matched_episode_ids',
  },
};

export function QueryReferencePanel({ caps }: { caps: KfxCapabilities }) {
  const [savedText, setSavedText] = React.useState('');
  const [saved, setSaved] = React.useState<SavedQueryView | null>(null);
  const [catalog, setCatalog] = React.useState<SavedQueryEntry[]>([]);
  const [catalogEntry, setCatalogEntry] =
    React.useState<SavedQueryEntry | null>(null);
  const [inspection, setInspection] =
    React.useState<SavedQueryViewInspection | null>(null);
  const [state, setState] = React.useState(emptyQueryChangelogState);
  const [error, setError] = React.useState('');

  const refreshCatalog = () => {
    try {
      setCatalog(caps.storage.savedQueries().entries);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  React.useEffect(() => {
    try {
      setCatalog(caps.storage.savedQueries().entries);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [caps]);

  const resolveArtifact = (artifact: unknown): SavedQueryView | null => {
    const next = inspectSavedQueryView(artifact);
    setInspection(next);
    if (next.view.status === 'degraded') {
      setError(
        `${next.view.diagnosis.code} · ${next.view.diagnosis.message} · QueryDefinition preserved`,
      );
      return null;
    }
    return {
      schema: 'kungfu.query.saved-view/v1',
      name: next.name,
      definition: next.definition,
      view: next.view.spec,
    };
  };

  const selectCatalogEntry = (queryId: string) => {
    try {
      const entry = caps.storage.savedQuery(queryId);
      setCatalogEntry(entry);
      const value = resolveArtifact(entry.saved_view);
      setSaved(value);
      setSavedText(JSON.stringify(entry.saved_view, null, 2));
      if (value) setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const persistArtifact = (value: SavedQueryView) => {
    const entry = caps.storage.putSavedQuery(
      value,
      catalogEntry?.query_id,
      catalogEntry?.revision,
    );
    setCatalogEntry(entry);
    setSaved(entry.saved_view);
    setInspection(inspectSavedQueryView(entry.saved_view));
    setSavedText(JSON.stringify(entry.saved_view, null, 2));
    refreshCatalog();
  };

  const loadExample = (
    name = 'episode-head',
    view: GenericQueryViewSpec = specs.table,
  ) => {
    try {
      const examples = caps.storage.queryExamples() as {
        examples?: {
          name?: string;
          definition?: SavedQueryView['definition'];
        }[];
      };
      const definition = examples.examples?.find(
        (example) => example.name === name,
      )?.definition;
      if (!definition) throw new Error('query example unavailable');
      const value: SavedQueryView = {
        schema: 'kungfu.query.saved-view/v1',
        name,
        definition,
        view,
      };
      const text = JSON.stringify(value, null, 2);
      setCatalogEntry(null);
      setSavedText(text);
      setSaved(value);
      setInspection(inspectSavedQueryView(value));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const applyArtifact = () => {
    try {
      const parsed = JSON.parse(savedText) as unknown;
      const value = resolveArtifact(parsed);
      if (!value) return;
      persistArtifact(value);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const selectView = (kind: GenericQueryViewSpec['kind']) => {
    if (!saved) return;
    const value = { ...saved, view: specs[kind] } as SavedQueryView;
    try {
      persistArtifact(value);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const refresh = () => {
    if (!saved) return;
    try {
      let next = emptyQueryChangelogState();
      let token: QueryResumeToken | undefined;
      // The reference intentionally asks the public changelog for a complete
      // bounded snapshot. Rows stay in memory; only definition + ViewSpec are
      // persisted in the workspace catalog.
      for (let pageCount = 0; pageCount < 100; pageCount += 1) {
        const page = caps.storage.factChangelog(saved.definition, token, 100);
        next = applyQueryChangelogPage(next, page);
        if (page.complete) break;
        token = page.resume_token;
      }
      setState(next);
      setError(next.gap ? `gap: ${next.gap.recovery_hint}` : '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section style={{ ...panelStyle, gridColumn: '1 / -1' }}>
      <h2 style={headingStyle}>Proof query · shared saved artifact</h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(320px, 0.8fr) 1.2fr',
          gap: 12,
        }}
      >
        <div>
          <label style={{ ...mono, display: 'block', marginBottom: 6 }}>
            Workspace catalog{' '}
            <select
              aria-label="Workspace saved query catalog"
              value={catalogEntry?.query_id ?? ''}
              onChange={(event) => {
                if (event.target.value) selectCatalogEntry(event.target.value);
              }}
            >
              <option value="">New / imported artifact</option>
              {catalog.map((entry) => (
                <option value={entry.query_id} key={entry.query_id}>
                  {entry.saved_view.name} · r{entry.revision}
                </option>
              ))}
            </select>
          </label>
          <textarea
            aria-label="Saved QueryDefinition and ViewSpec"
            value={savedText}
            onChange={(event) => setSavedText(event.target.value)}
            placeholder="Load an example or paste kungfu.query.saved-view/v1 JSON"
            style={{
              ...mono,
              width: '100%',
              minHeight: 220,
              background: '#1e1e1e',
              color: '#cccccc',
            }}
          />
          <div
            style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}
          >
            <button type="button" onClick={() => loadExample()}>
              Load Episode example
            </button>
            <button
              type="button"
              onClick={() =>
                loadExample('buildchain-release-attention', specs.attention)
              }
            >
              Load attention example
            </button>
            <label style={{ ...mono, display: 'inline-block' }}>
              Import JSON{' '}
              <input
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  void file
                    .text()
                    .then(setSavedText, (cause) =>
                      setError(
                        cause instanceof Error ? cause.message : String(cause),
                      ),
                    );
                }}
              />
            </label>
            <button type="button" onClick={applyArtifact}>
              {catalogEntry ? 'Save revision' : 'Save to workspace'}
            </button>
            <button
              type="button"
              disabled={!catalogEntry}
              onClick={() => {
                if (!catalogEntry) return;
                try {
                  caps.storage.deleteSavedQuery(
                    catalogEntry.query_id,
                    catalogEntry.revision,
                  );
                  setCatalogEntry(null);
                  setSaved(null);
                  setInspection(null);
                  setSavedText('');
                  refreshCatalog();
                  setError('');
                } catch (cause) {
                  setError(
                    cause instanceof Error ? cause.message : String(cause),
                  );
                }
              }}
            >
              Delete
            </button>
            <button type="button" onClick={refresh} disabled={!saved}>
              Run changelog
            </button>
          </div>
          <div
            style={{
              ...mono,
              color: error ? '#f48771' : '#858585',
              marginTop: 6,
            }}
          >
            {error ||
              'Persisted in workspace .kungfu: QueryDefinition + ViewSpec only; rows and proof are rebuilt.'}
          </div>
        </div>
        <div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {(Object.keys(specs) as GenericQueryViewSpec['kind'][]).map(
              (kind) => (
                <button
                  type="button"
                  key={kind}
                  onClick={() => selectView(kind)}
                  disabled={!saved}
                >
                  {kind}
                </button>
              ),
            )}
          </div>
          {saved ? (
            referenceView(state, saved.view)
          ) : inspection?.view.status === 'degraded' ? (
            <div style={{ ...mono, color: '#dcdcaa' }}>
              <strong>{inspection.view.diagnosis.code}</strong>
              <div>{inspection.view.diagnosis.message}</div>
              <div>
                QueryDefinition {inspection.definition.schema} remains
                available; no rows or proof were discarded.
              </div>
            </div>
          ) : (
            <span style={{ ...mono, color: '#858585' }}>
              No saved query loaded.
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
