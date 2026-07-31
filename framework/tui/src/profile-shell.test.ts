// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import test from 'node:test';
import { Box, render } from 'ink';
import React from 'react';

import {
  PlaybackBar,
  ProfileShell,
  type ProfileShellModel,
  profileShellCardPanelContainsPoint,
  renderProfileShellSnapshot,
  resolveProfileShellLayout,
} from './profile-shell.js';

class CaptureOutput extends Writable {
  readonly isTTY = false;
  readonly chunks: string[] = [];

  constructor(
    readonly columns = 80,
    readonly rows = 24,
  ) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(String(chunk));
    callback();
  }
}

const WORK_CONTROL_FIXTURE: ProfileShellModel = {
  profile: {
    id: 'kungfu.work-control',
    title: 'Work Control',
    version: 'Profile/KFD-3',
    suiteRoot: 'sha256:profile-suite-root',
    qualified: true,
  },
  subject: {
    id: 'initiative-a',
    title: 'Initiative A',
    subtitle: 'Keep public evidence and responsibility visible.',
  },
  navigation: [
    { id: 'initiative-a', label: 'Initiative A', status: 'active' },
    { id: 'initiative-b', label: 'Initiative B', status: 'paused' },
  ],
  cards: [
    [
      'initiative-intent',
      'What are we trying to achieve?',
      'declared',
      'Initiative A — keep public evidence visible.',
    ],
    [
      'observed-progress',
      'What actually happened?',
      'observed',
      '3 Assignment(s) at this cut · active=2 · blocked=1',
    ],
    [
      'evidence-at-cut',
      'What does the evidence establish at this cut?',
      'established',
      'canonical cut · 1 finding(s) · proof abcdef123456',
    ],
    [
      'fitness-for-purpose',
      'Is delegated work still fit for purpose?',
      'fit',
      'fit · assessment not-assessed · residual limits 1',
    ],
    [
      'next-responsibility',
      'Who should act next?',
      'declared',
      'codex/root: implement the terminal shell',
    ],
  ].map(([id, title, status, summary]) => ({ id, title, status, summary })),
  evidence: [
    {
      label: 'profile suite',
      value: 'sha256:11111111111111111111111111111111',
    },
    {
      label: 'query definition',
      value: 'sha256:22222222222222222222222222222222',
    },
    { label: 'query proof', value: 'sha256:33333333333333333333333333333333' },
  ],
  notice: 'read-only',
};

for (const qualification of [
  {
    columns: 80,
    rows: 24,
    mode: 'one-column',
    digest: '547348d747e23ff8158592e17d9a620aae1fbe270c75936da7e3f65ee4a304f4',
  },
  {
    columns: 120,
    rows: 36,
    mode: 'two-column',
    digest: '6973544177af617a0bb16ed86a119f67403d55404cca81f80757d4086de60783',
  },
  {
    columns: 160,
    rows: 48,
    mode: 'three-column',
    digest: '6f7b80e502ad338b63f5a5ea07ee03080528532eb1044936ba4a5240178bfb6d',
  },
] as const) {
  test(`qualifies the ${qualification.columns}x${qualification.rows} renderer snapshot`, () => {
    const dimensions = {
      columns: qualification.columns,
      rows: qualification.rows,
    };
    assert.equal(
      resolveProfileShellLayout(dimensions).mode,
      qualification.mode,
    );
    const snapshot = renderProfileShellSnapshot(
      WORK_CONTROL_FIXTURE,
      dimensions,
    );
    const lines = snapshot.split('\n');
    assert.equal(lines.length, qualification.rows);
    assert.ok(lines.every((line) => line.length === qualification.columns));
    const digest = createHash('sha256').update(snapshot).digest('hex');
    assert.equal(digest, qualification.digest);
  });
}

test('empty and degraded fixtures remain deterministic and explicit', () => {
  const empty = {
    ...WORK_CONTROL_FIXTURE,
    navigation: [],
    cards: [],
    notice: 'empty',
  };
  const degraded = {
    ...empty,
    profile: { ...empty.profile, qualified: false },
    subject: {
      id: '',
      title: 'Profile unavailable',
      subtitle: 'fixture failure',
    },
    notice: 'degraded without mutation',
  };
  assert.match(
    renderProfileShellSnapshot(empty, { columns: 80, rows: 24 }),
    /subjects none/,
  );
  assert.match(
    renderProfileShellSnapshot(degraded, { columns: 80, rows: 24 }),
    /KFD-3 not qualified · degraded without mutation/,
  );
});

test('resize crosses each responsive qualification boundary', () => {
  assert.deepEqual(
    [
      { columns: 160, rows: 48 },
      { columns: 120, rows: 36 },
      { columns: 80, rows: 24 },
    ].map((size) => resolveProfileShellLayout(size).mode),
    ['three-column', 'two-column', 'one-column'],
  );
});

test('the shared Work Loop appears on the first terminal screen', () => {
  const snapshot = renderProfileShellSnapshot(
    {
      ...WORK_CONTROL_FIXTURE,
      workLoop: {
        status: 'active',
        confidence: 'medium',
        cutStatus: 'current',
        cutRoot: 'sha256:project-cut-root',
        workId: 'work-1',
        gaps: ['assignment-binding-unavailable'],
        nextActions: ['checkpoint', 'complete'],
        recoveryAction: 'checkpoint',
        recoveryCode: 'work-current',
      },
    },
    { columns: 80, rows: 24 },
  );
  assert.match(snapshot, /Cut current · Work active · confidence medium/);
  assert.match(
    snapshot,
    /current work-1 · recovery checkpoint \(work-current\)/,
  );
  assert.match(snapshot, /gaps assignment-binding-unavailable/);
  assert.match(snapshot, /next checkpoint, complete/);
});

