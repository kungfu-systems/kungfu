// Managed session workspace — a canvas of PTY-backed terminals hosted inside
// the Kungfu GUI, so a user runs and watches several managed agent sessions at
// once without leaving Kungfu. This is the visual-concurrency wedge: one
// full-size session by default, with explicit resizable row/column layouts for
// concurrent sessions rather than a list you page through one detail at a time.
//
// The view is pure interaction UI: xterm.js for rendering and keyboard, and the
// declared `terminal` capability for the process. It never touches node-pty
// directly — the PTY host lives in the trusted renderer behind the capability
// boundary, so this view runs identically whether it is loaded node-integrated
// or in a locked sandbox reaching the capability over IPC.
//
// Durability: sessions start on the tmux backend (`backend: 'tmux'`) when the
// host has one, so closing a pane detaches (the agent keeps running) rather than
// killing it, and a detached session can be reattached from the recoverable
// tray. When no tmux backend is present the workspace degrades to direct
// sessions (no durability) and says so per pane. tmux is only a backend — this
// view speaks "session", never "tmux".
//
// Popping a session into its own OS window (ADR-0016 stage 2) is offered through
// the shell: the view stays electron-free and simply asks `shell.popOutSession`,
// which the node-integrated shell owns; the main process places and persists the
// window (F7 clamp on restore). Rendering the live terminal *inside* that OS
// window, rather than the stage-2 placeholder, is the next slice; cost/proof
// badges are later still.
//
// The capability is async at the sandbox boundary (an IPC hop cannot be
// synchronous); `resolve` awaits both the sync (node-integrated) and Promise
// (sandboxed-ipc) shapes so one code path serves both tiers.
import '@xterm/xterm/css/xterm.css';
import type {
  AgentRuntimeCatalog,
  AgentRuntimeProfile,
  KfxCapabilities,
  Shell,
  TerminalSession,
  WorkRef,
} from '@kungfu-tech/kfx';
import {
  buildAgentConsoleEnvelope,
  buildWorkRef,
  headingStyle,
  mono,
  panelStyle,
  prepareAgentConsoleLaunch,
} from '@kungfu-tech/kfx';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import React from 'react';
import {
  availableAgentRuntimeProfiles,
  rememberDiscoveredAgentRuntimeProfile,
} from './agent-runtime-catalog';
import {
  type AgentSessionProductProjection,
  agentSessionProductDetail,
  agentSessionProductLabel,
  resolveAgentSessionProduct,
} from './agent-session-presentation';
import { agentSessionSnapshotText } from './agent-session-snapshot';
import {
  DEFAULT_PANE_LAYOUT,
  type PaneLayoutAxis,
  type PaneLayoutMode,
  normalizePaneSizes,
  paneAxisForLayout,
  paneCountForLayout,
  resizeAdjacentPanes,
} from './pane-layout';
import {
  type PersistedWindow,
  type WorkspaceLayout,
  loadWorkspaceLayout,
  saveWorkspaceLayout,
} from './persistence';

async function resolve<T>(value: T | Promise<T>): Promise<T> {
  return await value;
}

