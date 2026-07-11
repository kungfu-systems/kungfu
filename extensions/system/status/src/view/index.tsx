import type { KfxCapabilities, Shell } from '@kungfu-tech/kfx';
import { headingStyle, mono, panelStyle } from '@kungfu-tech/kfx';
import React from 'react';
import { QueryReferencePanel } from './query-reference';

// System kfx: system status. Runtime facts (master liveness, versions,
// binding exports, runtime home) plus the core schema type registry — the
// diagnostics face of the shell. The future storage health story
// (fsck/export overview) mounts here.

function SystemStatusView({
  caps,
  shell,
}: {
  caps: KfxCapabilities;
  shell: Shell;
}) {
  const [live, setLive] = React.useState(() => caps.ledger.health().live);
  React.useEffect(
    () => shell.onRefresh(() => setLive(caps.ledger.health().live)),
    [shell, caps.ledger],
  );

  const [selected, setSelected] = React.useState<string | null>(null);
  const [episodeId, setEpisodeId] = React.useState('');
  const [sourceId, setSourceId] = React.useState('');
  const [storageResult, setStorageResult] = React.useState(
    'Choose an operation. Every action below calls the public storage capability.',
  );
  const runStorage = (label: string, operation: () => unknown) => {
    try {
      setStorageResult(`${label}\n${JSON.stringify(operation(), null, 2)}`);
    } catch (error) {
      setStorageResult(
        `${label} failed\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const registry = shell.info.schemaTypes;
  const current = registry.find((t) => t.name === selected);

  const info = shell.info;
  const versions = window.process.versions;
  const masterStatus = info.masterStatus;
  const masterPayload = masterStatus?.payload as
    | {
        status?: string;
        configHome?: string;
        dataRoot?: string;
        runtimeDir?: string;
        lifecycle?: {
          state?: string;
          healthy?: boolean;
          warnings?: string[];
        };
        supervisor?: { running?: boolean; pid?: number | null };
        master?: { running?: boolean; pid?: number | null };
        route?: {
          routeId?: string;
          registered?: boolean;
          stale?: boolean;
          freshness?: { ageSeconds?: number | null; ttlSeconds?: number };
        };
        routes?: { count?: number; staleCount?: number };
      }
    | null
    | undefined;
  const supervisorLive = masterPayload?.supervisor?.running === true;
  const masterLive = masterPayload?.master?.running === true || live;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <section style={panelStyle}>
        <h2 style={headingStyle}>Runtime</h2>
        <div style={{ ...mono }}>
          <div>
            master:{' '}
            <span style={{ color: masterLive ? '#4ec9b0' : '#858585' }}>
              {masterLive ? '● live' : '○ offline'}
            </span>
          </div>
          <div>
            supervisor:{' '}
            <span style={{ color: supervisorLive ? '#4ec9b0' : '#858585' }}>
              {supervisorLive ? '● live' : '○ stopped'}
            </span>
          </div>
          <div>service status: {masterPayload?.status ?? 'unknown'}</div>
          <div>
            lifecycle:{' '}
            <span
              style={{
                color: masterPayload?.lifecycle?.healthy
                  ? '#4ec9b0'
                  : '#dcdcaa',
              }}
            >
              {masterPayload?.lifecycle?.state ?? 'unknown'}
            </span>
          </div>
          <div>
            lifecycle warnings:{' '}
            {masterPayload?.lifecycle?.warnings?.join(', ') || '-'}
          </div>
          <div>core: {String(info.buildInfo?.version ?? 'unknown')}</div>
          <div>kungfu: {info.kungfuVersion || 'unavailable'}</div>
          <div>
            electron: {versions.electron} · node: {versions.node}
          </div>
          <div>
            runtime home: {masterPayload?.runtimeDir ?? info.runtimeDir}
          </div>
          <div>data root: {masterPayload?.dataRoot ?? 'unknown'}</div>
          <div>config home: {masterPayload?.configHome ?? 'unknown'}</div>
          <div>
            route: {masterPayload?.route?.routeId ?? 'unknown'} ·{' '}
            {masterPayload?.route?.registered ? 'registered' : 'not registered'}
            {masterPayload?.route?.stale ? ' · stale' : ''}
          </div>
          <div>
            route lease age:{' '}
            {masterPayload?.route?.freshness?.ageSeconds == null
              ? 'unknown'
              : `${masterPayload.route.freshness.ageSeconds.toFixed(1)}s`}
          </div>
          <div>
            routes: {String(masterPayload?.routes?.count ?? 'unknown')} · stale:{' '}
            {String(masterPayload?.routes?.staleCount ?? 0)}
          </div>
          <div style={{ color: info.ok ? '#4ec9b0' : '#f48771' }}>
            binding: {info.message}
          </div>
          {masterStatus && !masterStatus.ok ? (
            <div style={{ color: '#f48771' }}>
              master status: {masterStatus.error || 'unavailable'}
            </div>
          ) : null}
        </div>
        <h2 style={{ ...headingStyle, marginTop: 12 }}>
          Binding exports · {info.exports.length}
        </h2>
        <ul
          style={{
            ...mono,
            columns: 2,
            color: '#9cdcfe',
            margin: 0,
            paddingLeft: 16,
          }}
        >
          {info.exports.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      </section>
      <section style={panelStyle}>
        <h2 style={headingStyle}>Core schema registry · {registry.length}</h2>
        <div style={{ display: 'flex', gap: 12 }}>
          <ul
            style={{ listStyle: 'none', margin: 0, padding: 0, minWidth: 180 }}
          >
            {registry.map((t) => (
              <li key={t.name}>
                <button
                  type="button"
                  onClick={() => setSelected(t.name)}
                  style={{
                    ...mono,
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '3px 8px',
                    border: 'none',
                    borderRadius: 4,
                    cursor: 'pointer',
                    background: selected === t.name ? '#04395e' : 'transparent',
                    color: selected === t.name ? '#9cdcfe' : '#cccccc',
                  }}
                >
                  {t.name}
                </button>
              </li>
            ))}
          </ul>
          <div style={{ ...mono, color: '#ce9178', flex: 1 }}>
            {current ? (
              <>
                <div style={{ color: '#9cdcfe', marginBottom: 4 }}>
                  {current.name} · {current.fields.length} fields
                </div>
                {current.fields.map((f) => (
                  <div key={f}>{f}</div>
                ))}
              </>
            ) : (
              <span style={{ color: '#6a6a6a' }}>
                select a type — fields come from the public C++ core registry
              </span>
            )}
          </div>
        </div>
      </section>
      <section style={{ ...panelStyle, gridColumn: '1 / -1' }}>
        <h2 style={headingStyle}>Storage operations · public capability</h2>
        <div
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}
        >
          <button
            type="button"
            onClick={() => runStorage('layout', caps.storage.layout)}
          >
            Layout / init
          </button>
          <button
            type="button"
            onClick={() =>
              runStorage('timeline', () => caps.storage.episodes())
            }
          >
            Episode timeline
          </button>
          <input
            aria-label="Episode id"
            placeholder="episode id"
            value={episodeId}
            onChange={(event) => setEpisodeId(event.target.value)}
          />
          <button
            type="button"
            onClick={() =>
              runStorage('inspect', () =>
                caps.storage.inspectEpisode(Number.parseInt(episodeId, 10)),
              )
            }
          >
            Inspect
          </button>
          <input
            aria-label="Source id"
            placeholder="source id (optional)"
            value={sourceId}
            onChange={(event) => setSourceId(event.target.value)}
          />
          <button
            type="button"
            onClick={() =>
              runStorage('query', () => caps.storage.query(sourceId))
            }
          >
            Query
          </button>
          <button
            type="button"
            onClick={() => runStorage('fsck', caps.storage.fsck)}
          >
            Verify / fsck
          </button>
          <button
            type="button"
            onClick={() => runStorage('repair plan', caps.storage.repairPlan)}
          >
            Repair plan
          </button>
          <button
            type="button"
            onClick={() =>
              runStorage('portable export', () =>
                caps.storage.exportBundle(sourceId),
              )
            }
          >
            Export bundle
          </button>
        </div>
        <pre
          style={{
            ...mono,
            margin: 0,
            maxHeight: 260,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            color: '#9cdcfe',
          }}
        >
          {storageResult}
        </pre>
      </section>
      <QueryReferencePanel caps={caps} />
    </div>
  );
}

export const View = SystemStatusView;
