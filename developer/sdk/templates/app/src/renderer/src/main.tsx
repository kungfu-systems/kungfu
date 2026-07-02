import React from 'react';
import { createRoot } from 'react-dom/client';

// nodeIntegration exposes node `require` on window; use it to load the native
// kungfu binding at runtime. This is the platform's moat: the renderer reaches
// the in-process runtime directly, no IPC copy.
declare global {
  interface Window {
    require: NodeRequire;
    process: NodeJS.Process;
  }
}

type KfFrame = {
  genTime: () => bigint;
  msgType: () => number;
  source: () => number;
  dest: () => number;
  dataLength: () => number;
};

type Kfe = {
  Assemble: new (runtimeDirs: string[]) => {
    dataAvailable: () => boolean;
    next: () => void;
    currentFrame: () => KfFrame;
  };
  formatTime?: (nano: bigint, format?: string) => string;
};

function boot() {
  const env = window.process.env;
  const runtimeDir = env.KF_RUNTIME_DIR || '';
  try {
    const kfe = window.require(env.KFE_PATH as string) as Kfe;
    return {
      ok: true as const,
      kfe,
      runtimeDir,
      message: `in-process binding loaded · ${Object.keys(kfe).length} exports`,
    };
  } catch (e) {
    return {
      ok: false as const,
      kfe: null,
      runtimeDir,
      message: (e as Error).message,
    };
  }
}

const mono: React.CSSProperties = {
  fontFamily: 'SF Mono, Menlo, monospace',
  fontSize: 12,
};

function Ledger({ kfe, runtimeDir }: { kfe: Kfe; runtimeDir: string }) {
  const [rows, setRows] = React.useState<
    Array<{ genTime: string; msgType: number; length: number }>
  >([]);

  React.useEffect(() => {
    const scan = () => {
      try {
        const asm = new kfe.Assemble([runtimeDir]);
        const next: typeof rows = [];
        while (asm.dataAvailable() && next.length < 200) {
          const frame = asm.currentFrame();
          let genTime = String(frame.genTime());
          try {
            if (kfe.formatTime) genTime = kfe.formatTime(frame.genTime(), '%H:%M:%S.%N');
          } catch {
            // keep raw nanoseconds
          }
          next.push({
            genTime,
            msgType: frame.msgType(),
            length: frame.dataLength(),
          });
          asm.next();
        }
        setRows(next);
      } catch {
        setRows([]);
      }
    };
    scan();
    const timer = setInterval(scan, 2000);
    return () => clearInterval(timer);
  }, [kfe, runtimeDir]);

  return (
    <div>
      <p style={{ ...mono, color: '#858585' }}>
        ledger events: {rows.length} · runtime home: {runtimeDir}
      </p>
      {rows.slice(-15).map((row, index) => (
        <div key={`${row.genTime}-${index}`} style={{ ...mono, color: '#9cdcfe' }}>
          {row.genTime} · msg {row.msgType} · {row.length} B
        </div>
      ))}
    </div>
  );
}

function App() {
  const [state] = React.useState(boot);
  return (
    <div
      style={{
        fontFamily: 'system-ui, sans-serif',
        color: '#cccccc',
        background: '#1e1e1e',
        height: '100vh',
        margin: 0,
        padding: 24,
        boxSizing: 'border-box',
      }}
    >
      <h1 style={{ fontSize: 18, fontWeight: 600 }}>__APP_NAME__</h1>
      <p style={{ ...mono, color: state.ok ? '#4ec9b0' : '#f48771' }}>
        {state.ok ? '● ' : '○ '}
        {state.message}
      </p>
      {state.ok && state.kfe ? (
        <Ledger kfe={state.kfe} runtimeDir={state.runtimeDir} />
      ) : (
        <p style={{ ...mono, color: '#858585' }}>
          build @kungfu-tech/core (or set KFC_DIR) and relaunch
        </p>
      )}
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
