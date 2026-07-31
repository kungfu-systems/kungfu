// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  openProjects,
  prepareProjectWork,
  projectSearchDocuments,
} from '../src/capability/projects/index.ts';

test('Projects delegates to the Core project command', async () => {
  const calls: string[][] = [];
  const projects = openProjects({
    bin: 'kungfu',
    env: {},
    execFile: async (_file, args) => {
      calls.push(args);
      return JSON.stringify({
        schema: 'kungfu.projects.catalog/v1',
        projects: [],
        selectedProjectId: null,
        registryPath: '/config/workspaces.json',
        writeOccurred: false,
        catalogRoot: `sha256:${'0'.repeat(64)}`,
      });
    },
  });

  const result = await projects.list();

  assert.equal(result.schema, 'kungfu.projects.catalog/v1');
  assert.deepEqual(calls, [['project', 'list']]);
  assert.ok(
    projects
      .files(fileURLToPath(new URL('.', import.meta.url)))
      .some((entry) => entry.name === 'projects.test.ts'),
  );
});

test('Projects removes only through an exact Core plan', async () => {
  const calls: string[][] = [];
  const projects = openProjects({
    bin: 'kungfu',
    env: {},
    execFile: async (_file, args) => {
      calls.push(args);
      if (args[1] === 'remove-plan') {
        return JSON.stringify({
          schema: 'kungfu.project.remove-plan/v1',
          project: {
            schema: 'kungfu.project/v1',
            id: 'project-1',
            name: 'Launch',
            path: '/project',
            available: true,
            selected: true,
            initialized: false,
            state: 'uninitialized',
          },
          effects: ['Forget locator'],
          skippedEffects: ['Keep project files'],
          confirmationRequired: true,
          writeOccurred: false,
          planRoot: `sha256:${'1'.repeat(64)}`,
        });
      }
      return JSON.stringify({
        schema: 'kungfu.project.remove-receipt/v1',
        status: 'removed',
        planRoot: `sha256:${'1'.repeat(64)}`,
        project: { id: 'project-1' },
        registryPath: '/config/workspaces.json',
        selectedProjectId: null,
        projectFilesChanged: false,
        projectDirectoryDeleted: false,
        writeOccurred: true,
        receiptRoot: `sha256:${'2'.repeat(64)}`,
      });
    },
  });

  const plan = await projects.planRemove('project-1');
  await projects.remove('project-1', plan.planRoot);

  assert.deepEqual(calls, [
    ['project', 'remove-plan', 'project-1'],
    [
      'project',
      'remove',
      'project-1',
      '--expected-plan-root',
      plan.planRoot,
      '--execute',
    ],
  ]);
});

test('Project search results open the exact project path', () => {
  const documents = projectSearchDocuments({
    schema: 'kungfu.projects.catalog/v1',
    projects: [
      {
        schema: 'kungfu.project/v1',
        id: 'project-1',
        name: 'Launch',
        path: '/Users/example/Documents/Kungfu/launch',
        available: true,
        selected: true,
        initialized: true,
        state: 'live-runtime',
      },
    ],
    selectedProjectId: 'project-1',
    registryPath: '/config/workspaces.json',
    writeOccurred: false,
    catalogRoot: `sha256:${'1'.repeat(64)}`,
  });

  assert.deepEqual(documents[0]?.action, {
    kind: 'open-project',
    projectPath: '/Users/example/Documents/Kungfu/launch',
  });
});

test('Project Work run streams only canonical public events and one receipt', async () => {
  const events: string[] = [];
  const snapshots: string[][] = [];
  const projects = openProjects({
    bin: 'kungfu',
    env: {},
    execFile: async () => {
      throw new Error('streaming path expected');
    },
    execFileEvents: async (_file, args, _options, onLine) => {
      assert.deepEqual(args, [
        'run',
        'codex',
        '--workspace',
        '/project',
        '--events-json',
      ]);
      onLine(
        JSON.stringify({
          schema: 'kungfu.work-start.event/v1',
          index: 1,
          stage: 'run',
          status: 'started',
          text: 'Agent started',
          root: null,
        }),
      );
      onLine(
        JSON.stringify({
          schema: 'kungfu.work-start.receipt/v1',
          ok: true,
          status: 'agent-finished',
          workPhase: 'executing',
          nextActions: ['run-independent-assessment'],
          writeOccurred: true,
          receiptRoot: `sha256:${'2'.repeat(64)}`,
        }),
      );
    },
  });
  const unsubscribe = projects.subscribeRuns((runs) =>
    snapshots.push(runs.map((run) => `${run.running}:${run.events.length}`)),
  );

  const receipt = await projects.run(
    'codex',
    { workspace: '/project' },
    (event) => events.push(event.text),
  );

  assert.deepEqual(events, ['Agent started']);
  assert.equal(receipt.status, 'agent-finished');
  assert.equal(receipt.workPhase, 'executing');
  assert.equal(projects.runs()[0]?.running, false);
  assert.deepEqual(
    projects.runs()[0]?.events.map((event) => event.text),
    ['Agent started'],
  );
  assert.ok(snapshots.some((snapshot) => snapshot[0] === 'true:1'));
  assert.equal(snapshots.at(-1)?.[0], 'false:1');
  unsubscribe();
});

test('Project Work is previewed before the exact request is captured by Core', async () => {
  const inputs: Array<{ args: string[]; input: string }> = [];
  const projects = openProjects({
    bin: 'kungfu',
    env: {},
    execFile: async () => {
      throw new Error('capture input path expected');
    },
    execFileInput: async (_file, args, input) => {
      inputs.push({ args, input });
      return JSON.stringify({
        schema: 'kungfu.assignment-capture.response/v1',
        status: 'captured',
        requestRoot: `sha256:${'1'.repeat(64)}`,
        receiptRoot: `sha256:${'2'.repeat(64)}`,
        requestPath: '/project/.kungfu/inbox/request.json',
        receiptPath: '/project/.kungfu/inbox/receipt.json',
        target: {
          workspaceId: 'project:example',
          workspaceRoot: '/project',
          dataHome: '/project/.kungfu',
          runtimeInitialized: false,
        },
        authority: 'capture-material-only',
        admitted: false,
        claimed: false,
      });
    },
  });
  const plan = prepareProjectWork(
    'Create a launch checklist',
    'The checklist contains five verified steps',
    'example1',
  );

  assert.equal(plan.writeOccurred, false);
  assert.equal(plan.initiativeId, 'project-work-example1');
  assert.equal(
    plan.assignmentId,
    'assignment-create-a-launch-checklist-example1',
  );
  assert.deepEqual(plan.acceptanceChecks, [
    'The checklist contains five verified steps',
    'Validation evidence and unresolved risks are reported',
  ]);

  const receipt = await projects.captureWork('/project', plan);

  assert.equal(receipt.authority, 'capture-material-only');
  assert.equal(receipt.admitted, false);
  assert.deepEqual(inputs[0]?.args, [
    'work',
    'capture',
    '--request',
    '-',
    '--workspace',
    '/project',
    '--json',
  ]);
  const [capture] = inputs;
  assert.ok(capture);
  assert.deepEqual(JSON.parse(capture.input), plan.request);
});

test('Project Work keeps Initiative and Assignment identities distinct for non-Latin objectives', () => {
  const plan = prepareProjectWork(
    '分析更好的商业目标',
    '给出一份可行计划',
    '9da5ffc4',
  );

  assert.equal(plan.initiativeId, 'project-work-9da5ffc4');
  assert.equal(plan.assignmentId, 'assignment-project-work-9da5ffc4');
  assert.notEqual(plan.assignmentId, plan.initiativeId);
});
