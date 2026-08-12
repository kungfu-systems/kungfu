// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { render } from 'ink';
import React from 'react';
import {
  AgentFirstOnboardingView,
  tuiOnboardingActionFromInput,
} from './agent-work-lab-view.js';
import {
  buildTuiProductSearchDocuments,
  initialProductSurface,
  onboardingContinueSurface,
} from './control-plane-state.js';

class CaptureOutput extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  chunks: string[] = [];
  write = (value: string) => {
    this.chunks.push(String(value));
    return true;
  };
}

async function waitUntil(
  condition: () => boolean,
  description: string,
  timeoutMs = 3_000,
): Promise<void> {
  const expiresAt = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= expiresAt) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test('Getting Started copies the one-line Agent prompt with one key and confirms it', async () => {
  const output = new CaptureOutput();
  const actions: string[] = [];
  const props = {
    dimensions: { columns: 80, rows: 24 },
    state: {
      version: 1,
      status: 'completed' as const,
      route: 'agent' as const,
      labCompleted: false,
      tourCompleted: false,
      completedAt: '2026-08-02T00:00:00.000Z',
    },
    command:
      '/Applications/Kungfu.app/Contents/Resources/bin/kungfu agent brief',
    prompt: 'Run the local brief, then guide me through my first Work.',
    onAction: (action: string) => actions.push(action),
  };
  const instance = render(
    React.createElement(AgentFirstOnboardingView, props),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );

  try {
    await waitUntil(
      () =>
        output.chunks
          .join('')
          .includes('[C/c] Copy this one-line Agent prompt'),
      'the copy action label',
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    process.stdin.emit('data', Buffer.from('1'));
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    assert.equal(actions.length, 0);
    process.stdin.emit('data', Buffer.from('C'));
    await waitUntil(() => actions.includes('copy'), 'the copy action');
    instance.rerender(
      React.createElement(AgentFirstOnboardingView, {
        ...props,
        notice: {
          ok: true,
          title: 'ONE-LINE AGENT PROMPT COPIED',
          detail: 'Paste it into your Agent in another window.',
          next: 'Optional: [Enter] start · [L/l] Lab · [T/t] Tour.',
        },
      }),
    );
    await waitUntil(
      () => output.chunks.join('').includes('ONE-LINE AGENT PROMPT COPIED'),
      'the copy confirmation',
    );
    process.stdin.emit('data', Buffer.from('\r'));
    await waitUntil(() => actions.includes('continue'), 'the continue action');
  } finally {
    instance.unmount();
    instance.cleanup();
    process.stdin.pause();
  }

  const frame = output.chunks.join('');
  assert.match(frame, /Keep your agent\. Give it durable Work\./u);
  assert.match(frame, /kungfu run\s+codex\|claude\|opencode\|amp/u);
  assert.match(frame, /\[C\/c\] Copy this one-line Agent prompt/u);
  assert.match(frame, /\[Enter\] Continue to Kungfu/u);
  assert.match(frame, /\[L\/l\] Agent Work Lab/u);
  assert.match(frame, /\[T\/t\] Guided Project Tour/u);
  assert.match(frame, /Paste it into your Agent in another window\./u);
  assert.match(frame, /Optional: \[Enter\] start/u);
  assert.deepEqual(actions, ['copy', 'continue']);
});

test('Getting Started uses case-insensitive mnemonic keys instead of step numbers', () => {
  assert.deepEqual(
    ['c', 'C', '\r', 'l', 'L', 't', 'T', 's', 'S'].map(
      tuiOnboardingActionFromInput,
    ),
    [
      'copy',
      'copy',
      'continue',
      'lab',
      'lab',
      'tour',
      'tour',
      'dismiss',
      'dismiss',
    ],
  );
  for (const retiredKey of ['1', '2', '3', 'w', 'W']) {
    assert.equal(tuiOnboardingActionFromInput(retiredKey), null);
  }
});

test('Getting Started visually distinguishes its prompt and actionable keys', () => {
  const source = readFileSync(
    new URL('./agent-work-lab-view.tsx', import.meta.url),
    'utf8',
  );
  const onboarding = source.slice(
    source.indexOf('function OnboardingShortcutLine'),
    source.indexOf('export type TuiAgentWorkLabMode'),
  );
  assert.match(onboarding, /backgroundColor="yellow"/u);
  assert.equal(
    onboarding.includes('key={`prompt:${row}`} color="cyan" bold'),
    true,
  );
  assert.match(onboarding, /opaqueWidth=\{noticeColumns\}/u);
});

test('product search keeps daily views and low-frequency onboarding discoverable', () => {
  const documents = buildTuiProductSearchDocuments({
    quickCommands: [
      {
        id: 'sample',
        command: '/sample',
        summary: 'Describe the sample command.',
        title: 'Sample',
      },
    ],
    cliDocuments: [],
    workDocuments: [],
    projectDocuments: [],
  });
  const byId = new Map(documents.map((document) => [document.id, document]));
  assert.equal(byId.get('command.quick.sample')?.section, 'Quick actions');
  assert.equal(byId.get('view.work-control')?.title, 'All Work');
  assert.equal(byId.get('view.projects')?.title, 'Projects');
  assert.equal(byId.get('view.agent-work-lab')?.title, 'Agent Work Lab');
  assert.equal(byId.get('view.onboarding')?.title, 'Getting Started');
});

test('initial product surface keeps onboarding ahead of routine loading', () => {
  assert.equal(
    initialProductSurface({
      playbackMode: false,
      firstLaunch: true,
      emptyState: false,
    }),
    'onboarding',
  );
  assert.equal(
    initialProductSurface({
      playbackMode: false,
      firstLaunch: false,
      emptyState: true,
    }),
    'all-work',
  );
  assert.equal(
    initialProductSurface({
      playbackMode: true,
      firstLaunch: true,
      emptyState: false,
    }),
    'lab',
  );
  assert.equal(
    initialProductSurface({
      playbackMode: false,
      firstLaunch: true,
      emptyState: false,
      openLab: true,
    }),
    'lab',
  );
});

test('first-use Continue opens Projects while later visits return to All Work', () => {
  assert.equal(onboardingContinueSurface(true), 'projects');
  assert.equal(onboardingContinueSurface(false), 'all-work');
});
