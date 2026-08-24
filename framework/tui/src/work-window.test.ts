// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';

import type {
  GlobalWorkSnapshot,
  ProjectsCatalog,
} from '@kungfu-tech/api/capability';
import { render } from 'ink';
import React from 'react';

import {
  WorkWindow,
  agentBootstrapLine,
  buildWorkWindowModel,
  cycleWorkSort,
  formatWorkUpdatedAt,
  workWindowInputAction,
} from './work-window/index.js';

test('project Work input interpreter separates text, composer, and run commands', () => {
  const base = {
    planPending: false,
    retainedAgentReviewable: false,
  };
  assert.deepEqual(
    workWindowInputAction('\b', { ...base, agentReply: 'answer' }),
    { kind: 'set-agent-reply', value: 'answe' },
  );
  assert.deepEqual(
    workWindowInputAction('\r', {
      ...base,
      composer: {
        step: 'objective',
        objective: 'Ship the change',
        acceptanceCriterion: '',
      },
    }),
    {
      kind: 'set-composer',
      value: {
        step: 'acceptance',
        objective: 'Ship the change',
        acceptanceCriterion: '',
      },
      message: 'Define the result that independent review should check.',
    },
  );
  assert.deepEqual(workWindowInputAction('n', { ...base, planPending: true }), {
    kind: 'cancel-plan',
  });
  assert.deepEqual(
    workWindowInputAction('\r', { ...base, retainedAgentReviewable: true }),
    { kind: 'continue-retained-work' },
  );
  assert.deepEqual(
    workWindowInputAction('r', { ...base, attentionKind: 'blocked' }),
    { kind: 'retry-agent-attempt' },
  );
});

test('Agent bootstrap projection names pending, verified, and degraded states', () => {
  const base = {
    attemptId: 'native:one',
    receiptRoot: null,
    mutationsAllowed: false,
  };
  assert.equal(
    agentBootstrapLine({ ...base, state: 'pending' }),
    'Bootstrap · pending · Work mutations blocked',
  );
  assert.equal(
    agentBootstrapLine({
      ...base,
      state: 'verified',
      receiptRoot: `sha256:${'a'.repeat(64)}`,
      mutationsAllowed: true,
    }),
    'Bootstrap · verified · Work mutations enabled',
  );
  assert.equal(
    agentBootstrapLine({ ...base, state: 'degraded' }),
    'Bootstrap · degraded · Work mutations blocked',
  );
});

class CaptureOutput extends Writable {
  readonly isTTY = false;
  readonly columns = 80;
  readonly rows = 24;
  readonly chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(String(chunk));
    callback();
  }
}

const snapshot: GlobalWorkSnapshot = {
  schema: 'kungfu.workspace-federation.query/v1',
  observed_at: '2026-07-30T10:00:00Z',
  aggregate: { state: 'complete', component_count: 2 },
  verification: { ok: true },
  global_work: {
    visible_work: [
      {
        canonical_root: 'sha256:older',
        object_kind: 'assignment',
        subject: 'older',
        display: {
          title: 'Older Work',
          status: 'active',
          updated_at: '2026-07-29T08:00:00Z',
        },
        observations: [{ workspace_id: 'project:b' }],
      },
      {
        canonical_root: 'sha256:newer',
        object_kind: 'assignment',
        subject: 'newer',
        display: {
          title: 'Newer Work',
          status: 'executing',
          updated_at: '2026-07-30T09:00:00Z',
        },
        observations: [{ workspace_id: 'project:a' }],
      },
      {
        canonical_root: 'sha256:done',
        object_kind: 'assignment',
        subject: 'done',
        display: {
          title: 'Completed Work',
          status: 'completed',
          updated_at: '2026-07-28T09:00:00Z',
        },
        observations: [{ workspace_id: 'project:a' }],
      },
    ],
  },
};

const projects: ProjectsCatalog = {
  schema: 'kungfu.projects.catalog/v1',
  projects: [
    {
      schema: 'kungfu.project/v1',
      id: 'project:a',
      name: 'Alpha',
      path: '/work/alpha',
      available: true,
      selected: false,
      initialized: true,
      state: 'available',
    },
    {
      schema: 'kungfu.project/v1',
      id: 'project:b',
      name: 'Beta',
      path: '/work/beta',
      available: true,
      selected: false,
      initialized: true,
      state: 'available',
    },
  ],
  selectedProjectId: null,
  registryPath: '',
  libraryPath: '',
  sources: {},
  hiddenProjectCount: 0,
  writeOccurred: false,
  catalogRoot: 'sha256:catalog',
};