// A tmux-safe run identity minted GUI-side. It becomes the session runId, the
// tmux name token, and the supervisor's cost/journal run_id — one id across all
// three so cost/state/proof facts attribute back to the on-screen session.
function mintRunId(): string {
  const raw =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(16)}-${Math.floor(Math.random() * 0xffffff).toString(16)}`;
  return `kfr-${raw.replace(/[^a-f0-9]/gi, '').slice(0, 12)}`;
}

async function workRefFromShell(shell: Shell): Promise<WorkRef | null> {
  const params = shell.params ?? {};
  const hasWorkRefParams = Boolean(
    params.workEntityId || params.workProfileId || params.workProfileRoot,
  );
  if (!hasWorkRefParams) return null;
  if (
    !params.workEntityId ||
    !params.workProfileId ||
    !params.workProfileRoot
  ) {
    throw new Error(
      'WorkRef launch requires workProfileId, workProfileRoot, and workEntityId',
    );
  }
  let entity: unknown = { id: params.workEntityId };
  try {
    entity = JSON.parse(params.workEntity ?? '{}');
  } catch {
    entity = { id: params.workEntityId };
  }
  return await buildWorkRef({
    workspaceId:
      params.workWorkspaceId ||
      (typeof process !== 'undefined'
        ? process.env.KF_WORKSPACE_ID || 'home'
        : 'home'),
    profileId: params.workProfileId,
    profileRoot: params.workProfileRoot,
    entityType: params.workEntityType || 'work',
    entityId: params.workEntityId,
    entity,
    purpose: params.workPurpose || `Advance ${params.workEntityId}`,
    systemTimeCut: params.workSystemTimeCut || new Date().toISOString(),
  });
}

// One pane on the canvas, bound to an already-created session by runId. The
// workspace owns creation (an event handler, not an effect) so a session is
// never spawned twice; a pane only attaches to it.
interface Pane {
  key: string;
  runId: string;
  title: string;
  provider: string;
  pid: number;
  startedAt: number;
  durable: boolean; // tmux-backed (survives close) vs direct
  // Retained so the pane can be persisted and re-adopted after a restart; the
  // surviving tmux session keeps its own process, these only label the record.
  command?: string;
  args?: string[];
  cwd?: string;
  consoleId?: string;
  attemptId?: string;
  runtimeProfileId?: string;
  capsule?: boolean;
  attachmentId?: string;
  actorId?: string;
}

const PANE_SEPARATOR_SIZE = 8;
const MIN_PANE_COLUMN_WIDTH = 240;
const MIN_PANE_ROW_HEIGHT = 180;

function ResizablePaneLayout({
  axis,
  sizes,
  onSizesChange,
  children,
}: {
  axis: PaneLayoutAxis;
  sizes: readonly number[];
  onSizesChange: (sizes: number[]) => void;
  children: React.ReactNode;
}) {
  const items = React.Children.toArray(children);
  const normalizedSizes = normalizePaneSizes(sizes, items.length);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<{
    pointerId: number;
    dividerIndex: number;
    startCoordinate: number;
    startSizes: number[];
    usableSize: number;
    minimumRatio: number;
  } | null>(null);

  const resizeFromDelta = React.useCallback(
    (
      dividerIndex: number,
      startSizes: number[],
      deltaRatio: number,
      minimumRatio: number,
    ) => {
      onSizesChange(
        resizeAdjacentPanes(startSizes, dividerIndex, deltaRatio, minimumRatio),
      );
    },
    [onSizesChange],
  );

  const beginResize = React.useCallback(
    (dividerIndex: number, event: React.PointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const containerSize =
        axis === 'columns' ? container.clientWidth : container.clientHeight;
      const usableSize = Math.max(
        1,
        containerSize - PANE_SEPARATOR_SIZE * (items.length - 1),
      );
      const minimumPixels =
        axis === 'columns' ? MIN_PANE_COLUMN_WIDTH : MIN_PANE_ROW_HEIGHT;
      dragRef.current = {
        pointerId: event.pointerId,
        dividerIndex,
        startCoordinate: axis === 'columns' ? event.clientX : event.clientY,
        startSizes: normalizedSizes,
        usableSize,
        minimumRatio: Math.min(
          1 / (items.length + 0.5),
          minimumPixels / usableSize,
        ),
      };
    },
    [axis, items.length, normalizedSizes],
  );

  const moveResize = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const coordinate = axis === 'columns' ? event.clientX : event.clientY;
      resizeFromDelta(
        drag.dividerIndex,
        drag.startSizes,
        (coordinate - drag.startCoordinate) / drag.usableSize,
        drag.minimumRatio,
      );
    },
    [axis, resizeFromDelta],
  );

  const endResize = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (dragRef.current?.pointerId === event.pointerId)
        dragRef.current = null;
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflow: 'auto',
        display: 'flex',
        flexDirection: axis === 'columns' ? 'row' : 'column',
      }}
    >
      {items.map((item, index) => (
        <React.Fragment key={(item as React.ReactElement).key ?? index}>
          <div
            style={{
              flex: `${normalizedSizes[index]} 1 0`,
              minWidth: axis === 'columns' ? MIN_PANE_COLUMN_WIDTH : 0,
              minHeight: axis === 'rows' ? MIN_PANE_ROW_HEIGHT : 0,
              overflow: 'hidden',
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr)',
              gridTemplateRows: 'minmax(0, 1fr)',
            }}
          >
            {item}
          </div>
          {index < items.length - 1 && (
            <div
              role="separator"
              aria-label={
                axis === 'columns'
                  ? 'Resize console columns'
                  : 'Resize console rows'
              }
              aria-orientation={axis === 'columns' ? 'vertical' : 'horizontal'}
              tabIndex={0}
              title={
                axis === 'columns'
                  ? 'Drag to resize columns'
                  : 'Drag to resize rows'
              }
              onPointerDown={(event) => beginResize(index, event)}
              onPointerMove={moveResize}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              onKeyDown={(event) => {
                const backward = axis === 'columns' ? 'ArrowLeft' : 'ArrowUp';
                const forward = axis === 'columns' ? 'ArrowRight' : 'ArrowDown';
                if (event.key !== backward && event.key !== forward) return;
                event.preventDefault();
                resizeFromDelta(
                  index,
                  normalizedSizes,
                  event.key === backward ? -0.04 : 0.04,
                  0.12,
                );
              }}
              style={{
                flex: `0 0 ${PANE_SEPARATOR_SIZE}px`,
                cursor: axis === 'columns' ? 'col-resize' : 'row-resize',
                touchAction: 'none',
                background: '#2b2b2b',
                border: 'none',
                outlineOffset: -2,
              }}
            />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function providerChipStyle(provider: string): React.CSSProperties {
  const claude = provider === 'claude';
  return {
    ...mono,
    fontSize: 10.5,
    padding: '1px 7px',
    borderRadius: 999,
    color: claude ? '#c7a86a' : '#7fb4d8',
    background: claude ? 'rgba(199,168,106,0.14)' : 'rgba(127,180,216,0.14)',
    whiteSpace: 'nowrap',
  };
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

const iconButtonStyle: React.CSSProperties = {
  ...mono,
  fontSize: 11,
  cursor: 'pointer',
  color: '#cccccc',
  background: 'transparent',
  border: '1px solid #3a3a3a',
  borderRadius: 6,
  padding: '2px 8px',
};

// A single session pane: an xterm attached to `runId`. It never spawns or kills
// on mount/unmount — creation and teardown are explicit workspace actions — so
// navigating away or a StrictMode double-mount cannot leak or double-run a
// session. Unmount only detaches the local listeners and disposes the terminal;
// the session keeps running behind the capability.
// The rolled-up cost summary for one run (from caps.rewind.loadRun().summary).
type RunSummary = NonNullable<
  ReturnType<KfxCapabilities['rewind']['loadRun']>
>['summary'];

// Honest per-session cost badge. Shows a $ total only when every CostSnapshot's
// usd is known; otherwise falls back to a token count (never a fake $0). '~' +
// amber marks ambiguous attribution (a shared account/window the source could
// not isolate); a dotted underline marks a weak attribution (observed delta,
// not exact-run). No cost yet (live run before its bundle is exported) renders
// nothing.
function CostBadge({ cost }: { cost: RunSummary }) {
  const usd = cost.costUsd;
  const known = cost.costUsdKnown === true && usd !== undefined;
  const tokens = (cost.inputTokens ?? 0n) + (cost.outputTokens ?? 0n);
  if (!known && tokens === 0n) return null;
  const ambiguous = cost.ambiguousAttribution === true;
  const weak = (cost.attribution ?? 0) >= 2; // ObservedSessionDelta or weaker
  const color = ambiguous ? '#d0a050' : known ? '#8a8f96' : '#6f7479';
  const text =
    known && usd !== undefined
      ? `${ambiguous ? '~' : ''}$${usd.toFixed(4)}`
      : `${tokens} tok`;
  const title = known
    ? `session cost${ambiguous ? ' — ambiguous attribution (shared account/window)' : ''}${weak ? ' — observed, not exact-run' : ''}`
    : 'usd unknown for this provider; showing token count';
  return (
    <span
      title={title}
      style={{ color, textDecoration: weak ? 'underline dotted' : 'none' }}
    >
      {' '}
      · {text}
    </span>
  );
}

function SessionPane({
  caps,
  pane,
  onDetach,
  onKill,
  onPopOut,
  onExit,
  poppedOut = false,
}: {
  caps: KfxCapabilities;
  pane: Pane;
  onDetach: (pane: Pane) => void;
  onKill: (pane: Pane) => void;
  // Present only when the shell can drive OS windows (ADR-0016 stage 2); the
  // pop-out affordance is hidden otherwise.
  onPopOut?: () => void;
  onExit?: (pane: Pane) => void;
  // ADR-0016 stage 4: true when this session is currently open in its own OS
  // window, so this in-grid pane is a frozen at-a-glance overview, not the
  // working surface. A PTY has one size; the working window owns it and resizes
  // it larger. So this pane freezes on pop-out — it holds its last in-grid frame
  // and stops rendering the stream (a full-screen TUI redraws for the window's
  // larger geometry, which this smaller cell would render deformed), never
  // drives the session size, and never writes input. When the window closes it
  // un-freezes, reclaims size authority, and goes live again. Absent (false) for
  // the working window's own pane and whenever the shell cannot drive windows.
  poppedOut?: boolean;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [status, setStatus] = React.useState<string>('running');
  const [ended, setEnded] = React.useState(false);
  const [nowTs, setNowTs] = React.useState(() => pane.startedAt);
  const [cost, setCost] = React.useState<RunSummary | null>(null);
  // Read the live popped-out flag from inside the xterm effect without tearing
  // the terminal down when it toggles (the effect keys only on the session).
  const poppedOutRef = React.useRef(poppedOut);
  // Re-assert the grid size when this pane reclaims authority (window closed);
  // set by the xterm effect, called by the toggle effect below.
  const reassertSizeRef = React.useRef<() => void>(() => {});

  React.useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    const term = new XTerm({
      // Concrete font + integer size + explicit lineHeight so FitAddon's cell
      // measurement matches the actual render height; a fractional size (12.5)
      // let the two drift, so fit proposed ~2 more rows than fit the box and a
      // full-screen TUI's bottom rows (tmux's status line) were clipped.
      fontFamily: 'Menlo, Monaco, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: { background: '#1a1a1a' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    // Cmd+C (mac) / Ctrl+Shift+C copies the current selection to the clipboard.
    // xterm keeps its own selection rather than a native one, so nothing copies
    // it without wiring. A frozen (popped-out) tile is a static frame, so its
    // selection persists and is exactly what a user wants to copy; a live tile
    // works too between redraws. Ctrl+C is left untouched so it still sends
    // SIGINT to a live session. navigator.clipboard keeps the view electron-free
    // (works node-integrated or sandboxed).
    term.attachCustomKeyEventHandler((e) => {
      const copyChord =
        (e.metaKey || (e.ctrlKey && e.shiftKey)) &&
        (e.key === 'c' || e.key === 'C');
      if (e.type === 'keydown' && copyChord && term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection());
        return false;
      }
      return true;
    });

    const refit = () => {
      try {
        fit.fit();
      } catch {
        // fit needs a laid-out element; transient failures are harmless
      }
    };
    refit();

    let dataSub: { stop?: () => void } | undefined;
    let exitSub: { stop?: () => void } | undefined;

    void (async () => {
      try {
        // onData replays the session's buffered output first, so a pane that
        // attaches to a session already in flight (including a reattach) shows
        // its history before live output.
        dataSub = await resolve(
          caps.terminal.onData(pane.runId, (data: string) => {
            // Frozen while popped out: hold the last in-grid frame rather than
            // render the stream the working window has resized the shared pty
            // to. One pty has one size; the window drives it larger, so a
            // full-screen TUI redraws for that larger geometry and this smaller
            // cell would render it deformed. Freezing at pop-out (optimistically
            // on the click, before the window ever touches the pty size) means
            // no deformed frame is ever shown; the window is the live surface.
            // On close the pane un-freezes and re-asserts the cell size, and the
            // next pty resize redraws it live again.
            if (poppedOutRef.current) return;
            term.write(data);
          }),
        );
        exitSub = await resolve(
          caps.terminal.onExit(pane.runId, (exit) => {
            setStatus(`exited (${exit.exitCode})`);
            setEnded(true);
            term.write(
              `\r\n\x1b[90m[session ended: code ${exit.exitCode}]\x1b[0m\r\n`,
            );
            onExit?.(pane);
          }),
        );
        term.onData((data) => {
          // Read-only while popped out: the OS window is the working surface;
          // this overview pane must not inject input into the shared PTY.
          if (poppedOutRef.current) return;
          void resolve(caps.terminal.write(pane.runId, data)).catch(() => {
            // writing to an ended session throws; the exit listener already
            // surfaced the end, so swallow the race here
          });
        });
        term.onResize(({ cols, rows }) => {
          // While popped out this pane does not own the PTY size; refit locally
          // (xterm still fills its grid cell) but let the window drive the pty.
          if (poppedOutRef.current) return;
          void resolve(caps.terminal.resize(pane.runId, cols, rows));
        });
      } catch (e) {
        setStatus('unavailable');
        term.write(
          `\r\n\x1b[31m[session unavailable: ${(e as Error).message}]\x1b[0m\r\n`,
        );
      }
    })();

    // Refit to the grid cell, not just the window: a pane resizes whenever the
    // canvas reflows (another pane added/removed, panel split moved). Observing
    // fires once with the settled size, which is what syncs the session away
    // from its spawn size — so a full-screen TUI (tmux) draws its status line at
    // the real bottom row. The fit's own resize event also propagates, but push
    // the session size explicitly here so a size that fit() considers unchanged
    // still reaches the pty.
    const syncSize = () => {
      refit();
      // Popped out: the window owns the pty size; refit the local xterm to the
      // cell but do not push the grid size to the shared session.
      if (poppedOutRef.current) return;
      if (term.cols > 0 && term.rows > 0) {
        void resolve(caps.terminal.resize(pane.runId, term.cols, term.rows));
      }
    };
    // Expose the sizer so the toggle effect can re-assert the grid size the
    // moment this pane reclaims authority (the window closed), pulling the pty
    // back down from the working window's size to the cell.
    reassertSizeRef.current = syncSize;
    const ro = new ResizeObserver(syncSize);
    ro.observe(el);

    return () => {
      ro.disconnect();
      dataSub?.stop?.();
      exitSub?.stop?.();
      term.dispose();
    };
  }, [caps.terminal, pane, onExit]);

  // Track the popped-out flag for the effect above, and re-assert the grid size
  // on the working window → grid transition (true → false) so the pty snaps back
  // to the cell instead of staying at the closed window's larger size.
  const wasPoppedOut = React.useRef(poppedOut);
  React.useEffect(() => {
    poppedOutRef.current = poppedOut;
    if (wasPoppedOut.current && !poppedOut) reassertSizeRef.current();
    wasPoppedOut.current = poppedOut;
  }, [poppedOut]);

  // Elapsed-time tick; stops once the session ends.
  React.useEffect(() => {
    if (ended) return;
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ended]);

  // Pull this session's rolled-up cost from the rewind ledger. Cost lands when
  // the run's bundle is exported (around run end), so poll a few seconds apart
  // so a just-ended session's cost appears without a manual refresh. (Per-pane
  // refresh is fine at dogfood scale; a workspace-level shared poll is a
  // follow-up if session counts grow.)
  React.useEffect(() => {
    let alive = true;
    const pull = () => {
      if (!alive) return;
      caps.rewind.refresh();
      setCost(caps.rewind.loadRun(pane.runId)?.summary ?? null);
    };
    pull();
    const id = setInterval(pull, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [caps.rewind, pane.runId]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 260,
        border: '1px solid #333',
        borderRadius: 8,
        background: '#1e1e1e',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 8px',
          borderBottom: '1px solid #2b2b2b',
          background: '#232323',
        }}
      >
        <span style={providerChipStyle(pane.provider)}>{pane.provider}</span>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <span
            style={{
              fontSize: 12,
              color: '#e6e6e6',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {pane.title}
          </span>
          <span style={{ ...mono, fontSize: 10, color: '#7a7a7a' }}>
            run {pane.runId} · pid {pane.pid} ·{' '}
            <span
              title={
                pane.durable
                  ? 'tmux-backed (survives close)'
                  : 'direct (no durability)'
              }
            >
              {pane.durable ? '● durable' : '○ direct'}
            </span>{' '}
            · {formatElapsed(nowTs - pane.startedAt)}
            {cost && <CostBadge cost={cost} />}
          </span>
        </div>
        <span
          style={{
            ...mono,
            fontSize: 10.5,
            color: ended ? '#c46b6b' : '#5bbf6a',
            whiteSpace: 'nowrap',
          }}
        >
          {status}
        </span>
        {poppedOut ? (
          <span
            title="Open in its own window, which is the live working surface and owns the size. This grid tile is frozen to its last frame to avoid deforming; it goes live again when the window closes."
            style={{
              ...mono,
              fontSize: 10.5,
              color: '#9cdcfe',
              border: '1px solid #2b4a5e',
              borderRadius: 6,
              padding: '2px 8px',
              whiteSpace: 'nowrap',
            }}
          >
            ⧉ 已弹出 · 网格已冻结
          </span>
        ) : (
          onPopOut && (
            <button
              type="button"
              onClick={onPopOut}
              title="Open this session in its own window"
              style={iconButtonStyle}
            >
              Pop out
            </button>
          )
        )}
        {!ended && pane.durable && (
          <button
            type="button"
            onClick={() => onDetach(pane)}
            title="Close this pane but keep the agent running (reattach later)"
            style={iconButtonStyle}
          >
            Detach
          </button>
        )}
        <button
          type="button"
          onClick={() => onKill(pane)}
          title={
            ended ? 'Remove this pane' : 'End the session and remove the pane'
          }
          style={{ ...iconButtonStyle, color: ended ? '#cccccc' : '#d98a8a' }}
        >
          {ended ? 'Close' : 'Kill'}
        </button>
      </div>
      <div
        ref={hostRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          // Frozen tiles dim slightly so a static last frame reads as paused,
          // not stalled — kept light enough that its text stays readable and
          // selectable for copy (the badge is the primary paused signal).
          opacity: poppedOut ? 0.65 : 1,
          transition: 'opacity 120ms ease',
        }}
      />
    </div>
  );
}

type CapsuleSurfaceStatus = {
  workConsoleId: string;
  sessionAttemptId: string;
  lifecycleState: string;
  interactionState: string;
  inputAdmission: string;
  queuedInstructions: number;
  live?: boolean;
  product?: AgentSessionProductProjection;
  providerAdapter?: {
    provider?: string;
    compatible?: boolean;
    reason?: string | null;
  };
  controller?: {
    holderId: string;
    leaseId: string;
    expiresAt: number;
  } | null;
  binding?: {
    kind: 'work' | 'workspace-assistant';
    workRef: WorkRef | null;
  };
};

type CapsuleSurfaceList = {
  sessions: CapsuleSurfaceStatus[];
  attempts?: CapsuleSurfaceStatus[];
};

type CapsuleSurfaceSnapshot = {
  status: CapsuleSurfaceStatus;
  terminal?: { vt?: { lines: string[] } };
  retainedTranscript?: boolean;
};

async function invokeAgentSession(
  caps: KfxCapabilities,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!caps.agentSession)
    throw new Error('Agent Session capability unavailable');
  return await caps.agentSession.invoke({
    operation: String(request.operation ?? ''),
    ...request,
  });
}

function CapsuleSessionPane({
  caps,
  pane,
  onDetach,
  onKill,
  onExit,
}: {
  caps: KfxCapabilities;
  pane: Pane;
  onDetach: (pane: Pane) => void;
  onKill: (pane: Pane) => void;
  onExit?: (pane: Pane) => void;
}) {
  const [snapshot, setSnapshot] = React.useState<CapsuleSurfaceSnapshot | null>(
    null,
  );
  const [instruction, setInstruction] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const ref = React.useMemo(
    () => ({
      workConsoleId: pane.consoleId ?? '',
      sessionAttemptId: pane.attemptId ?? '',
    }),
    [pane.attemptId, pane.consoleId],
  );

  React.useEffect(() => {
    let active = true;
    const pull = async () => {
      try {
        const received = (await invokeAgentSession(caps, {
          operation: 'snapshot',
          session: ref,
          requestedSequence: 0,
        })) as unknown as CapsuleSurfaceSnapshot;
        const value = received.status
          ? received
          : {
              ...received,
              status: (await invokeAgentSession(caps, {
                operation: 'status',
                session: ref,
              })) as unknown as CapsuleSurfaceStatus,
            };
        if (!active) return;
        setSnapshot(value);
        if (value.status.lifecycleState === 'ended') onExit?.(pane);
      } catch (error) {
        if (active) setNotice((error as Error).message);
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 250);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [caps, onExit, pane, ref]);

  const control = React.useCallback(
    async (
      operation:
        | 'acquire-control'
        | 'release-control'
        | 'instruct'
        | 'send-key'
        | 'interrupt',
      payload: Record<string, unknown>,
      automatic: boolean,
    ) => {
      const plan = await invokeAgentSession(caps, {
        operation: 'plan-control',
        controlOperation: operation,
        session: ref,
        payload,
      });
      const result = await invokeAgentSession(caps, {
        operation,
        actorId: pane.actorId,
        client: 'gui',
        plan,
        expectedPlanRoot: plan.root,
        payload,
        automatic,
      });
      setNotice(
        `${operation}: ${String(result.status)}${result.reason ? ` · ${String(result.reason)}` : ''}`,
      );
      return result;
    },
    [caps, pane.actorId, ref],
  );

  const sendInstruction = () => {
    const text = instruction.trim();
    if (!text) return;
    void control('instruct', { text, mode: 'when-ready' }, true)
      .then((result) => {
        if (result.status === 'written') setInstruction('');
      })
      .catch((error) => setNotice((error as Error).message));
  };
  const status = snapshot?.status;
  const product = status ? resolveAgentSessionProduct(status) : null;
  const ended = status?.lifecycleState === 'ended';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 260,
        border: '1px solid #333',
        borderRadius: 8,
        background: '#1e1e1e',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 8px',
          borderBottom: '1px solid #2b2b2b',
          background: '#232323',
        }}
      >
        <span style={providerChipStyle(pane.provider)}>{pane.provider}</span>
        <span style={{ flex: 1, fontSize: 12, color: '#e6e6e6' }}>
          {pane.title} · Agent session
        </span>
        <span
          style={{
            ...mono,
            fontSize: 10.5,
            color: ended ? '#c46b6b' : '#5bbf6a',
          }}
        >
          {product ? agentSessionProductLabel(product) : 'Attaching'}
        </span>
        {!ended && (
          <button
            type="button"
            onClick={() =>
              void control(
                status?.controller?.holderId === pane.actorId
                  ? 'release-control'
                  : 'acquire-control',
                {},
                false,
              ).catch((error) => setNotice((error as Error).message))
            }
            style={iconButtonStyle}
          >
            {status?.controller?.holderId === pane.actorId
              ? 'Release control'
              : 'Request control'}
          </button>
        )}
        {!ended && (
          <button
            type="button"
            onClick={() => onDetach(pane)}
            style={iconButtonStyle}
          >
            Detach
          </button>
        )}
        <button
          type="button"
          onClick={() => onKill(pane)}
          style={{ ...iconButtonStyle, color: ended ? '#cccccc' : '#d98a8a' }}
        >
          {ended ? 'Close' : 'End'}
        </button>
      </div>
      <pre
        style={{
          flex: 1,
          minHeight: 0,
          margin: 0,
          padding: 10,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          color: '#d4d4d4',
          background: '#1a1a1a',
          ...mono,
          fontSize: 12,
        }}
      >
        {agentSessionSnapshotText(snapshot)}
      </pre>
      {!ended && (
        <div
          style={{
            display: 'flex',
            gap: 6,
            padding: 8,
            borderTop: '1px solid #2b2b2b',
          }}
        >
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="Send a semantic instruction through the Interaction Port"
            rows={2}
            style={{ flex: 1, resize: 'vertical', ...mono, fontSize: 11 }}
          />
          <button
            type="button"
            onClick={sendInstruction}
            style={iconButtonStyle}
          >
            Send
          </button>
          {['y', 'n', 'Enter', 'Escape'].map((key) => (
            <button
              key={key}
              type="button"
              title={`Manual controller key: ${key}`}
              onClick={() =>
                void control('send-key', { key }, false).catch((error) =>
                  setNotice((error as Error).message),
                )
              }
              style={iconButtonStyle}
            >
              {key}
            </button>
          ))}
          <button
            type="button"
            onClick={() =>
              void control('interrupt', {}, false).catch((error) =>
                setNotice((error as Error).message),
              )
            }
            style={{ ...iconButtonStyle, color: '#d98a8a' }}
          >
            Interrupt
          </button>
        </div>
      )}
      {notice && (
        <div
          style={{
            padding: '0 8px 6px',
            ...mono,
            fontSize: 10,
            color: '#c9a227',
          }}
        >
          {notice} · delivery is not work proof
        </div>
      )}
    </div>
  );
}

// Compact launcher: clicking a profile ADDS a pane (concurrent), it does not
// replace the canvas. The list is an overview, never the main interaction.
function LauncherStrip({
  profiles,
  bindingLabel,
  busy,
  loaded,
  error,
  onLaunch,
  onRetry,
  onConfigure,
}: {
  profiles: AgentRuntimeProfile[];
  bindingLabel: string;
  busy: boolean;
  loaded: boolean;
  error: string;
  onLaunch: (profile: AgentRuntimeProfile) => void;
  onRetry: () => void;
  onConfigure: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      }}
    >
      <span style={{ ...mono, fontSize: 11, color: '#858585' }}>
        {bindingLabel}:
      </span>
      {profiles.map((p) => (
        <button
          key={p.id}
          type="button"
          disabled={busy}
          onClick={() => onLaunch(p)}
          title={`${p.launch.executable} · ${p.backendDefault}${p.source === 'discovered' ? ' · detected' : ''}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            ...mono,
            fontSize: 11.5,
            cursor: 'pointer',
            color: '#e6e6e6',
            background: '#2a2a2a',
            border: '1px solid #3a3a3a',
            borderRadius: 7,
            padding: '4px 9px',
          }}
        >
          <span style={providerChipStyle(p.provider)}>{p.provider}</span>
          {p.label.replace(/^.*·\s*/, '')}
          <span style={{ color: '#5bbf6a', fontWeight: 600 }}>+</span>
        </button>
      ))}
      {profiles.length === 0 && busy && (
        <span style={{ ...mono, fontSize: 11, color: '#858585' }}>
          Detecting Codex and Claude…
        </span>
      )}
      {profiles.length === 0 && !busy && error && (
        <>
          <span style={{ ...mono, fontSize: 11, color: '#f48771' }}>
            Agent detection failed · {error}
          </span>
          <button type="button" onClick={onRetry} style={iconButtonStyle}>
            Retry
          </button>
        </>
      )}
      {profiles.length === 0 && loaded && !busy && !error && (
        <span style={{ ...mono, fontSize: 11, color: '#dcdcaa' }}>
          No Codex or Claude executable detected
        </span>
      )}
      {profiles.length === 0 && loaded && !busy && !error && (
        <button type="button" onClick={onConfigure} style={iconButtonStyle}>
          Configure Agent
        </button>
      )}
    </div>
  );
}

