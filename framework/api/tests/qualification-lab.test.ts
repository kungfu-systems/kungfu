// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openQualificationLab } from '../src/capability/qualification-lab.ts';

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
