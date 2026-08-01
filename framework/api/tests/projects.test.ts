// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  type ProjectWorkRunReceipt,
  mergeProjectsCatalogs,
  openProjects,
  prepareProjectWork,
  projectSearchDocuments,
  readProjectFilePreview,
} from '../src/capability/projects/index.ts';

test('Project file previews stay read-only, bounded, textual, and inside the Project', (t) => {
  const project = mkdtempSync(path.join(tmpdir(), 'kungfu-project-preview-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  writeFileSync(
    path.join(project, 'AGENTS.md'),
    '# Project rules\n\nKeep Work.\n',
  );
  writeFileSync(path.join(project, 'binary.md'), Buffer.from([0, 1, 2]));
  writeFileSync(path.join(project, 'image.png'), 'not an admitted text type');
  mkdirSync(path.join(project, 'nested'));
  symlinkSync(
    path.join(project, 'AGENTS.md'),
    path.join(project, 'nested', 'rules.md'),
  );

  const preview = readProjectFilePreview(project, 'AGENTS.md');

  assert.equal(preview.schema, 'kungfu.project-file.preview/v1');
  assert.equal(preview.mediaType, 'text/markdown');
  assert.equal(preview.language, 'markdown');
  assert.equal(preview.content, '# Project rules\n\nKeep Work.\n');
  assert.equal(preview.readOnly, true);
  assert.equal(preview.writeOccurred, false);
  assert.throws(
    () => readProjectFilePreview(project, '../outside.md'),
    /must stay inside the Project/,
  );
  assert.throws(
    () => readProjectFilePreview(project, 'nested/rules.md'),
    /Symbolic links cannot be previewed/,
  );
  assert.throws(
    () => readProjectFilePreview(project, 'binary.md'),
    /Binary Project files cannot be previewed/,
  );
  assert.throws(
    () => readProjectFilePreview(project, 'image.png'),
    /file type is not available for preview/,
  );
});

test('Projects reads retained Work inventory through the public Project command', async () => {
  const calls: string[][] = [];
  const projects = openProjects({
    bin: 'kungfu',
    env: {},
    execFile: async (_file, args) => {
      calls.push(args);
      return JSON.stringify({
        schema: 'kungfu.project-work.inventory/v1',
        projectPath: '/projects/example',
        works: [],
        activeWork: null,
        writeOccurred: false,
        inventoryRoot: `sha256:${'1'.repeat(64)}`,
      });
    },
  });

  const inventory = await projects.works('/projects/example');

  assert.equal(inventory.writeOccurred, false);
  assert.deepEqual(calls, [['project', 'works', '/projects/example']]);
});

test('Projects merges machine-local catalogs without changing the active instance', async () => {
  const calls: Array<{
    args: string[];
    configHome: string | undefined;
  }> = [];
  const catalog = (
    projectPath: string,
    id: string,
    selected: boolean,
  ): Record<string, unknown> => ({
    schema: 'kungfu.projects.catalog/v1',
    projects: [
      {
        schema: 'kungfu.project/v1',
        id,
        name: id,
        path: projectPath,
        available: true,
        selected,
        initialized: true,
        state: 'live-runtime',
        source: 'library',
      },
    ],
    selectedProjectId: selected ? id : null,
    registryPath: '/config/workspaces.json',
    libraryPath: '/config/projects/library.json',
    sources: { library: 1 },
    hiddenProjectCount: 0,
    writeOccurred: false,
    catalogRoot: `sha256:${selected ? '1' : '2'}`.padEnd(71, '0'),
  });
  const projects = openProjects({
    bin: 'kungfu',
    env: { KF_CONFIG_HOME: '/instance/config' },
    catalogConfigHomes: ['/machine/config'],
    execFile: async (_file, args, options) => {
      calls.push({ args, configHome: options.env.KF_CONFIG_HOME });
      if (args[1] === 'remove-plan') {
        return JSON.stringify({
          schema: 'kungfu.project.remove-plan/v1',
          project: {
            schema: 'kungfu.project/v1',
            id: 'machine',
            name: 'machine',
            path: '/machine/project',
            available: true,
            selected: false,
            initialized: true,
            state: 'live-runtime',
          },
          effects: ['Forget locator'],
          skippedEffects: ['Keep project files'],
          confirmationRequired: true,
          writeOccurred: false,
          planRoot: `sha256:${'3'.repeat(64)}`,
        });
      }
      return JSON.stringify(
        options.env.KF_CONFIG_HOME === '/machine/config'
          ? catalog('/machine/project', 'machine', true)
          : catalog('/instance/project', 'instance', true),
      );
    },
  });

  const result = await projects.list();
  await projects.planRemove('machine');

  assert.deepEqual(
    result.projects.map((project) => project.path),
    ['/instance/project', '/machine/project'],
  );
  assert.equal(result.selectedProjectId, 'instance');
  assert.deepEqual(
    result.projects.map((project) => project.selected),
    [true, false],
  );
  assert.deepEqual(calls, [
    { args: ['project', 'list'], configHome: '/instance/config' },
    { args: ['project', 'list'], configHome: '/machine/config' },
    {
      args: ['project', 'remove-plan', 'machine'],
      configHome: '/machine/config',
    },
  ]);
});

test('Projects catalog merge deduplicates matching paths with primary precedence', () => {
  const primary = {
    schema: 'kungfu.projects.catalog/v1' as const,
    projects: [
      {
        schema: 'kungfu.project/v1' as const,
        id: 'primary',
        name: 'Project',
        path: '/project',
        available: true,
        selected: true,
        initialized: true,
        state: 'live-runtime',
        source: 'recent' as const,
      },
    ],
    selectedProjectId: 'primary',
    registryPath: '/instance/workspaces.json',
    libraryPath: '/instance/library.json',
    sources: { recent: 1 },
    hiddenProjectCount: 0,
    writeOccurred: false as const,
    catalogRoot: `sha256:${'1'.repeat(64)}`,
  };
  const merged = mergeProjectsCatalogs([
    primary,
    {
      ...primary,
      projects: [{ ...primary.projects[0], id: 'machine', selected: false }],
      selectedProjectId: null,
      catalogRoot: `sha256:${'2'.repeat(64)}`,
    },
  ]);

  assert.equal(merged.projects.length, 1);
  assert.equal(merged.projects[0]?.id, 'primary');
  assert.equal(merged.registryPath, '/instance/workspaces.json');
});

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

  assert.equal(projects.cachedCatalog(), undefined);
  const result = await projects.list();
  const restored = await projects.list();

  assert.equal(result.schema, 'kungfu.projects.catalog/v1');
  assert.equal(restored, result);
  assert.equal(projects.cachedCatalog(), result);
  assert.deepEqual(calls, [['project', 'list']]);
  await projects.list({ refresh: true });
  assert.deepEqual(calls, [
    ['project', 'list'],
    ['project', 'list'],
  ]);
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

test('Project Work restores an ended failed Session as a retry boundary', async () => {
  const ref = {
    workConsoleId: 'work:qualification:assignment:crash',
    sessionAttemptId: 'attempt:crash:1',
  };
  const projects = openProjects({
    bin: 'kungfu',
    env: {},
    execFile: async () => {
      throw new Error('streaming path expected');
    },
    execFileEvents: async (_file, _args, _options, onLine) => {
      onLine(
        JSON.stringify({
          schema: 'kungfu.work-start.receipt/v1',
          ok: false,
          status: 'agent-failed',
          workPhase: 'executing',
          work: { assignmentId: 'crash' },
          agent: { provider: 'synthetic' },
          agentReport: { runId: ref.sessionAttemptId, session: ref },
          nextActions: ['inspect-retained-agent-report'],
          writeOccurred: true,
          receiptRoot: `sha256:${'4'.repeat(64)}`,
        }),
      );
    },
    agentSession: {
      invoke: async (request) => {
        assert.equal(request.operation, 'status');
        return {
          ...ref,
          live: false,
          lifecycleState: 'ended',
          interactionState: 'ended',
          providerAdapter: { provider: 'synthetic' },
          workAgent: {
            attempt: 'ended',
            attention: {
              kind: 'blocked',
              reason: 'agent-exited-with-error',
              message: 'The Agent process ended with an error.',
              nextActions: ['retry-or-start-new-attempt'],
            },
          },
        };
      },
    },
  });

  const receipt = await projects.run(
    'mock',
    { workspace: '/project', work: 'crash', scenario: 'crash' },
    () => undefined,
  );

  assert.equal(receipt.status, 'agent-failed');
  assert.equal(projects.runs()[0]?.session?.live, false);
  assert.equal(projects.runs()[0]?.session?.attention?.kind, 'blocked');
});

test('Project Work retains a canonical failed receipt when the CLI exits nonzero', async () => {
  const projects = openProjects({
    bin: 'kungfu',
    env: {},
    execFile: async () => {
      throw new Error('streaming path expected');
    },
    execFileEvents: async (_file, _args, _options, onLine) => {
      onLine(
        JSON.stringify({
          schema: 'kungfu.work-start.receipt/v1',
          ok: false,
          status: 'agent-failed',
          workPhase: 'executing',
          nextActions: ['inspect-retained-agent-report'],
          writeOccurred: true,
          receiptRoot: `sha256:${'5'.repeat(64)}`,
        }),
      );
      throw new Error('kungfu exited 1 after retaining the failure receipt');
    },
  });

  const receipt = await projects.run(
    'mock',
    { workspace: '/project', scenario: 'disconnect' },
    () => undefined,
  );

  assert.equal(receipt.status, 'agent-failed');
  assert.equal(projects.runs()[0]?.receipt?.receiptRoot, receipt.receiptRoot);
  assert.equal(projects.runs()[0]?.error, undefined);
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

test('Project Work restores and controls one retained Agent Session through the shared surface', async () => {
  const operations: string[] = [];
  let interactionState = 'ready';
  let live = true;
  const ref = {
    workConsoleId: 'work:qualification:assignment:alpha',
    sessionAttemptId: 'attempt:alpha:1',
  };
  const projects = openProjects({
    bin: 'kungfu',
    env: {},
    execFile: async () => {
      throw new Error('no CLI call expected');
    },
    agentSession: {
      invoke: async (request) => {
        operations.push(request.operation);
        if (request.operation === 'plan-control') {
          return { root: `sha256:${'9'.repeat(64)}` };
        }
        if (request.operation === 'instruct')
          interactionState = 'approval-needed';
        if (
          request.operation === 'send-key' &&
          (request.payload as { key?: string })?.key === 'Enter'
        ) {
          interactionState = 'ready';
        }
        if (request.operation === 'end') {
          live = false;
          interactionState = 'ended';
        }
        if (request.operation === 'snapshot') {
          return {
            terminal: { vt: { lines: ['MOCK READY', 'mock› '] } },
          };
        }
        if (request.operation === 'status') {
          return {
            ...ref,
            live,
            lifecycleState: live ? 'ready' : 'ended',
            interactionState,
            providerAdapter: { provider: 'synthetic' },
            workAgent: {
              attempt: live ? 'waiting' : 'ended',
              attention: live
                ? {
                    kind:
                      interactionState === 'approval-needed'
                        ? 'needs-approval'
                        : 'needs-answer',
                    reason: 'fixture',
                    message: 'Mock needs attention.',
                    nextActions: ['reply'],
                  }
                : {
                    kind: 'ready-for-review',
                    reason: 'ended',
                    message: 'Review changes.',
                    nextActions: ['review-changes'],
                  },
            },
          };
        }
        return { status: 'written' };
      },
    },
  });
  const receipt = {
    schema: 'kungfu.work-start.receipt/v1' as const,
    ok: true,
    status: 'agent-waiting' as const,
    planRoot: `sha256:${'1'.repeat(64)}`,
    receiptRoot: `sha256:${'2'.repeat(64)}`,
    workPhase: 'executing',
    work: {
      assignmentId: 'alpha',
      title: 'Alpha',
      objective: 'Exercise controls',
      acceptanceChecks: ['all states observed'],
    },
    agent: { provider: 'synthetic' },
    agentReport: { runId: 'attempt:alpha:1', session: ref },
    nextActions: ['reply'],
    writeOccurred: true,
  };

  const restored = await projects.restoreRun(
    receipt as unknown as ProjectWorkRunReceipt,
    '/project',
  );
  assert.deepEqual(restored.session?.terminalLines, ['MOCK READY', 'mock› ']);
  assert.equal(restored.session?.attention?.kind, 'needs-answer');

  await projects.replyToRun(restored.id, 'alpha');
  assert.equal(projects.runs()[0]?.session?.attention?.kind, 'needs-approval');
  await projects.approveRun(restored.id, true);
  assert.equal(projects.runs()[0]?.session?.attention?.kind, 'needs-answer');
  await projects.endRun(restored.id);
  assert.equal(
    projects.runs()[0]?.session?.attention?.kind,
    'ready-for-review',
  );
  assert.deepEqual(
    operations.filter((operation) =>
      ['instruct', 'send-key', 'end'].includes(operation),
    ),
    ['instruct', 'send-key', 'send-key', 'end'],
  );
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