test('Work Window applies Active, Completed, and All as filters of one grouped model', () => {
  const active = buildWorkWindowModel(snapshot, { projects });
  assert.deepEqual(active.counts, { active: 2, completed: 1, all: 3 });
  assert.deepEqual(
    active.groups.map((group) => [
      group.name,
      group.items.map((item) => item.title),
    ]),
    [
      ['Alpha', ['Newer Work']],
      ['Beta', ['Older Work']],
    ],
  );
  assert.deepEqual(
    buildWorkWindowModel(snapshot, {
      filter: 'completed',
      projects,
    }).items.map((item) => item.title),
    ['Completed Work'],
  );
  assert.equal(
    buildWorkWindowModel(snapshot, { filter: 'all', projects }).items.length,
    3,
  );
});

test('Work Window keeps Project groups while cycling supported sort modes', () => {
  const byProject = buildWorkWindowModel(snapshot, {
    filter: 'all',
    sort: 'project-asc',
    projects,
  });
  assert.deepEqual(
    byProject.groups.map((group) => group.name),
    ['Alpha', 'Beta'],
  );
  assert.equal(cycleWorkSort('updated-desc'), 'project-asc');
  assert.equal(cycleWorkSort('project-asc'), 'title-asc');
  assert.equal(cycleWorkSort('title-asc'), 'updated-desc');
});

test('Work Window presents a bounded human update age', () => {
  assert.equal(
    formatWorkUpdatedAt(
      '2026-07-30T09:30:00Z',
      Date.parse('2026-07-30T10:00:00Z'),
    ),
    '30m ago',
  );
  assert.equal(formatWorkUpdatedAt(''), 'unknown');
});

test('real Ink Work Window keeps Project, Work, update, filters, and sort visible at 80x24', async () => {
  const output = new CaptureOutput();
  const model = buildWorkWindowModel(snapshot, { projects });
  const instance = render(
    React.createElement(WorkWindow, {
      model,
      dimensions: { columns: 80, rows: 24 },
      selected: 0,
      busy: false,
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
  assert.match(rendered, /ALL WORK · Active · 2/u);
  assert.match(rendered, /PROJECT · Alpha · \/work\/alpha/u);
  assert.match(rendered, /Newer Work \[executing\]/u);
  assert.match(rendered, /Project Alpha · Updated/u);
  assert.match(rendered, /Completed 1/u);
  assert.match(rendered, /Sort · Updated ↓/u);
});

test('an empty machine Work graph fills the main Work panel with a nebula', async () => {
  const output = new CaptureOutput();
  const emptySnapshot: GlobalWorkSnapshot = {
    ...snapshot,
    aggregate: { state: 'complete', component_count: 0 },
    global_work: {
      visible_work: [],
      visible_work_count: 0,
      canonical_work_count: 0,
    },
  };
  const instance = render(
    React.createElement(WorkWindow, {
      model: buildWorkWindowModel(emptySnapshot, { projects }),
      dimensions: { columns: 100, rows: 28 },
      selected: 0,
      busy: false,
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

  const rendered = stripVTControlCharacters(output.chunks.join(''));
  assert.match(rendered, /ALL WORK · Active · 0/u);
  assert.match(rendered, /[•●✦]/u);
  assert.doesNotMatch(rendered, /No Active Work/u);
});

test('Work Window keeps long crowded rows inside one fixed 80x24 frame', async () => {
  const crowdedProjects: ProjectsCatalog = {
    ...projects,
    projects: Array.from({ length: 12 }, (_, index) => ({
      ...(projects.projects[0] as ProjectsCatalog['projects'][number]),
      id: `project:${index}`,
      name: `project-${index}-${'long-name-'.repeat(8)}`,
      path: `/work/${index}/${'deep-path-segment/'.repeat(10)}`,
    })),
  };
  const crowdedSnapshot: GlobalWorkSnapshot = {
    ...snapshot,
    global_work: {
      visible_work: Array.from({ length: 12 }, (_, index) => ({
        canonical_root: `sha256:${index}`,
        object_kind: 'assignment',
        subject: `work-${index}`,
        display: {
          title: `Work ${index} ${'long-title-'.repeat(16)}`,
          status: 'active',
          updated_at: `2026-07-${String(30 - index).padStart(2, '0')}T09:00:00Z`,
          next_actions: [`next-${'long-action-'.repeat(12)}`],
        },
        observations: [{ workspace_id: `project:${index}` }],
      })),
    },
  };
  const output = new CaptureOutput();
  const instance = render(
    React.createElement(WorkWindow, {
      model: buildWorkWindowModel(crowdedSnapshot, {
        projects: crowdedProjects,
      }),
      dimensions: { columns: 80, rows: 24 },
      selected: 0,
      busy: false,
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

  const rendered = stripVTControlCharacters(
    output.chunks.find((chunk) => chunk.includes('ALL WORK')) ?? '',
  );
  const lines = rendered.split('\n');
  assert.equal(lines.length, 23);
  assert.ok(lines.every((line) => line.length <= 80));
  assert.match(lines[19] ?? '', /└.*┘/u);
  assert.match(lines[20] ?? '', /Observed/u);
  assert.match(lines[22] ?? '', /╰.*╯/u);
  assert.doesNotMatch(rendered, /deep-path-segment\/deep-path-segment\/deep/u);
});
