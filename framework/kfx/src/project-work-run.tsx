// SPDX-License-Identifier: Apache-2.0

import type {
  ProjectWorkRunPlan,
  ProjectWorkRunSnapshot,
} from '@kungfu-tech/api/capability';
import React from 'react';

const mono: React.CSSProperties = {
  fontFamily: 'var(--kf-mono-font-family, monospace)',
  fontSize: 'var(--kf-font-size, 12px)',
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
        position: 'absolute',
        inset: 0,
        zIndex: 80,
        border: 'none',
        background: 'rgba(0,0,0,0.82)',
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
          background: '#252526',
          border: '2px solid #d7ba7d',
          borderRadius: 10,
          padding: 18,
          boxShadow: '0 18px 48px rgba(0,0,0,.65)',
        }}
      >
        <h3 style={{ margin: 0, color: '#f1f1f1' }}>Confirm Work start</h3>
        <div style={{ ...mono, color: '#9cdcfe', marginTop: 8 }}>
          {plan.work.title}
        </div>
        <div style={{ ...mono, color: '#cccccc', marginTop: 3 }}>
          {plan.agent.label} · {plan.agent.verification.version || 'verified'}
        </div>
        <div style={{ ...mono, color: '#858585', marginTop: 3 }}>
          {plan.workspace.root}
        </div>
        <p style={{ marginBottom: 6 }}>
          Kungfu will perform these effects once:
        </p>
        <ol style={{ marginTop: 0 }}>
          {plan.effects.map((effect) => (
            <li key={`${effect.stage}:${effect.label}`}>{effect.label}</li>
          ))}
        </ol>
        <p style={{ ...mono, color: '#a8a8a8' }}>
          Completion, review, Git commit, push, and publication are not
          included. The exact plan is {plan.planRoot.slice(0, 24)}…
        </p>
        {!plan.executable ? (
          <p style={{ ...mono, color: '#f48771' }}>
            This plan is not executable: verify the Agent and native source
            binding first.
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
            style={{ ...actionStyle, borderColor: '#d7ba7d' }}
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
        border: '1px solid #4fc1ff',
        borderRadius: 8,
        background: '#0d1117',
        minHeight: 160,
        maxHeight: 280,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
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
        <span>
          {title || run.work || run.task || 'Agent Work'} · {run.provider}
        </span>
        <span>
          {status}
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
                marginLeft: 10,
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
    </aside>
  );
}
