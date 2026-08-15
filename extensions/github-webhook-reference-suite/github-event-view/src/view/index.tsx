import React from 'react';
import { presentGitHubEvidence } from './event-presentation.mjs';

const panelStyle = {
  background: '#252526',
  border: '1px solid #3c3c3c',
  borderRadius: 6,
  padding: 12,
  overflow: 'auto',
  minHeight: 0,
};

const headingStyle = {
  fontSize: 'calc(var(--kf-font-size, 14px) - 3px)',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 1,
  color: '#858585',
  margin: '0 0 8px 0',
};

const mono = {
  fontFamily: 'var(--kf-mono-font-family, SF Mono, Menlo, monospace)',
  fontSize: 'calc(var(--kf-font-size, 14px) - 2px)',
};

const sample = JSON.stringify(
  {
    accepted: true,
    event: {
      schema: 'kungfu.github-webhook-observation/v1',
      outcome: 'observed',
      code: null,
      delivery: 'synthetic-delivery',
      event: 'issues',
      action: 'opened',
      repository: 'kungfu-systems/kungfu',
      sender: 'octocat',
      payloadRoot: `sha256:${'1'.repeat(64)}`,
    },
    receipt: {
      outcome: 'applied',
      code: null,
      receiptRoot: `sha256:${'2'.repeat(64)}`,
    },
  },
  null,
  2,
);

function GitHubEventView() {
  const [input, setInput] = React.useState(sample);
  const presentation = React.useMemo(
    () => presentGitHubEvidence(input),
    [input],
  );
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <section style={panelStyle}>
        <h2 style={headingStyle}>Normalized webhook evidence</h2>
        <p style={{ color: '#cccccc' }}>
          Paste one JSON object, a JSON array, or JSONL. The view is local-only
          and has no Dogfood or network capability.
        </p>
        <textarea
          aria-label="GitHub webhook evidence"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          spellCheck={false}
          style={{
            ...mono,
            width: '100%',
            minHeight: 180,
            boxSizing: 'border-box',
          }}
        />
      </section>
      <section style={panelStyle}>
        <h2 style={headingStyle}>
          Events · {presentation.rows.length} · diagnostics{' '}
          {presentation.diagnostics.length}
        </h2>
        {presentation.diagnostics.map((diagnostic) => (
          <div
            key={`${diagnostic.line}-${diagnostic.code}`}
            style={{ color: '#f48771' }}
          >
            {diagnostic.code}{' '}
            {diagnostic.line == null ? '' : `at line ${diagnostic.line}`}
          </div>
        ))}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ ...mono, width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {[
                  'delivery',
                  'result',
                  'event/action',
                  'repository',
                  'evidence',
                ].map((label) => (
                  <th key={label} style={{ textAlign: 'left', padding: 6 }}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {presentation.rows.map((row) => (
                <tr key={`${row.index}-${row.delivery}`}>
                  <td style={{ padding: 6 }}>{row.delivery || '-'}</td>
                  <td
                    style={{
                      padding: 6,
                      color: row.code ? '#dcdcaa' : '#4ec9b0',
                    }}
                  >
                    {row.replayed ? 'replayed' : row.code || row.outcome}
                  </td>
                  <td style={{ padding: 6 }}>
                    {row.event || '-'} / {row.action || '-'}
                  </td>
                  <td style={{ padding: 6 }}>{row.repository || '-'}</td>
                  <td style={{ padding: 6 }}>
                    {row.payloadRoot ? `${row.payloadRoot.slice(0, 20)}…` : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export const View = GitHubEventView;
