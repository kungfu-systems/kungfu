// Default kfx: journal management. Browse the runtime home's fact ledger
// through the capability SDK — recorded runs (replay anchors), registered
// locations, and the merged event stream, read in-process through the same
// zero-copy frames the runtime itself uses.
import type { LedgerRecord, ReplayAnchor } from '@kungfu-tech/api/capability';
import React from 'react';
import type { KfxCapabilities, Shell } from '@kungfu-tech/kfx';
import { headingStyle, inputStyle, mono, panelStyle } from '@kungfu-tech/kfx';

function JournalManagerView({ caps }: { caps: KfxCapabilities; shell: Shell }) {
  const { ledger, domain } = caps;
  const [msgFilter, setMsgFilter] = React.useState('');
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
      const filter = msgFilter.trim();
      setEvents(
        ledger.records({
          limit: 1000,
          msgType: filter ? Number(filter) : undefined,
        }),
      );
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [ledger, msgFilter]);

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
          <h2 style={headingStyle}>Runs · {anchors.length}</h2>
          {anchors.length === 0 && (
            <div style={{ ...mono, color: '#6a6a6a' }}>
              no recorded runs yet
            </div>
          )}
          {anchors.map((anchor) => {
            const key = `${anchor.location.group}/${anchor.location.name}/${anchor.beginTime}`;
            return (
              <div key={key} style={{ ...mono, marginBottom: 6 }}>
                <div style={{ color: '#9cdcfe' }}>
                  {anchor.location.category}/{anchor.location.group}/
                  {anchor.location.name}/{anchor.location.mode}
                </div>
                <div style={{ color: '#858585' }}>
                  {ledger.formatNanos(anchor.beginTime, '%m/%d %H:%M:%S')} →{' '}
                  {anchor.endTime > 0n
                    ? ledger.formatNanos(anchor.endTime, '%H:%M:%S')
                    : 'open'}{' '}
                  · {String(anchor.frameCount)} frames
                </div>
              </div>
            );
          })}
        </section>
        <section style={{ ...panelStyle, flex: 1 }}>
          <h2 style={headingStyle}>Locations · {locations.length}</h2>
          <ul style={{ ...mono, color: '#9cdcfe', margin: 0, paddingLeft: 16 }}>
            {locations.map((location) => {
              const key = `${location.category}/${location.group}/${location.name}/${location.mode}`;
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
            value={msgFilter}
            onChange={(e) => setMsgFilter(e.target.value)}
            placeholder="msg type filter"
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
            no journal frames match — start a master against this runtime home
            and rescan
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
                  msg {event.msgType}
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
