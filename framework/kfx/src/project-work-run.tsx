// SPDX-License-Identifier: Apache-2.0

import type {
  ProjectWorkRunPlan,
  ProjectWorkRunSnapshot,
} from '@kungfu-tech/api/capability';
import React from 'react';

const mono: React.CSSProperties = {
  fontFamily: 'var(--kf-mono-font-family, monospace)',
  fontSize: 'max(var(--kf-font-size, 12px), 13px)',
};

const actionStyle: React.CSSProperties = {
  ...mono,
  padding: '7px 11px',
  borderRadius: 6,
  border: '1px solid #4b4b4b',
  background: '#2d2d30',
  color: '#f1f1f1',
  cursor: 'pointer',
};

function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function ProjectWorkRunConfirmation({
  plan,
  busy = false,
  onConfirm,
  onCancel,
}: {
  plan: ProjectWorkRunPlan;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <dialog
      open
      aria-modal="true"
      aria-label="Confirm Work start"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        border: 'none',
        margin: 0,
        width: 'auto',
        height: 'auto',
        boxSizing: 'border-box',
        background: 'rgba(8, 12, 18, 0.68)',
        color: '#e6edf3',
        fontSize: 14,
        lineHeight: 1.55,
        display: 'grid',
        placeItems: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          width: 'min(760px, 92vw)',
          maxHeight: '88vh',
          overflow: 'auto',
          boxSizing: 'border-box',
          background: '#20262e',
          color: '#e6edf3',
          border: '1px solid #566575',
          borderRadius: 12,
          padding: 22,
          boxShadow: '0 24px 72px rgba(0, 0, 0, 0.5)',
        }}
      >
        <h3 style={{ margin: 0, color: '#ffffff', fontSize: 18 }}>
          Confirm Work start
        </h3>
        <div style={{ ...mono, color: '#9cdcfe', marginTop: 10, fontSize: 14 }}>
          {plan.work.title}
        </div>
        <div style={{ ...mono, color: '#d7dde5', marginTop: 4 }}>
          {plan.agent.label} · {plan.agent.verification.version || 'verified'}
        </div>
        <div style={{ ...mono, color: '#aeb8c4', marginTop: 4 }}>
          {plan.workspace.root}
        </div>
        {plan.executable ? (
          <>
            <p style={{ marginBottom: 6 }}>
              Kungfu will perform these effects once:
            </p>
            <ol style={{ marginTop: 0, paddingLeft: 24, color: '#e6edf3' }}>
              {plan.effects.map((effect) => (
                <li key={`${effect.stage}:${effect.label}`}>{effect.label}</li>
              ))}
            </ol>
          </>
        ) : null}
        <p style={{ ...mono, color: '#b8c2cc' }}>
          Completion, review, Git commit, push, and publication are not
          included. The exact plan is {plan.planRoot.slice(0, 24)}…
        </p>
        {!plan.executable ? (
          <p style={{ ...mono, color: '#f48771' }}>
            {plan.blockedReason ??
              'This plan is not executable. Verify the Agent and native source binding first.'}
          </p>
        ) : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            style={actionStyle}
            disabled={busy}
            onClick={onCancel}
          >
            Back
          </button>
          <button
            type="button"
            style={{
              ...actionStyle,
              borderColor: '#d7ba7d',
              opacity: busy || !plan.executable ? 0.55 : 1,
              cursor: busy || !plan.executable ? 'not-allowed' : 'pointer',
            }}
            disabled={busy || !plan.executable}
            onClick={onConfirm}
          >
            {busy ? 'Starting…' : 'Start Work'}
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function ProjectWorkRunSession({
  run,
  title,
  onClose,
  onReply,
  onApprove,
  onReview,
  onRetry,
}: {
  run: ProjectWorkRunSnapshot;
  title?: string;
  onClose?: () => void;
  onReply?: (text: string) => void;
  onApprove?: (approved: boolean) => void;
  onReview?: () => void;
  onRetry?: () => void;
}) {
  const [now, setNow] = React.useState(() => Date.now());
  const [reply, setReply] = React.useState('');
  const [panelHeight, setPanelHeight] = React.useState(320);
  const [fullscreen, setFullscreen] = React.useState(false);
  const resizeStart = React.useRef<{ y: number; height: number } | null>(null);
  const live = run.session?.live ?? run.running;
  React.useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const quietMs = now - run.lastEventAt;
  const spinner = ['◐', '◓', '◑', '◒'][Math.floor(now / 250) % 4];
  const attention = run.session?.attention;
  const status = live
    ? `${spinner} RUNNING · ${elapsedLabel(now - run.startedAt)}${
        quietMs >= 5000 ? ` · waiting ${elapsedLabel(quietMs)}` : ''
      }`
    : run.receipt
      ? `${run.receipt.status.toUpperCase()} · REVIEW REQUIRED`
      : 'NEEDS ATTENTION';
  return (
    <aside
      aria-label="Agent Work session"
      style={{
        position: fullscreen ? 'fixed' : 'relative',
        inset: fullscreen ? 12 : undefined,
        zIndex: fullscreen ? 1200 : undefined,
        border: '1px solid #4fc1ff',
        borderRadius: 8,
        background: '#0d1117',
        color: '#e6edf3',
        height: fullscreen ? 'auto' : panelHeight,
        minHeight: fullscreen ? 0 : 220,
        maxHeight: fullscreen ? 'none' : 'calc(100vh - 120px)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: fullscreen ? '0 24px 80px rgba(0, 0, 0, 0.72)' : undefined,
      }}
    >
      <header
        style={{
          ...mono,
          color: '#f1f1f1',
          background: live ? '#075985' : '#184b32',
          padding: '7px 10px',
          display: 'flex',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <span
          style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {title || run.work || run.task || 'Agent Work'} · {run.provider}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <span>{status}</span>
          <button
            type="button"
            aria-label={
              fullscreen ? 'Restore session view' : 'Fullscreen session view'
            }
            title={fullscreen ? 'Restore session panel' : 'Fill the window'}
            onClick={() => setFullscreen((value) => !value)}
            style={{
              ...mono,
              width: 28,
              height: 24,
              border: 'none',
              background: 'transparent',
              color: '#f1f1f1',
              cursor: 'pointer',
              marginLeft: 8,
              fontSize: 16,
            }}
          >
            {fullscreen ? '❐' : '⛶'}
          </button>
          {onClose ? (
            <button
              type="button"
              aria-label="Close session view"
              title="Hide this view; the Work keeps running"
              onClick={onClose}
              style={{
                ...mono,
                border: 'none',
                background: 'transparent',
                color: '#f1f1f1',
                cursor: 'pointer',
                width: 28,
                height: 24,
                marginLeft: 2,
                fontSize: 16,
              }}
            >
              ×
            </button>
          ) : null}
        </span>
      </header>
      <div style={{ padding: 10, overflow: 'auto', flex: 1 }}>
        {run.session?.terminalLines
          .filter((line) => line.trim())
          .map((line, index) => (
            <div
              key={`${index}:${line}`}
              style={{ ...mono, color: '#cccccc', whiteSpace: 'pre-wrap' }}
            >
              {line}
            </div>
          ))}
        {run.events.length === 0 && run.running ? (
          <div style={{ ...mono, color: '#858585' }}>
            Agent process started. Waiting for the first governed public event…
          </div>
        ) : null}
        {run.events.map((event) => (
          <div key={event.index} style={{ ...mono, color: '#cccccc' }}>
            <span style={{ color: '#858585' }}>
              {String(event.index).padStart(2, '0')} {event.stage}
            </span>{' '}
            {event.activity?.text || event.text}
          </div>
        ))}
        {run.receipt ? (
          <div
            style={{
              ...mono,
              color: run.receipt.ok ? '#89d185' : '#f48771',
              marginTop: 8,
            }}
          >
            Agent run retained · Work is {run.receipt.workPhase}.{' '}
            {run.receipt.nextActions[0] || 'Inspect the retained evidence.'}
          </div>
        ) : null}
        {run.error ? (
          <div style={{ ...mono, color: '#f48771', marginTop: 8 }}>
            {run.error}
          </div>
        ) : null}
      </div>
      {attention ? (
        <footer
          style={{
            borderTop: `2px solid ${attention.kind === 'blocked' ? '#f48771' : '#d7ba7d'}`,
            background: '#1b1b1d',
            padding: 10,
            display: 'grid',
            gap: 8,
          }}
        >
          <strong
            style={{
              ...mono,
              color: attention.kind === 'blocked' ? '#f48771' : '#d7ba7d',
            }}
          >
            {attention.kind.replaceAll('-', ' ').toUpperCase()}
          </strong>
          <span style={{ ...mono, color: '#cccccc' }}>{attention.message}</span>
          {attention.kind === 'needs-answer' && onReply ? (
            <form
              style={{ display: 'flex', gap: 8 }}
              onSubmit={(event) => {
                event.preventDefault();
                if (!reply.trim()) return;
                onReply(reply.trim());
                setReply('');
              }}
            >
              <input
                aria-label="Answer Agent"
                value={reply}
                onChange={(event) => setReply(event.currentTarget.value)}
                placeholder="Answer the Agent…"
                style={{
                  ...mono,
                  flex: 1,
                  minWidth: 0,
                  padding: '7px 9px',
                  color: '#f1f1f1',
                  background: '#0d1117',
                  border: '1px solid #4fc1ff',
                  borderRadius: 5,
                }}
              />
              <button type="submit" style={actionStyle}>
                Send
              </button>
              {onReview ? (
                <button type="button" style={actionStyle} onClick={onReview}>
                  Review changes
                </button>
              ) : null}
            </form>
          ) : null}
          {attention.kind === 'needs-approval' && onApprove ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                style={actionStyle}
                onClick={() => onApprove(true)}
              >
                Approve
              </button>
              <button
                type="button"
                style={actionStyle}
                onClick={() => onApprove(false)}
              >
                Deny
              </button>
            </div>
          ) : null}
          {attention.kind === 'ready-for-review' && onReview ? (
            <button type="button" style={actionStyle} onClick={onReview}>
              Review project changes
            </button>
          ) : null}
          {attention.kind === 'blocked' && onRetry ? (
            <button type="button" style={actionStyle} onClick={onRetry}>
              Start a fresh Agent attempt
            </button>
          ) : null}
        </footer>
      ) : null}
      {!fullscreen ? (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-label="Resize Agent session"
          title="Drag to resize the Agent session"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            const delta = event.key === 'ArrowUp' ? -24 : 24;
            const available = Math.max(320, window.innerHeight - 120);
            setPanelHeight((height) =>
              Math.min(available, Math.max(220, height + delta)),
            );
          }}
          onPointerDown={(event) => {
            resizeStart.current = { y: event.clientY, height: panelHeight };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!resizeStart.current) return;
            const available = Math.max(320, window.innerHeight - 120);
            setPanelHeight(
              Math.min(
                available,
                Math.max(
                  220,
                  resizeStart.current.height +
                    event.clientY -
                    resizeStart.current.y,
                ),
              ),
            );
          }}
          onPointerUp={(event) => {
            resizeStart.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            resizeStart.current = null;
          }}
          style={{
            height: 10,
            flexShrink: 0,
            cursor: 'ns-resize',
            borderTop: '1px solid #263b4d',
            background:
              'linear-gradient(transparent 3px, #6b7d8f 3px, #6b7d8f 5px, transparent 5px)',
          }}
        />
      ) : null}
    </aside>
  );
}
