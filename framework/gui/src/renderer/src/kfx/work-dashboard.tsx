// Work dashboard — the first screen: real-world work items and their state,
// not a trace list. Left pane lists items across the five lifecycle states;
// the detail pane shows one item's summary, next action, facts (checkpoints,
// decisions, validations, artifacts, linked runs) and lifecycle history.
// Linked runs point at the Rewind inspector, which stays the run-level
// forensic detail view.
import type { WorkItem } from '@kungfu-tech/api/capability';
import { WORK_STATUS_NAMES } from '@kungfu-tech/api/capability';
import React from 'react';
import type { KfxCapabilities, KfxManifest, Shell } from '../kfx';
import { headingStyle, mono, panelStyle } from '../ui';

const STATUS_ORDER = ['active', 'blocked', 'waiting', 'ready', 'done'] as const;

const STATUS_COLORS: Record<string, string> = {
  active: '#4ec9b0',
  blocked: '#f48771',
  waiting: '#dcdcaa',
  ready: '#9cdcfe',
  done: '#6a6a6a',
};

function statusName(item: WorkItem): string {
  return item.status !== undefined ? WORK_STATUS_NAMES[item.status] : 'unknown';
}

function StatusBadge({ name }: { name: string }) {
  return (
    <span style={{ ...mono, color: STATUS_COLORS[name] ?? '#cccccc' }}>
      [{name}]
    </span>
  );
}

type FactRow = { key: string; fields: Record<string, string | undefined> };

function FactRows({ label, rows }: { label: string; rows: FactRow[] }) {
  if (!rows.length) return null;
  return (
    <div style={{ marginBottom: 8 }}>
      <h2 style={headingStyle}>
        {label} · {rows.length}
      </h2>
      {rows.map((row) => (
        <div key={row.key} style={{ ...mono, color: '#ce9178' }}>
          {Object.entries(row.fields)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `${key}: ${value}`)
            .join(' · ')}
        </div>
      ))}
    </div>
  );
}

function DetailView({
  caps,
  shell,
  item,
}: {
  caps: KfxCapabilities;
  shell: Shell;
  item: WorkItem;
}) {
  const time = (nanos: bigint) =>
    caps.ledger.formatNanos(nanos, '%m-%d %H:%M:%S');
  return (
    <section style={{ ...panelStyle, flex: 1 }}>
      <h2 style={headingStyle}>
        {item.workId} · {item.kind ?? 'task'}
      </h2>
      <div style={{ ...mono, fontSize: 13, marginBottom: 4 }}>
        <StatusBadge name={statusName(item)} /> {item.title}
      </div>
      {item.summary && (
        <div style={{ ...mono, color: '#858585', marginBottom: 8 }}>
          {item.summary}
        </div>
      )}
      {item.nextAction && (
        <div style={{ ...mono, color: '#dcdcaa', marginBottom: 8 }}>
          next: {item.nextAction}
        </div>
      )}
      <FactRows
        label="Checkpoints"
        rows={item.checkpoints.map((row) => ({
          key: String(row.time),
          fields: { time: time(row.time), note: row.note },
        }))}
      />
      <FactRows
        label="Decisions"
        rows={item.decisions.map((row) => ({
          key: String(row.time),
          fields: {
            time: time(row.time),
            decision: row.decision,
            by: row.decidedBy,
          },
        }))}
      />
      <FactRows
        label="Validations"
        rows={item.validations.map((row) => ({
          key: String(row.time),
          fields: {
            time: time(row.time),
            result: row.result === 0 ? 'pass' : 'fail',
            command: row.command,
            note: row.note,
          },
        }))}
      />
      <FactRows
        label="Artifacts"
        rows={item.artifacts.map((row) => ({
          key: String(row.time),
          fields: { time: time(row.time), ref: row.ref, kind: row.kind },
        }))}
      />
      {item.runs.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <h2 style={headingStyle}>Linked runs · {item.runs.length}</h2>
          {item.runs.map((row) => (
            <button
              key={String(row.time)}
              type="button"
              onClick={() =>
                row.runId && shell.open('rewind', { run: row.runId })
              }
              style={{
                ...mono,
                display: 'block',
                padding: '2px 0',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                color: '#9cdcfe',
                textAlign: 'left',
              }}
            >
              {time(row.time)} · {row.runId} → open in Rewind
            </button>
          ))}
        </div>
      )}
      <h2 style={headingStyle}>History</h2>
      {item.history.map((row) => (
        <div
          key={`${row.time}-${row.event}-${row.status ?? ''}`}
          style={{ ...mono, color: '#9cdcfe' }}
        >
          {time(row.time)}{' '}
          {row.event === 'created'
            ? 'created'
            : `-> ${row.status !== undefined ? WORK_STATUS_NAMES[row.status] : '?'}${
                row.reason ? ` (${row.reason})` : ''
              }`}
        </div>
      ))}
    </section>
  );
}

