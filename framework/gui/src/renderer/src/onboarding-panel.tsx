// SPDX-License-Identifier: Apache-2.0

import {
  type KungfuOnboardingState,
  beginKungfuOnboardingRoute,
  dismissKungfuOnboarding,
  finishKungfuOnboarding,
} from '@kungfu-tech/api/capability';
import { mono } from '@kungfu-tech/kfx';
import React from 'react';

export type AgentFirstEntry = {
  state: KungfuOnboardingState;
  command: string;
  prompt: string;
  cliPath: string;
  cliInstalled: boolean;
};

const buttonStyle: React.CSSProperties = {
  ...mono,
  minHeight: 36,
  border: '1px solid #3c3c3c',
  borderRadius: 6,
  padding: '7px 12px',
  cursor: 'pointer',
  background: '#252526',
  color: '#e6edf3',
  textAlign: 'left',
};

export function AgentFirstOnboardingPanel({
  entry,
  onPersist,
  onInstallCli,
  onOpenLab,
  onOpenTour,
  onContinue,
}: {
  entry: AgentFirstEntry;
  onPersist: (state: KungfuOnboardingState) => Promise<void>;
  onInstallCli: () => Promise<void>;
  onOpenLab: () => void;
  onOpenTour: () => void;
  onContinue: () => void;
}) {
  const [notice, setNotice] = React.useState('');
  const persistThen = async (
    state: KungfuOnboardingState,
    next: () => void,
  ) => {
    try {
      await onPersist(state);
      next();
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Kungfu could not save your onboarding choice.',
      );
    }
  };
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(entry.prompt);
      await onPersist(beginKungfuOnboardingRoute(entry.state, 'agent'));
      setNotice('Prompt copied. Paste it into the agent you already use.');
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Kungfu could not copy or save the Agent prompt.',
      );
    }
  };
  return (
    <main
      aria-label="Getting started with Kungfu"
      style={{
        height: '100%',
        overflow: 'auto',
        boxSizing: 'border-box',
        display: 'flex',
        justifyContent: 'center',
        padding: 'clamp(24px, 5vw, 64px)',
        background: '#181818',
        color: '#e6edf3',
      }}
    >
      <section style={{ width: 'min(780px, 100%)' }}>
        <div style={{ ...mono, color: '#4ec9b0', fontSize: 12 }}>
          KUNGFU · AGENT-FIRST ENTRY
        </div>
        <h1 style={{ margin: '10px 0 8px', fontSize: 30 }}>
          Keep your agent. Give it durable Work.
        </h1>
        <p style={{ color: '#b7bec8', lineHeight: 1.55, maxWidth: 690 }}>
          Kungfu does not require a new chat or a new daily workspace. Start by
          teaching Codex, Claude, OpenCode, or Amp how to preserve Projects,
          Work, attempts, review, and settlement across sessions.
        </p>

        <div
          style={{
            marginTop: 20,
            padding: 16,
            border: '1px solid #375a4c',
            borderRadius: 8,
            background: '#15231d',
          }}
        >
          <div style={{ ...mono, color: '#89d6b2', marginBottom: 8 }}>
            1 · COPY THIS TO YOUR EXISTING AGENT
          </div>
          <div
            style={{
              ...mono,
              whiteSpace: 'pre-wrap',
              lineHeight: 1.55,
              color: '#f0f5f2',
            }}
          >
            {entry.prompt}
          </div>
          <div
            style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}
          >
            <button
              type="button"
              onClick={() => void copyPrompt()}
              style={{ ...buttonStyle, background: '#0e639c', color: '#fff' }}
            >
              Copy prompt for my Agent
            </button>
            {!entry.cliInstalled ? (
              <button
                type="button"
                onClick={() => {
                  void onInstallCli()
                    .then(() => {
                      setNotice('Kungfu is now available from your PATH.');
                    })
                    .catch((error: unknown) => {
                      setNotice(
                        error instanceof Error
                          ? error.message
                          : 'Kungfu could not be installed in PATH.',
                      );
                    });
                }}
                style={buttonStyle}
              >
                Install kungfu in PATH
              </button>
            ) : null}
          </div>
          <div
            style={{ ...mono, marginTop: 10, color: '#9aa0a6', fontSize: 12 }}
          >
            Exact local command: {entry.command}
          </div>
          {!entry.cliInstalled ? (
            <div
              style={{ ...mono, marginTop: 4, color: '#dcdcaa', fontSize: 12 }}
            >
              PATH is optional here because the copied prompt includes the exact
              local command.
            </div>
          ) : null}
        </div>

        <div style={{ marginTop: 22 }}>
          <div style={{ ...mono, color: '#9cdcfe', marginBottom: 9 }}>
            OPTIONAL · LEARN WITHOUT LEAVING KUNGFU
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
              gap: 10,
            }}
          >
            <button
              type="button"
              onClick={() => {
                void persistThen(
                  beginKungfuOnboardingRoute(entry.state, 'lab'),
                  onOpenLab,
                );
              }}
              style={buttonStyle}
            >
              <strong>Agent Work Lab</strong>
              <br />
              <span style={{ color: '#9aa0a6' }}>
                See continuity with a CI-safe Mock Agent.
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                void persistThen(
                  beginKungfuOnboardingRoute(entry.state, 'tour'),
                  onOpenTour,
                );
              }}
              style={buttonStyle}
            >
              <strong>Guided Project Tour</strong>
              <br />
              <span style={{ color: '#9aa0a6' }}>
                Create a starter Project and act on real Work.
              </span>
            </button>
          </div>
        </div>

        <p style={{ marginTop: 20, color: '#b7bec8', lineHeight: 1.5 }}>
          You can continue working in your current agent with{' '}
          <code>kungfu run codex|claude|opencode|amp</code>. This GUI and the
          TUI remain optional control and observation surfaces.
        </p>
        {notice ? <output style={{ color: '#4ec9b0' }}>{notice}</output> : null}
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button
            type="button"
            onClick={() => {
              void persistThen(
                finishKungfuOnboarding(entry.state, { route: 'agent' }),
                onContinue,
              );
            }}
            style={{ ...buttonStyle, background: '#2d5638' }}
          >
            Continue to Work
          </button>
          <button
            type="button"
            onClick={() => {
              void persistThen(
                dismissKungfuOnboarding(entry.state),
                onContinue,
              );
            }}
            style={{ ...buttonStyle, color: '#9aa0a6' }}
          >
            Don’t show again
          </button>
        </div>
      </section>
    </main>
  );
}
