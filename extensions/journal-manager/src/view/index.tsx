// Default kfx: journal inspection. Browse the runtime home's fact ledger
// through the capability SDK — Episodes (replay anchors), registered
// locations, and the merged event stream, read in-process through the same
// zero-copy frames the runtime itself uses.
import type { LedgerRecord, ReplayAnchor } from '@kungfu-tech/api/capability';
import type { KfxCapabilities, Shell } from '@kungfu-tech/kfx';
import { headingStyle, inputStyle, mono, panelStyle } from '@kungfu-tech/kfx';
import React from 'react';

function JournalManagerView({ caps }: { caps: KfxCapabilities; shell: Shell }) {
  const { ledger, domain } = caps;
  const [carrierFilter, setCarrierFilter] = React.useState('');
  const [events, setEvents] = React.useState<LedgerRecord[]>([]);
  const [error, setError] = React.useState('');

  const anchors: ReplayAnchor[] = React.useMemo(() => {
    try {
      return ledger.replayAnchors();
    } catch {
      return [];
    }
  }, [ledger]);

  const locations = React.useMemo(() => {
    try {
      return domain.locations();
    } catch {
      return [];
    }
  }, [domain]);

  const scan = React.useCallback(() => {
    try {
      const filter = carrierFilter.trim();
      setEvents(
        ledger.records({
          limit: 1000,
          carrierType: filter ? Number(filter) : undefined,
        }),
      );
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [ledger, carrierFilter]);

  React.useEffect(() => {
    scan();
  }, [scan]);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '320px 1fr',
        gap: 12,
        height: '100%',
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          minHeight: 0,
        }}
      >
        <section style={{ ...panelStyle, flex: 1 }}>
          <h2 style={headingStyle}>Episodes · {anchors.length}</h2>
          {anchors.length === 0 && (
            <div style={{ ...mono, color: '#6a6a6a' }}>
              no recorded Episodes yet
            </div>
          )}
          {anchors.map((anchor) => {
            const key = anchor.episodeId.toString();
            return (
              <div key={key} style={{ ...mono, marginBottom: 6 }}>
                <div style={{ color: '#9cdcfe' }}>
                  Episode {anchor.episodeId.toString()} · location{' '}
                  {anchor.locationUid.toString(16).padStart(8, '0')}
                </div>
                <div style={{ color: '#858585' }}>
                  {ledger.formatNanos(anchor.beginTime, '%m/%d %H:%M:%S')} →{' '}
                  {anchor.closed && anchor.endTime > 0n
                    ? ledger.formatNanos(anchor.endTime, '%H:%M:%S')
                    : 'open'}{' '}
                  · {anchor.frameCount.toString()} frames · last{' '}
                  {anchor.lastFrameUid.toString()}
                </div>
              </div>
            );
          })}
        </section>
        <section style={{ ...panelStyle, flex: 1 }}>
          <h2 style={headingStyle}>Locations · {locations.length}</h2>
          <ul style={{ ...mono, color: '#9cdcfe', margin: 0, paddingLeft: 16 }}>
            {locations.map((location) => {
              const key = `${location.role}/${location.namespace}/${location.name}/${location.mode}`;
              return <li key={key}>{key}</li>;
            })}
          </ul>
        </section>
      </div>
      <section style={{ ...panelStyle, minHeight: 0 }}>
        <h2 style={headingStyle}>
          Events · {events.length}
          {events.length >= 1000 ? '+' : ''}
          <input
            value={carrierFilter}
            onChange={(e) => setCarrierFilter(e.target.value)}
            placeholder="carrier filter"
            style={{ ...inputStyle, width: 110, marginLeft: 12 }}
          />
          <button
            type="button"
            onClick={scan}
            style={{ ...mono, marginLeft: 8 }}
          >
            rescan
          </button>
        </h2>
        {error && <div style={{ ...mono, color: '#f48771' }}>{error}</div>}
        {events.length === 0 && !error && (
          <div style={{ ...mono, color: '#6a6a6a' }}>
            no journal frames match — start the runtime coordinator against this
            runtime home and rescan
          </div>
        )}
        <table style={{ ...mono, borderCollapse: 'collapse', width: '100%' }}>
          <tbody>
            {events.map((event, index) => (
              <tr
                key={`${event.genTime}-${index}`}
                style={{ borderTop: '1px solid #3c3c3c' }}
              >
                <td style={{ padding: '2px 8px', color: '#858585' }}>
                  {ledger.formatNanos(event.genTime)}
                </td>
                <td style={{ padding: '2px 8px', color: '#9cdcfe' }}>
                  carrier {event.carrierType}
                </td>
                <td style={{ padding: '2px 8px', color: '#ce9178' }}>
                  {event.source.toString(16).padStart(8, '0')} →{' '}
                  {event.dest.toString(16).padStart(8, '0')}
                </td>
                <td style={{ padding: '2px 8px', color: '#858585' }}>
                  {event.dataLength} B
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export const View = JournalManagerView;