function WorkDashboardView({
  caps,
  shell,
}: {
  caps: KfxCapabilities;
  shell: Shell;
}) {
  const [items, setItems] = React.useState<WorkItem[]>(() => caps.work.items());
  const [filter, setFilter] = React.useState<string>('all');
  const [selected, setSelected] = React.useState<string | null>(null);

  const reload = React.useCallback(() => {
    caps.work.refresh();
    setItems(caps.work.items());
  }, [caps.work]);

  // the shell owns the refresh timer; this kfx only subscribes
  React.useEffect(() => shell.onRefresh(reload), [shell, reload]);

  const counts = new Map<string, number>();
  for (const item of items) {
    const name = statusName(item);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const visible =
    filter === 'all'
      ? items
      : items.filter((item) => statusName(item) === filter);
  const current = items.find((item) => item.workId === selected) ?? null;

  const filterButton = (name: string, count?: number) => (
    <button
      key={name}
      type="button"
      onClick={() => setFilter(name)}
      style={{
        ...mono,
        padding: '3px 8px',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        background: filter === name ? '#04395e' : 'transparent',
        color: filter === name ? '#9cdcfe' : (STATUS_COLORS[name] ?? '#cccccc'),
      }}
    >
      {name}
      {count !== undefined ? ` ${count}` : ''}
    </button>
  );

  return (
    <div style={{ display: 'flex', gap: 12, height: '100%', minHeight: 0 }}>
      <section style={{ ...panelStyle, width: 380, flexShrink: 0 }}>
        <h2 style={headingStyle}>Work · {items.length}</h2>
        <div
          style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}
        >
          {filterButton('all', items.length)}
          {STATUS_ORDER.map((name) =>
            filterButton(name, counts.get(name) ?? 0),
          )}
          <button
            type="button"
            onClick={reload}
            style={{
              ...mono,
              padding: '3px 8px',
              border: '1px solid #3c3c3c',
              borderRadius: 4,
              cursor: 'pointer',
              background: 'transparent',
              color: '#cccccc',
            }}
          >
            refresh
          </button>
        </div>
        {visible.length ? (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {visible.map((item) => (
              <li key={item.workId}>
                <button
                  type="button"
                  onClick={() => setSelected(item.workId)}
                  style={{
                    ...mono,
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '4px 8px',
                    border: 'none',
                    borderRadius: 4,
                    cursor: 'pointer',
                    background:
                      selected === item.workId ? '#04395e' : 'transparent',
                    color: '#cccccc',
                  }}
                >
                  <StatusBadge name={statusName(item)} />{' '}
                  {item.title ?? item.workId}
                  {item.nextAction && (
                    <div style={{ color: '#858585', fontSize: 11 }}>
                      next: {item.nextAction}
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div style={{ ...mono, color: '#6a6a6a' }}>
            no work items — create one with `kungfu work create "..."`
          </div>
        )}
      </section>
      {current ? (
        <DetailView caps={caps} shell={shell} item={current} />
      ) : (
        <section style={{ ...panelStyle, flex: 1 }}>
          <div style={{ ...mono, color: '#6a6a6a' }}>
            select a work item — its facts, next action, history and linked runs
            appear here
          </div>
        </section>
      )}
    </div>
  );
}

export const workDashboardKfx: KfxManifest = {
  id: 'work',
  title: 'Work dashboard',
  runtime: 'node-integrated',
  capabilities: ['ledger', 'work'],
  View: WorkDashboardView,
};
