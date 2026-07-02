// Default kfx: journal management. Browse the runtime home's fact ledger —
// recorded runs, registered locations, and the merged event stream, read
// in-process through the same zero-copy frames the runtime itself uses.
import React from 'react';
import type { KfxCapabilities, KfxManifest } from '../kfx';
import { APP_LOCATION, bigintSafe } from '../runtime';
import { headingStyle, inputStyle, mono, panelStyle } from '../ui';

type EventRow = {
  genTime: string;
  msgType: number;
  source: string;
  dest: string;
  length: number;
};

function JournalManagerView({ caps }: { caps: KfxCapabilities }) {
  const { kfe, runtimeDir } = caps;
  const [msgFilter, setMsgFilter] = React.useState('');
  const [events, setEvents] = React.useState<EventRow[]>([]);
  const [error, setError] = React.useState('');

  const formatNano = React.useCallback(
    (nano: bigint) => {
      try {
        if (kfe.formatTime) return kfe.formatTime(nano, '%H:%M:%S.%N');
      } catch {
        // fall through to raw nanoseconds
      }
      return String(nano);
    },
    [kfe],
  );

  const sessions = React.useMemo(() => {
    try {
      const store = new kfe.SessionStore(APP_LOCATION, runtimeDir);
      return {
        ok: true,
        text: JSON.stringify(store.getAllSessions(), bigintSafe, 1),
      };
    } catch (e) {
      return { ok: false, text: (e as Error).message };
    }
  }, [kfe, runtimeDir]);

  const locations = React.useMemo(() => {
    try {
      const io = new kfe.IODevice(APP_LOCATION, runtimeDir);
      return { ok: true, rows: Object.values(io.getAllLocations()) };
    } catch (e) {
      return { ok: false, rows: [], message: (e as Error).message };
    }
  }, [kfe, runtimeDir]);

  const scan = React.useCallback(() => {
    try {
      const asm = new kfe.Assemble([runtimeDir]);
      const rows: EventRow[] = [];
      const filter = msgFilter.trim();
      while (asm.dataAvailable() && rows.length < 1000) {
        const frame = asm.currentFrame();
        const msgType = frame.msgType();
        if (!filter || String(msgType) === filter) {
          rows.push({
            genTime: formatNano(frame.genTime()),
            msgType,
            source: frame.source().toString(16).padStart(8, '0'),
            dest: frame.dest().toString(16).padStart(8, '0'),
            length: frame.dataLength(),
          });
        }
        asm.next();
      }
      setEvents(rows);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [kfe, runtimeDir, msgFilter, formatNano]);

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
          <h2 style={headingStyle}>Runs</h2>
          <pre
            style={{
              ...mono,
              color: sessions.ok ? '#ce9178' : '#f48771',
              margin: 0,
            }}
          >
            {sessions.ok && (sessions.text === '{}' || sessions.text === '[]')
              ? 'no recorded runs yet'
              : sessions.text}
          </pre>
        </section>
        <section style={{ ...panelStyle, flex: 1 }}>
          <h2 style={headingStyle}>Locations · {locations.rows.length}</h2>
          {locations.ok ? (
            <ul
              style={{ ...mono, color: '#9cdcfe', margin: 0, paddingLeft: 16 }}
            >
              {locations.rows.map((row) => (
                <li key={String(row.uid ?? JSON.stringify(row))}>
                  {String(row.category)}/{String(row.group)}/{String(row.name)}/
                  {String(row.mode)}
                </li>
              ))}
            </ul>
          ) : (
            <div style={{ ...mono, color: '#f48771' }}>{locations.message}</div>
          )}
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
                  {event.genTime}
                </td>
                <td style={{ padding: '2px 8px', color: '#9cdcfe' }}>
                  msg {event.msgType}
                </td>
                <td style={{ padding: '2px 8px', color: '#ce9178' }}>
                  {event.source} → {event.dest}
                </td>
                <td style={{ padding: '2px 8px', color: '#858585' }}>
                  {event.length} B
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export const journalManagerKfx: KfxManifest = {
  id: 'journal-manager',
  title: 'Journal',
  runtime: 'node-integrated',
  View: JournalManagerView,
};
