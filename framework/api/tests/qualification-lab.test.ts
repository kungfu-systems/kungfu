// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  openQualificationLab,
  qualificationLabStartupSurface,
  qualificationRunProgressLabel,
} from '../src/capability/qualification-lab.ts';

const startup = {
  schema: 'kungfu.qualification-lab.startup-route/v1',
  state: 'verified-empty',
  route: 'qualification-lab',
  reasonCode: 'runtime-home-absent',
  message: 'empty',
  runtimeDir: '/runtime',
  workGraphPresent: false,
  evidence: [],
  writeOccurred: false,
};

test('GUI and TUI adapter invokes only the canonical public CLI authority', async () => {
  const calls: Array<{ file: string; args: string[]; runtimeDir?: string }> =
    [];
  const lab = openQualificationLab({
    runtimeDir: '/runtime',
    bin: '/product/kungfu',
    execFile: async (file, args, options) => {
      calls.push({
        file,
        args,
        runtimeDir: options.env.KF_RUNTIME_DIR,
      });
      return JSON.stringify(
        args[1] === 'agent-plan'
          ? {
              schema: 'kungfu.qualification-lab.agent-plan/v1',
              commandPreview: ['/usr/bin/codex'],
            }
          : startup,
      );
    },
    execFileSync: (file, args, options) => {
      calls.push({
        file,
        args,
        runtimeDir: options.env.KF_RUNTIME_DIR,
      });
      return JSON.stringify(startup);
    },
  });

  assert.equal(lab.inspectSync().route, 'qualification-lab');
  assert.equal((await lab.inspect()).writeOccurred, false);
  assert.deepEqual((await lab.planAgent('codex.local')).commandPreview, [
    '/usr/bin/codex',
  ]);
  await lab.runAgent('codex.local');
  await lab.runMigration('codex.local', 'claude.local');
  assert.deepEqual(calls, [
    {
      file: '/product/kungfu',
      args: ['qualification-lab', 'inspect', '--json'],
      runtimeDir: '/runtime',
    },
    {
      file: '/product/kungfu',
      args: ['qualification-lab', 'inspect', '--json'],
      runtimeDir: '/runtime',
    },
    {
      file: '/product/kungfu',
      args: ['qualification-lab', 'agent-plan', 'codex.local', '--json'],
      runtimeDir: '/runtime',
    },
    {
      file: '/product/kungfu',
      args: [
        'qualification-lab',
        'agent-run',
        'codex.local',
        '--execute',
        '--json',
      ],
      runtimeDir: '/runtime',
    },
    {
      file: '/product/kungfu',
      args: [
        'qualification-lab',
        'agent-run',
        'codex.local',
        '--execute',
        '--target-profile',
        'claude.local',
        '--json',
      ],
      runtimeDir: '/runtime',
    },
  ]);
});

test('the adapter streams safe milestones before returning the canonical report', async () => {
  const received: string[] = [];
  const event = {
    schema: 'kungfu.qualification-lab.event/v1',
    step: 'session-1-start',
    status: 'running',
    root: `sha256:${'a'.repeat(64)}`,
  } as const;
  const report = {
    schema: 'kungfu.qualification-lab.report/v1',
    status: 'qualified',
    events: [event],
  };
  const lab = openQualificationLab({
    runtimeDir: '/runtime',
    bin: '/product/kungfu',
    execFile: async () => JSON.stringify(report),
    execFileSync: () => JSON.stringify(startup),
    execFileEvents: async (_file, args, _options, onLine) => {
      assert.deepEqual(args, [
        'qualification-lab',
        'demo',
        '--events-json',
        '--json',
      ]);
      onLine(JSON.stringify(event));
      onLine(JSON.stringify(report));
    },
  });

  const result = await lab.runDemo((value) => received.push(value.step));

  assert.deepEqual(received, ['session-1-start']);
  assert.equal(result.status, 'qualified');
});

test('GUI and TUI share the same fail-closed startup surface policy', () => {
  assert.equal(
    qualificationLabStartupSurface({
      ...startup,
      state: 'existing-work',
      route: 'work-graph',
      workGraphPresent: true,
    }),
    'work-graph',
  );
  assert.equal(qualificationLabStartupSurface(startup), 'qualification-lab');
  assert.equal(
    qualificationLabStartupSurface({
      ...startup,
      state: 'diagnostic',
      route: 'diagnostic',
      workGraphPresent: null,
    }),
    'qualification-lab',
  );
  assert.equal(
    qualificationLabStartupSurface({
      ...startup,
      state: 'verified-empty',
      route: 'work-graph',
      workGraphPresent: true,
    }),
    'qualification-lab',
  );
});

test('run progress distinguishes a live wait from an admitted event', () => {
  assert.equal(
    qualificationRunProgressLabel({
      elapsedMs: 2400,
      quietMs: 2400,
      eventCount: 0,
    }),
    'Still running · 2s elapsed · waiting for first admitted event',
  );
  assert.equal(
    qualificationRunProgressLabel({
      elapsedMs: 12_400,
      quietMs: 5400,
      eventCount: 4,
    }),
    'Still running · 12s elapsed · 4 admitted events shown · last update 5s ago',
  );
});