// Sessions that are alive-but-detached or dead-but-recorded and not currently on
// the canvas. Detached sessions reattach into a fresh pane; orphaned/ended ones
// can only be dismissed (killed to clear the record).
function RecoverableTray({
  sessions,
  onReattach,
  onDismiss,
  onRefresh,
}: {
  sessions: TerminalSession[];
  onReattach: (session: TerminalSession) => void;
  onDismiss: (session: TerminalSession) => void;
  onRefresh: () => void;
}) {
  return (
    <div style={{ ...panelStyle, padding: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...headingStyle, margin: 0 }}>
          recoverable sessions · {sessions.length}
        </span>
        <button type="button" onClick={onRefresh} style={iconButtonStyle}>
          Refresh
        </button>
      </div>
      {sessions.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            marginTop: 8,
          }}
        >
          {sessions.map((s) => {
            const detached = s.status === 'detached';
            return (
              <div
                key={s.runId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 8px',
                  borderRadius: 7,
                  border: '1px solid #333',
                  background: '#232323',
                }}
              >
                <span style={providerChipStyle(s.provider ?? 'agent')}>
                  {s.provider ?? 'agent'}
                </span>
                <span style={{ ...mono, fontSize: 10.5, color: '#9a9a9a' }}>
                  {s.runId} · {s.status}
                </span>
                {detached ? (
                  <button
                    type="button"
                    onClick={() => onReattach(s)}
                    style={{ ...iconButtonStyle, color: '#7fb4d8' }}
                  >
                    Reattach
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => onDismiss(s)}
                    style={{ ...iconButtonStyle, color: '#d98a8a' }}
                  >
                    Dismiss
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CapsuleHubTray({
  sessions,
  attachedAttemptIds,
  onAttach,
  onRefresh,
}: {
  sessions: CapsuleSurfaceStatus[];
  attachedAttemptIds: Set<string>;
  onAttach: (session: CapsuleSurfaceStatus) => void;
  onRefresh: () => void;
}) {
  return (
    <div style={{ ...panelStyle, padding: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...headingStyle, margin: 0 }}>
          Agent sessions · {sessions.length}
        </span>
        <button type="button" onClick={onRefresh} style={iconButtonStyle}>
          Refresh
        </button>
      </div>
      {sessions.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            marginTop: 8,
          }}
        >
          {sessions.map((session) => {
            const attached = attachedAttemptIds.has(session.sessionAttemptId);
            const attachable = session.live !== false;
            const product = resolveAgentSessionProduct(session);
            return (
              <div
                key={session.sessionAttemptId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 8px',
                  borderRadius: 7,
                  border: '1px solid #333',
                  background: '#232323',
                }}
              >
                <span
                  style={providerChipStyle(
                    session.providerAdapter?.provider ?? 'agent',
                  )}
                >
                  {session.providerAdapter?.provider ?? 'agent'}
                </span>
                <span style={{ ...mono, fontSize: 10.5, color: '#9a9a9a' }}>
                  {session.workConsoleId} · {agentSessionProductLabel(product)}
                </span>
                {product.state === 'action-required' && (
                  <span style={{ ...mono, fontSize: 10.5, color: '#c9a227' }}>
                    {agentSessionProductDetail(product)}
                  </span>
                )}
                {attachable && (
                  <button
                    type="button"
                    disabled={attached}
                    onClick={() => onAttach(session)}
                    style={{
                      ...iconButtonStyle,
                      color: attached ? '#666' : '#7fb4d8',
                    }}
                  >
                    {attached ? 'Attached' : 'Attach'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SessionWorkspace({
  caps,
  shell,
}: { caps: KfxCapabilities; shell: Shell }) {
  const domain = caps.domain;
  const workspaceId =
    shell.params?.workWorkspaceId ||
    (typeof process !== 'undefined'
      ? process.env.KF_WORKSPACE_ID || 'home'
      : 'home');
  const [panes, setPanes] = React.useState<Pane[]>([]);
  const [activeRunId, setActiveRunId] = React.useState<string | null>(null);
  const [paneLayout, setPaneLayout] =
    React.useState<PaneLayoutMode>(DEFAULT_PANE_LAYOUT);
  const [paneSizes, setPaneSizes] = React.useState<number[]>([1]);
  const [recoverable, setRecoverable] = React.useState<TerminalSession[]>([]);
  const [capsuleSessions, setCapsuleSessions] = React.useState<
    CapsuleSurfaceStatus[]
  >([]);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [catalog, setCatalog] = React.useState<AgentRuntimeCatalog | null>(
    null,
  );
  const [catalogBusy, setCatalogBusy] = React.useState(true);
  const [catalogError, setCatalogError] = React.useState('');
  // The per-session OS window set (ADR-0016 stage 2). Seeded from the persisted
  // layout, then driven by the main process, which owns the real windows and
  // pushes a snapshot on every open/close/move; we mirror it back into the
  // layout. Empty and inert when the shell cannot drive windows (flag off /
  // sandbox), in which case the persisted windows are preserved untouched.
  const [windowRecords, setWindowRecords] = React.useState<PersistedWindow[]>(
    [],
  );
  // ADR-0016 stage 4: sessions whose grid tile should freeze *now*, set the
  // instant Pop out is clicked — before the window opens and resizes the shared
  // pty — so no deformed frame is ever shown. It is only an optimistic bridge:
  // the very next window snapshot is authoritative (it will include a session
  // that opened, or omit one that failed/closed), so this resets on each
  // snapshot and the durable frozen state comes from `windowRecords`.
  const [poppingOut, setPoppingOut] = React.useState<Set<string>>(
    () => new Set(),
  );
  // Persistence is gated on the domain capability; absent it the workspace is
  // ephemeral. `hydrated` blocks the save effect until the initial restore has
  // read the stored layout, so mounting never clobbers it with an empty set.
  const hydrated = React.useRef(false);

  const refreshCatalog = React.useCallback(async () => {
    if (!caps.agentRuntime) {
      setNotice('Agent Runtime capability unavailable');
      return;
    }
    setCatalogBusy(true);
    try {
      setCatalog(await caps.agentRuntime.list());
      setCatalogError('');
    } catch (error) {
      setCatalogError((error as Error).message);
    } finally {
      setCatalogBusy(false);
    }
  }, [caps.agentRuntime]);

  React.useEffect(() => {
    void refreshCatalog();
    const offRefresh = shell.onRefresh(() => void refreshCatalog());
    const onFocus = () => void refreshCatalog();
    window.addEventListener('focus', onFocus);
    return () => {
      offRefresh();
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshCatalog, shell]);

  const panedIds = React.useMemo(
    () => new Set(panes.map((p) => p.runId)),
    [panes],
  );

  React.useEffect(() => {
    if (panes.length === 0) {
      setActiveRunId(null);
      return;
    }
    if (!activeRunId || !panes.some((pane) => pane.runId === activeRunId)) {
      setActiveRunId(panes[0].runId);
    }
  }, [activeRunId, panes]);

  const visiblePanes = React.useMemo(() => {
    if (panes.length === 0) return [];
    const activeIndex = Math.max(
      0,
      panes.findIndex((pane) => pane.runId === activeRunId),
    );
    const ordered = [
      ...panes.slice(activeIndex),
      ...panes.slice(0, activeIndex),
    ];
    return ordered.slice(
      0,
      Math.min(paneCountForLayout(paneLayout), ordered.length),
    );
  }, [activeRunId, paneLayout, panes]);

  const selectPaneLayout = React.useCallback((mode: PaneLayoutMode) => {
    setPaneLayout(mode);
    setPaneSizes(normalizePaneSizes([], paneCountForLayout(mode)));
  }, []);

  // ADR-0016 stage 4: the sessions whose grid tile is frozen — those confirmed
  // open in their own OS window (the durable truth the main process pushes),
  // plus any just-clicked ones still opening (the optimistic bridge, so the
  // freeze wins the race against the window's first pty resize). A tile in this
  // set holds its last frame and yields the pty size to its window (see
  // SessionPane `poppedOut`).
  const poppedOutRunIds = React.useMemo(() => {
    const ids = new Set(windowRecords.map((w) => w.runId));
    for (const id of poppingOut) ids.add(id);
    return ids;
  }, [windowRecords, poppingOut]);

  // Restore on mount (W4): read the persisted layout and re-adopt each durable
  // session by runId. A session still alive on the tmux socket comes back
  // attached; a gone one is dropped (direct sessions cannot survive a restart).
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only restore; caps/domain/shell identity is stable per runtime
  React.useEffect(() => {
    if (!domain) {
      hydrated.current = true;
      return;
    }
    // Read synchronously before the save effect can run, so the stored layout
    // is captured even though adoption is async.
    const layout = loadWorkspaceLayout(domain);
    // Seed the window set so the first persist preserves it; the main process
    // then becomes the source of truth once it restores and emits a snapshot.
    setWindowRecords(layout.windows);
    let cancelled = false;
    void (async () => {
      const restored: Pane[] = [];
      for (const p of [...layout.panes].sort((a, b) => a.order - b.order)) {
        if (p.backend !== 'tmux') continue;
        try {
          const s = await resolve(
            caps.terminal.adopt({
              runId: p.runId,
              provider: p.provider,
              command: p.command,
              args: p.args,
              cwd: p.cwd,
            }),
          );
          if (s.status === 'running') {
            restored.push({
              key: s.runId,
              runId: s.runId,
              title: p.title,
              provider: p.provider,
              pid: s.pid,
              startedAt: p.startedAt || s.startedAt,
              durable: true,
              command: p.command,
              args: p.args,
              cwd: p.cwd,
              consoleId: p.consoleId,
              attemptId: p.attemptId,
              runtimeProfileId: p.runtimeProfileId,
            });
          }
        } catch {
          // un-adoptable (gone / no tmux) — leave it out of the restored set
        }
      }
      if (!cancelled) {
        if (restored.length > 0) setPanes(restored);
        if (restored.length > 0) setActiveRunId(restored[0].runId);
        // Restore only windows whose session actually came back; a window for a
        // gone session cannot show anything, so it is dropped. The main process
        // clamps each saved rectangle onto a present display (F7).
        const liveRunIds = new Set(restored.map((r) => r.runId));
        const liveWindows = layout.windows.filter((w) =>
          liveRunIds.has(w.runId),
        );
        if (liveWindows.length > 0) shell.restoreSessionWindows?.(liveWindows);
        hydrated.current = true;
        // the pane-set change triggers the tray refresh effect below; no need
        // to call refresh() here (it is declared later)
      }
    })();
    return () => {
      cancelled = true;
    };
    // run once on mount; caps/domain/shell identity is stable for a given runtime
  }, []);

  // Mirror the main process's live window set into our state so the persist
  // effect writes it into the layout. Inert when the shell cannot drive windows.
  React.useEffect(() => {
    return shell.onSessionWindowsSnapshot?.((windows) => {
      setWindowRecords(windows);
      // The snapshot is authoritative: a session that opened is now in it (stays
      // frozen via windowRecords), one that failed/closed is not (un-freezes).
      // Either way the optimistic bridge has served its purpose — clear it.
      setPoppingOut((prev) => (prev.size ? new Set() : prev));
    });
  }, [shell]);

  // Persist on change (W4): once hydrated, mirror the live pane set and the
  // per-session window set into the config-backed layout so a restart can bring
  // the durable sessions and their windows back.
  React.useEffect(() => {
    if (!domain || !hydrated.current) return;
    const layout: WorkspaceLayout = {
      version: 1,
      workspaceId: 'default',
      panes: panes.map((p, i) => ({
        runId: p.runId,
        provider: p.provider,
        title: p.title,
        backend: p.capsule ? 'capsule' : p.durable ? 'tmux' : 'direct',
        command: p.command,
        args: p.args,
        cwd: p.cwd,
        startedAt: p.startedAt,
        order: i,
        consoleId: p.consoleId,
        attemptId: p.attemptId,
        runtimeProfileId: p.runtimeProfileId,
      })),
      windows: windowRecords,
    };
    saveWorkspaceLayout(domain, layout);
  }, [panes, domain, windowRecords]);

  const refresh = React.useCallback(async () => {
    try {
      // discover reconciles the known session map (marks truly-gone sessions
      // orphaned; a dead socket is left untouched), then list reflects it.
      await resolve(caps.terminal.discover()).catch(() => undefined);
      const all = await resolve(caps.terminal.list());
      setRecoverable(
        all.filter(
          (s) =>
            (s.status === 'detached' || s.status === 'orphaned') &&
            !panedIds.has(s.runId),
        ),
      );
    } catch {
      setRecoverable([]);
    }
    if (caps.agentSession) {
      try {
        const listed = (await invokeAgentSession(caps, {
          operation: 'list',
        })) as unknown as CapsuleSurfaceList;
        setCapsuleSessions(listed.attempts ?? listed.sessions);
      } catch {
        setCapsuleSessions([]);
      }
    } else {
      setCapsuleSessions([]);
    }
  }, [caps, panedIds]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const launch = React.useCallback(
    async (profile: AgentRuntimeProfile) => {
      if (profile.source === 'discovered' && caps.agentRuntime) {
        try {
          await rememberDiscoveredAgentRuntimeProfile(
            caps.agentRuntime,
            profile,
          );
          setCatalog(await caps.agentRuntime.list());
          setCatalogError('');
        } catch (error) {
          setNotice(
            `Using detected ${profile.label}; could not remember it: ${(error as Error).message}`,
          );
        }
      }
      const runId = mintRunId();
      const attemptId = `attempt:${runId}`;
      const workRef = await workRefFromShell(shell);
      const fallbackConsoleId = workRef
        ? `work:${workRef.profileId}:${workRef.entityType}:${workRef.entityId}`
        : `assistant:${workspaceId}`;
      const binding = workRef
        ? { kind: 'work' as const, workRef }
        : { kind: 'workspace-assistant' as const, workRef: null };
      const resolution = caps.agentSession
        ? await invokeAgentSession(caps, {
            operation: 'resolve-console',
            input: { workspaceId, binding },
          })
        : null;
      const consoleId = String(resolution?.workConsoleId ?? fallbackConsoleId);
      const envelope = await buildAgentConsoleEnvelope({
        workspaceId,
        consoleId,
        attemptId,
        runtimeProfile: profile,
        workRef,
        activeProfiles: workRef
          ? [{ id: workRef.profileId, root: workRef.profileRoot }]
          : [],
      });
      const prepared = prepareAgentConsoleLaunch({
        profile,
        envelope,
        workspaceRoot:
          typeof process !== 'undefined'
            ? process.env.KF_WORKSPACE_ROOT
            : undefined,
        home: typeof process !== 'undefined' ? process.env.HOME : undefined,
      });
      const { command, args, cwd, env } = prepared;
      if (caps.agentSession) {
        const actorId = `gui:${workspaceId}`;
        const inherited =
          typeof process !== 'undefined'
            ? Object.fromEntries(
                [
                  'PATH',
                  'HOME',
                  'TERM',
                  'LANG',
                  'LC_ALL',
                  'KUNGFU_BIN',
                  'KUNGFU_CLI_BIN',
                  'KUNGFU_AGENT_SESSION_ENDPOINT',
                ]
                  .map((name) => [name, process.env[name]])
                  .filter((entry): entry is [string, string] =>
                    Boolean(entry[1]),
                  ),
              )
            : {};
        const capsuleEnv = {
          ...inherited,
          ...env,
          KUNGFU_AGENT_SESSION_ACTOR: actorId,
          KUNGFU_AGENT_SESSION_CLIENT: 'kfd3-agent',
        };
        const verification = caps.agentRuntime
          ? await caps.agentRuntime.verify(profile.id)
          : null;
        if (!verification?.ok || !verification.version) {
          throw new Error(
            verification?.error ||
              `${profile.label} must pass the bounded version probe before Capsule launch`,
          );
        }
        const plan = await invokeAgentSession(caps, {
          operation: 'plan-start',
          client: 'gui',
          actorId,
          input: {
            workConsoleId: consoleId,
            sessionAttemptId: attemptId,
            provider: profile.provider,
            providerVersion: verification.version,
            profileRoot: workRef?.profileRoot ?? envelope.envelopeRoot,
            executable: command,
            argv: args,
            cwd,
            env: capsuleEnv,
            workspaceId,
            runtimeProfileId: profile.id,
            binding,
          },
        });
        const effectiveAttemptId = String(plan.sessionAttemptId);
        const attachmentId = `gui:${effectiveAttemptId}`;
        await invokeAgentSession(caps, {
          operation: 'start',
          client: 'gui',
          actorId,
          plan,
          expectedPlanRoot: plan.root,
          attachment: {
            attachmentId,
            presentation: workRef
              ? 'go-card-side-console'
              : 'assistant-console',
          },
          execution: { env: capsuleEnv, cols: 80, rows: 24 },
        });
        const sessionStatus = (await invokeAgentSession(caps, {
          operation: 'show',
          session: {
            workConsoleId: consoleId,
            sessionAttemptId: effectiveAttemptId,
          },
        })) as unknown as CapsuleSurfaceStatus;
        const effectiveProvider =
          sessionStatus.providerAdapter?.provider ?? profile.provider;
        const effectiveProfileId =
          plan.operation === 'attach-existing'
            ? `agent-session:${effectiveProvider}`
            : profile.id;
        const startedAt = Date.now();
        setPanes((prev) => [
          ...prev,
          {
            key: effectiveAttemptId,
            runId: effectiveAttemptId,
            title:
              plan.operation === 'attach-existing'
                ? `${effectiveProvider} · existing`
                : profile.label,
            provider: effectiveProvider,
            pid: 0,
            startedAt,
            durable: true,
            command,
            args,
            cwd,
            consoleId,
            attemptId: effectiveAttemptId,
            runtimeProfileId: effectiveProfileId,
            capsule: true,
            attachmentId,
            actorId,
          },
        ]);
        setActiveRunId(effectiveAttemptId);
        void refresh();
        return;
      }
      let session: TerminalSession;
      let durable = prepared.backend === 'tmux';
      try {
        session = await resolve(
          caps.terminal.spawn({
            command,
            args,
            cwd,
            env,
            runId,
            workId: workRef?.entityId,
            provider: profile.provider,
            backend: prepared.backend,
            cols: 80,
            rows: 24,
          }),
        );
      } catch {
        if (prepared.backend !== 'tmux') throw new Error('agent launch failed');
        durable = false;
        setNotice(
          'no tmux backend — sessions run directly and do not survive close',
        );
        session = await resolve(
          caps.terminal.spawn({
            command,
            args,
            cwd,
            env,
            runId,
            workId: workRef?.entityId,
            provider: profile.provider,
            cols: 80,
            rows: 24,
          }),
        );
      }
      setPanes((prev) => [
        ...prev,
        {
          key: session.runId,
          runId: session.runId,
          title: profile.label,
          provider: profile.provider,
          pid: session.pid,
          startedAt: session.startedAt,
          durable,
          command,
          args,
          cwd,
          consoleId,
          attemptId,
          runtimeProfileId: profile.id,
        },
      ]);
      setActiveRunId(session.runId);
    },
    [caps, refresh, shell, workspaceId],
  );

  const detachPane = React.useCallback(
    (pane: Pane) => {
      if (pane.capsule) {
        void invokeAgentSession(caps, {
          operation: 'detach',
          actorId: pane.actorId,
          session: {
            workConsoleId: pane.consoleId,
            sessionAttemptId: pane.attemptId,
          },
          attachmentId: pane.attachmentId,
        })
          .then(() => {
            setPanes((prev) => prev.filter((p) => p.key !== pane.key));
            void refresh();
          })
          .catch((error) => setNotice((error as Error).message));
        return;
      }
      try {
        caps.terminal.detach(pane.runId);
      } catch {
        // a non-durable or already-ended session has nothing to detach
      }
      setPanes((prev) => prev.filter((p) => p.key !== pane.key));
      void refresh();
    },
    [caps, refresh],
  );

  const killPane = React.useCallback(
    (pane: Pane) => {
      if (pane.capsule) {
        if (!pane.consoleId || !pane.attemptId) {
          setPanes((prev) => prev.filter((p) => p.key !== pane.key));
          return;
        }
        const session = {
          workConsoleId: pane.consoleId,
          sessionAttemptId: pane.attemptId,
        };
        void invokeAgentSession(caps, {
          operation: 'plan-control',
          controlOperation: 'end',
          session,
          payload: {},
        })
          .then((plan) =>
            invokeAgentSession(caps, {
              operation: 'end',
              actorId: pane.actorId,
              client: 'gui',
              plan,
              expectedPlanRoot: plan.root,
              payload: {},
              automatic: false,
            }),
          )
          .then(() => {
            setPanes((prev) => prev.filter((p) => p.key !== pane.key));
            void refresh();
          })
          .catch((error) => setNotice((error as Error).message));
        return;
      }
      try {
        caps.terminal.kill(pane.runId);
      } catch {
        // best-effort
      }
      setPanes((prev) => prev.filter((p) => p.key !== pane.key));
      void refresh();
    },
    [caps, refresh],
  );

  const attachCapsule = React.useCallback(
    async (session: CapsuleSurfaceStatus) => {
      const actorId = `gui:${workspaceId}`;
      const attachmentId = `gui:hub:${workspaceId}:${session.sessionAttemptId}`;
      await invokeAgentSession(caps, {
        operation: 'attach',
        actorId,
        client: 'gui',
        session: {
          workConsoleId: session.workConsoleId,
          sessionAttemptId: session.sessionAttemptId,
        },
        attachment: { attachmentId, presentation: 'console-hub' },
        acquireControl: false,
      });
      const provider = session.providerAdapter?.provider ?? 'agent';
      const now = Date.now();
      setPanes((current) =>
        current.some(
          (candidate) =>
            candidate.attemptId === session.sessionAttemptId &&
            candidate.capsule,
        )
          ? current
          : [
              ...current,
              {
                key: session.sessionAttemptId,
                runId: session.sessionAttemptId,
                title: `${provider} · ${session.workConsoleId}`,
                provider,
                pid: 0,
                startedAt: now,
                durable: true,
                consoleId: session.workConsoleId,
                attemptId: session.sessionAttemptId,
                runtimeProfileId: `agent-session:${provider}`,
                capsule: true,
                attachmentId,
                actorId,
              },
            ],
      );
      setActiveRunId(session.sessionAttemptId);
    },
    [caps, workspaceId],
  );

  const reattach = React.useCallback(
    async (s: TerminalSession) => {
      try {
        const session = await resolve(caps.terminal.reattach(s.runId));
        setPanes((prev) =>
          prev.some((p) => p.runId === session.runId)
            ? prev
            : [
                ...prev,
                {
                  key: session.runId,
                  runId: session.runId,
                  title: `${session.provider ?? 'agent'} · ${session.command}`,
                  provider: session.provider ?? 'agent',
                  pid: session.pid,
                  startedAt: session.startedAt,
                  durable: true,
                  command: session.command,
                  args: session.args,
                  cwd: session.cwd,
                },
              ],
        );
      } catch (e) {
        setNotice(`reattach failed: ${(e as Error).message}`);
      }
      void refresh();
    },
    [caps.terminal, refresh],
  );

  const dismiss = React.useCallback(
    (s: TerminalSession) => {
      try {
        caps.terminal.kill(s.runId);
      } catch {
        // best-effort
      }
      void refresh();
    },
    [caps.terminal, refresh],
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        gap: 8,
      }}
    >
      <LauncherStrip
        profiles={availableAgentRuntimeProfiles(catalog)}
        bindingLabel={
          shell.params?.workEntityId
            ? `Go · ${shell.params.workEntityId}`
            : 'Workspace assistant'
        }
        busy={catalogBusy}
        loaded={catalog !== null}
        error={catalogError}
        onLaunch={(profile) => {
          void launch(profile).catch((error) =>
            setNotice(`Agent launch failed: ${(error as Error).message}`),
          );
        }}
        onRetry={() => void refreshCatalog()}
        onConfigure={() => shell.open('settings')}
      />
      {panes.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            minHeight: 30,
            overflowX: 'auto',
            borderBottom: '1px solid #333',
            paddingBottom: 5,
          }}
        >
          {panes.map((pane) => (
            <button
              key={pane.runId}
              type="button"
              onClick={() => setActiveRunId(pane.runId)}
              title={pane.consoleId ?? pane.runId}
              style={{
                ...iconButtonStyle,
                flex: '0 0 auto',
                color: pane.runId === activeRunId ? '#9cdcfe' : '#858585',
                borderColor: pane.runId === activeRunId ? '#2d8fcc' : '#3a3a3a',
                background:
                  pane.runId === activeRunId ? '#04395e' : 'transparent',
              }}
            >
              {pane.provider} · {pane.title}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          {(
            [
              ['single', '▣', 'Single pane'],
              ['columns-2', '◫', 'Two columns'],
              ['rows-2', '⬒', 'Two rows'],
              ['columns-3', '▥', 'Three columns'],
              ['rows-3', '☷', 'Three rows'],
            ] as const
          ).map(([mode, icon, label]) => (
            <button
              key={mode}
              type="button"
              disabled={panes.length < paneCountForLayout(mode)}
              onClick={() => selectPaneLayout(mode)}
              title={label}
              aria-label={label}
              style={{
                ...iconButtonStyle,
                color: paneLayout === mode ? '#9cdcfe' : '#858585',
                opacity: panes.length < paneCountForLayout(mode) ? 0.35 : 1,
              }}
            >
              {icon}
            </button>
          ))}
        </div>
      )}
      {notice && (
        <div style={{ ...mono, fontSize: 11, color: '#c9a227' }}>{notice}</div>
      )}
      <CapsuleHubTray
        sessions={capsuleSessions}
        attachedAttemptIds={
          new Set(
            panes
              .filter((pane) => pane.capsule && pane.attemptId)
              .map((pane) => pane.attemptId as string),
          )
        }
        onAttach={(session) => {
          void attachCapsule(session).catch((error) =>
            setNotice(`Capsule attach failed: ${(error as Error).message}`),
          );
        }}
        onRefresh={() => void refresh()}
      />
      <RecoverableTray
        sessions={recoverable}
        onReattach={reattach}
        onDismiss={dismiss}
        onRefresh={() => void refresh()}
      />
      {panes.length === 0 ? (
        <div
          style={{
            ...panelStyle,
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#6a6a6a',
            ...mono,
            fontSize: 12,
          }}
        >
          launch a session above — panes stack here, several visible at once
        </div>
      ) : (
        <ResizablePaneLayout
          axis={paneAxisForLayout(paneLayout)}
          sizes={normalizePaneSizes(paneSizes, visiblePanes.length)}
          onSizesChange={setPaneSizes}
        >
          {visiblePanes.map((pane) =>
            pane.capsule ? (
              <CapsuleSessionPane
                key={pane.key}
                caps={caps}
                pane={pane}
                onDetach={detachPane}
                onKill={killPane}
              />
            ) : (
              <SessionPane
                key={pane.key}
                caps={caps}
                pane={pane}
                onDetach={detachPane}
                onKill={killPane}
                onPopOut={
                  shell.popOutSession
                    ? () => {
                        // Freeze this tile before the window opens and resizes the
                        // shared pty, so no deformed frame is ever rendered.
                        setPoppingOut((prev) => {
                          const next = new Set(prev);
                          next.add(pane.runId);
                          return next;
                        });
                        shell.popOutSession?.(pane.runId);
                      }
                    : undefined
                }
                poppedOut={poppedOutRunIds.has(pane.runId)}
              />
            ),
          )}
        </ResizablePaneLayout>
      )}
    </div>
  );
}

// The content of a per-session OS window (ADR-0016 stage 3): it adopts one
// already-created session by runId over the shared main-process host and renders
// a single full-window pane, replacing the stage-2 placeholder page. It owns no
// launcher, tray, or layout persistence — the in-shell grid owns those; this
// window is only a view onto one session. Closing the window never ends the
// session (window identity is separate from session identity, ADR-0016): detach
// keeps the agent running and kill ends it, and either way the window closes.
function SingleSessionWindow({
  caps,
  runId,
}: { caps: KfxCapabilities; runId: string }) {
  const [pane, setPane] = React.useState<Pane | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // The session already exists on the shared host; just read its snapshot
        // to label the pane. The pane attaches to the live stream on its own.
        const session = await resolve(caps.terminal.get(runId));
        if (cancelled) return;
        if (!session) {
          setError(`session ${runId} is not on the host`);
          return;
        }
        setPane({
          key: session.runId,
          runId: session.runId,
          title: `${session.provider ?? 'agent'} · ${session.command}`,
          provider: session.provider ?? 'agent',
          pid: session.pid,
          startedAt: session.startedAt,
          durable: session.backend === 'tmux',
          command: session.command,
          args: session.args,
          cwd: session.cwd,
        });
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [caps.terminal, runId]);

  const frame: React.CSSProperties = {
    height: '100vh',
    boxSizing: 'border-box',
    padding: 8,
    background: '#1e1e1e',
  };

  if (error) {
    return (
      <div style={{ ...frame, ...mono, fontSize: 12, color: '#c46b6b' }}>
        {error}
      </div>
    );
  }
  if (!pane) {
    return (
      <div style={{ ...frame, ...mono, fontSize: 12, color: '#7a7a7a' }}>
        attaching to session {runId}…
      </div>
    );
  }
  return (
    // one grid cell that stretches the pane to fill the window, the same way the
    // in-shell grid stretches a cell — SessionPane needs a stretching parent
    <div
      style={{
        ...frame,
        display: 'grid',
        gridTemplateColumns: '1fr',
        gridTemplateRows: '1fr',
      }}
    >
      <SessionPane
        caps={caps}
        pane={pane}
        onDetach={(p) => {
          try {
            caps.terminal.detach(p.runId);
          } catch {
            // a direct (non-tmux) session has nothing to detach; close anyway
          }
          window.close();
        }}
        onKill={(p) => {
          try {
            caps.terminal.kill(p.runId);
          } catch {
            // best-effort; close the window regardless
          }
          window.close();
        }}
      />
    </div>
  );
}

// The kfx entry. In the shell it renders the full session workspace; opened as a
// per-session OS window (ADR-0016 stage 3) the renderer passes the target runId
// through `shell.params.sessionWindowRunId`, and it renders that one session.
function View({ caps, shell }: { caps: KfxCapabilities; shell: Shell }) {
  const runId = shell.params?.sessionWindowRunId;
  if (runId) return <SingleSessionWindow caps={caps} runId={runId} />;
  return <SessionWorkspace caps={caps} shell={shell} />;
}

export { View };