test('a Work Loop read failure stays visible without hiding Work Control', () => {
  const snapshot = renderProfileShellSnapshot(
    {
      ...WORK_CONTROL_FIXTURE,
      workLoopError: 'current Cut is ambiguous',
    },
    { columns: 80, rows: 24 },
  );
  assert.match(snapshot, /Work Loop unavailable · current Cut is ambiguous/);
  assert.match(snapshot, /Initiative A — Keep public evidence/);
  assert.match(snapshot, /no mutation attempted/);
});

test('the real Ink 80x24 first screen renders all five questions', async () => {
  const output = new CaptureOutput();
  const instance = render(
    React.createElement(ProfileShell, {
      model: WORK_CONTROL_FIXTURE,
      dimensions: { columns: 80, rows: 24 },
    }),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  instance.unmount();
  instance.cleanup();
  const rendered = output.chunks.join('');
  for (const card of WORK_CONTROL_FIXTURE.cards) {
    assert.match(rendered, new RegExp(card.title.replace(/[?]/g, '\\?')));
  }
});

test('compact Project mode retains visible Files and Work navigation', async () => {
  const output = new CaptureOutput();
  const instance = render(
    React.createElement(ProfileShell, {
      model: {
        ...WORK_CONTROL_FIXTURE,
        subject: {
          id: 'work',
          title: 'Work · 3',
          subtitle: '/projects/agent-work-starter',
        },
        navigationTitle: 'Project',
        navigation: [
          { id: 'files', label: 'Files', status: 'tree' },
          { id: 'work', label: 'Work', status: '3' },
        ],
        retainNavigationInCompact: true,
      },
      dimensions: { columns: 80, rows: 24 },
    }),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  instance.unmount();
  instance.cleanup();

  const rendered = output.chunks.join('');
  assert.match(rendered, /Project/);
  assert.match(rendered, /Files tree/);
  assert.match(rendered, /› Work 3/);
});

test('the real Ink two-column All Work screen keeps card titles and summaries on separate rows', async () => {
  const output = new CaptureOutput(120, 36);
  const title = 'Kungfu alpha retention inventory';
  const model: ProfileShellModel = {
    ...WORK_CONTROL_FIXTURE,
    profile: {
      ...WORK_CONTROL_FIXTURE.profile,
      title: 'All Work',
      version: 'Machine view',
    },
    subject: {
      id: 'active',
      title: 'Active Work · 20',
      subtitle: '20 active · 0 completed · 7 Projects known on this machine',
    },
    navigation: [
      { id: 'active', label: 'Active', status: '20' },
      { id: 'completed', label: 'Completed', status: '0' },
      { id: 'all', label: 'All', status: '20' },
    ],
    cards: Array.from({ length: 20 }, (_, index) => ({
      id: `work-${index}`,
      title: index === 0 ? title : `Additional Work ${index}`,
      status: 'stage-ready',
      summary: '1 Project observation',
    })),
  };
  const instance = render(
    React.createElement(ProfileShell, {
      model,
      dimensions: { columns: 120, rows: 36 },
    }),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  instance.unmount();
  instance.cleanup();

  const rendered = output.chunks.join('');
  const lines = rendered.split('\n');
  const titleRow = lines.findIndex((line) => line.includes(title));
  const summaryRow = lines.findIndex((line) =>
    line.includes('1 Project observation'),
  );
  assert.notEqual(titleRow, -1);
  assert.equal(summaryRow, titleRow + 1);
  assert.doesNotMatch(rendered, /Project observationntion inventory/u);
});

test('All Work mouse hit testing admits only the visible card panel', () => {
  const dimensions = { columns: 120, rows: 36 };
  assert.equal(
    profileShellCardPanelContainsPoint({
      model: WORK_CONTROL_FIXTURE,
      dimensions,
      column: 60,
      row: 10,
      topOffset: 1,
    }),
    true,
  );
  assert.equal(
    profileShellCardPanelContainsPoint({
      model: WORK_CONTROL_FIXTURE,
      dimensions,
      column: 10,
      row: 10,
      topOffset: 1,
    }),
    false,
  );
  assert.equal(
    profileShellCardPanelContainsPoint({
      model: WORK_CONTROL_FIXTURE,
      dimensions,
      column: 60,
      row: 32,
      topOffset: 1,
    }),
    false,
  );
});

test('playback bar is explicitly non-interactive', async () => {
  const output = new CaptureOutput();
  const instance = render(
    React.createElement(
      Box,
      { width: 80, height: 24 },
      React.createElement(PlaybackBar, {
        dimensions: { columns: 80, rows: 24 },
        label: 'DEMO PLAYBACK',
        status: 'Agent Work Lab · Offline continuity',
        hint: 'Automatic · No input required · exits after the final result',
      }),
    ),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  instance.unmount();
  instance.cleanup();
  const rendered = output.chunks.join('');
  assert.match(rendered, /DEMO PLAYBACK/);
  assert.match(rendered, /No input required/);
  assert.doesNotMatch(rendered, /Type a message/);
});
