import type {
  GenericQueryViewSpec,
  QueryChangelogState,
} from '@kungfu-tech/api/capability';
import { queryRows } from '@kungfu-tech/api/capability';
import type React from 'react';

const mono: React.CSSProperties = {
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 12,
};

function cell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function evidenceLabel(state: QueryChangelogState, key: string): string {
  const evidence = state.evidence[key];
  if (!evidence) return 'missing evidence';
  return `${String(evidence.content_root_status ?? 'unverifiable')} · ${String(
    evidence.determinism ?? 'unverifiable',
  )}`;
}

function rowKey(row: Record<string, unknown>): string {
  return String(row.match_id ?? row.episode_id ?? 'unknown');
}

export function GenericQueryView({
  state,
  spec,
}: {
  state: QueryChangelogState;
  spec: GenericQueryViewSpec;
}) {
  const rows = queryRows(state);
  switch (spec.kind) {
    case 'table':
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
    case 'timeline':
      return (
        <ol style={{ ...mono, margin: 0, paddingLeft: 24 }}>
          {[...rows]
            .sort((left, right) =>
              cell(left[spec.timeField]).localeCompare(
                cell(right[spec.timeField]),
                undefined,
                { numeric: true },
              ),
            )
            .map((row) => {
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
    case 'diff':
      return (
        <div style={mono}>
          {Object.entries(state.changes).map(([key, change]) => (
            <div
              key={key}
              style={{ padding: 6, borderBottom: '1px solid #333' }}
            >
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
              <div style={{ color: '#dcdcaa' }}>
                {evidenceLabel(state, key)}
              </div>
            </div>
          ))}
        </div>
      );
    case 'causal-graph':
      return (
        <div style={mono}>
          {rows.map((row) => {
            const key = String(row[spec.idField] ?? 'unknown');
            return (
              <div key={key} style={{ padding: '4px 0' }}>
                <span style={{ color: '#9cdcfe' }}>{key}</span>
                <span style={{ color: '#858585' }}>
                  {' '}
                  ← {cell(row[spec.parentField])}
                </span>{' '}
                · {cell(row[spec.labelField])}{' '}
                <span style={{ color: '#dcdcaa' }}>
                  ({evidenceLabel(state, key)})
                </span>
              </div>
            );
          })}
        </div>
      );
    case 'attention':
      return (
        <div style={mono}>
          {rows.map((row) => {
            const key = rowKey(row);
            return (
              <article
                key={key}
                style={{
                  padding: 8,
                  borderLeft: '3px solid #dcdcaa',
                  margin: 6,
                }}
              >
                <strong style={{ color: '#dcdcaa' }}>attention required</strong>{' '}
                <span style={{ color: '#9cdcfe' }}>
                  {cell(row[spec.partitionField])}
                </span>
                <div>
                  {cell(row[spec.repeatField])} repeats · elapsed{' '}
                  {cell(row[spec.elapsedField])} ns
                </div>
                <div>
                  recorded attribution: {cell(row[spec.attributionField])}
                </div>
                <div>matched evidence: {cell(row[spec.evidenceField])}</div>
                <div style={{ color: '#858585' }}>
                  Temporal qualification only; no causal claim is inferred.
                </div>
                <div style={{ color: '#dcdcaa' }}>
                  {evidenceLabel(state, key)}
                </div>
              </article>
            );
          })}
        </div>
      );
  }
}
