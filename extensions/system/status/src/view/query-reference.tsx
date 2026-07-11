import {
  type KfxCapabilities,
  type QueryChangelogState,
  type QueryResumeToken,
  type QueryViewSpec,
  type SavedQueryView,
  applyQueryChangelogPage,
  emptyQueryChangelogState,
  headingStyle,
  mono,
  panelStyle,
  parseSavedQueryView,
  queryRows,
} from '@kungfu-tech/kfx';
import React from 'react';

const SAVED_QUERY_KEY = 'kungfu.query.saved-view/v1:system-status';

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
          const key = String(row.episode_id ?? 'unknown');
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
        const key = String(row.episode_id ?? 'unknown');
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

function referenceView(state: QueryChangelogState, spec: QueryViewSpec) {
  switch (spec.kind) {
    case 'table':
      return <QueryTableReference state={state} spec={spec} />;
    case 'timeline':
      return <QueryTimelineReference state={state} spec={spec} />;
    case 'diff':
      return <QueryDiffReference state={state} spec={spec} />;
    case 'causal-graph':
      return <QueryCausalGraphReference state={state} spec={spec} />;
  }
}

const specs: Record<QueryViewSpec['kind'], QueryViewSpec> = {
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
};

export function QueryReferencePanel({ caps }: { caps: KfxCapabilities }) {
  const [savedText, setSavedText] = React.useState(
    () => window.localStorage.getItem(SAVED_QUERY_KEY) ?? '',
  );
  const [saved, setSaved] = React.useState<SavedQueryView | null>(null);
  const [state, setState] = React.useState(emptyQueryChangelogState);
  const [error, setError] = React.useState('');

  const loadExample = () => {
    try {
      const examples = caps.storage.queryExamples() as {
        examples?: { definition?: SavedQueryView['definition'] }[];
      };
      const definition = examples.examples?.[0]?.definition;
      if (!definition) throw new Error('query example unavailable');
      const value: SavedQueryView = {
        schema: 'kungfu.query.saved-view/v1',
        name: 'episode-head',
        definition,
        view: specs.table,
      };
      const text = JSON.stringify(value, null, 2);
      window.localStorage.setItem(SAVED_QUERY_KEY, text);
      setSavedText(text);
      setSaved(value);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const applyArtifact = () => {
    try {
      const value = parseSavedQueryView(JSON.parse(savedText));
      window.localStorage.setItem(
        SAVED_QUERY_KEY,
        JSON.stringify(value, null, 2),
      );
      setSaved(value);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const selectView = (kind: QueryViewSpec['kind']) => {
    if (!saved) return;
    const value = { ...saved, view: specs[kind] } as SavedQueryView;
    const text = JSON.stringify(value, null, 2);
    window.localStorage.setItem(SAVED_QUERY_KEY, text);
    setSaved(value);
    setSavedText(text);
  };

  const refresh = () => {
    if (!saved) return;
    try {
      let next = emptyQueryChangelogState();
      let token: QueryResumeToken | undefined;
      // The reference intentionally asks the public changelog for a complete
      // bounded snapshot. Rows stay in memory; only definition + ViewSpec are
      // persisted in localStorage.
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
            <button type="button" onClick={loadExample}>
              Load example
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
              Apply artifact
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
              'Persisted locally: QueryDefinition + ViewSpec only; rows and proof are rebuilt.'}
          </div>
        </div>
        <div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {(Object.keys(specs) as QueryViewSpec['kind'][]).map((kind) => (
              <button
                type="button"
                key={kind}
                onClick={() => selectView(kind)}
                disabled={!saved}
              >
                {kind}
              </button>
            ))}
          </div>
          {saved ? (
            referenceView(state, saved.view)
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
