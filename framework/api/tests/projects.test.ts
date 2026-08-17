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
  type WorkReviewPlan,
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

test('Projects previews and executes the exact native Work settlement plan', async () => {
  const calls: string[][] = [];
  const plan = {
    schema: 'kungfu.work-close.plan/v1' as const,
    workspace: {
      id: 'project-1',
      root: '/project',
      identityRoot: `sha256:${'1'.repeat(64)}`,
    },
    work: {
      initiativeId: 'initiative-1',
      assignmentId: 'assignment-1',
      phase: 'independently-reviewed',
      queryProofRoot: `sha256:${'2'.repeat(64)}`,
      assignmentRoot: `sha256:${'3'.repeat(64)}`,
    },
    review: {
      id: 'review-1',
      root: `sha256:${'4'.repeat(64)}`,
      verdict: 'fit',
      continuationPlanRoot: `sha256:${'5'.repeat(64)}`,
      allowedActions: ['approve', 'close'],
    },
    decision: {
      mode: 'required' as const,
      action: 'close' as const,
      root: null,
    },
    effects: [{ stage: 'decide' as const, label: 'Record close decision' }],
    skippedEffects: ['git-push'],
    confirmationRequired: true as const,
    executable: true,
    writeOccurred: false as const,
    planRoot: `sha256:${'6'.repeat(64)}`,
  };
  const projects = openProjects({
    bin: 'kungfu',
    env: {},
    execFile: async (_file, args) => {
      calls.push(args);
      if (args[1] === 'resume-prepare') {
        return JSON.stringify({
          schema: 'kungfu.work.resume-prepare/v1',
          status: 'ready',
          writeOccurred: false,
        });
      }
      if (args[1] === 'close-plan') return JSON.stringify(plan);
      assert.equal(args[1], 'close');
      return JSON.stringify({
        schema: 'kungfu.work-close.receipt/v1',
        ok: true,
        status: 'completed',
        planRoot: plan.planRoot,
        receiptRoot: `sha256:${'7'.repeat(64)}`,
        workPhase: 'continuation-decided',
        decisionAction: 'close',
        nextActions: [],
        writeOccurred: true,
      });
    },
  });

  const prepared = await projects.planClose('/project', {
    initiativeId: 'initiative-1',
    assignmentId: 'assignment-1',
  });
  const receipt = await projects.close(prepared);

  assert.equal(prepared.planRoot, plan.planRoot);
  assert.equal(receipt.status, 'completed');
  assert.deepEqual(calls, [
    [
      'work',
      'resume-prepare',
      '--workspace',
      '/project',
      '--actor',
      'kungfu-product-project-close',
      '--execute',
    ],
    [
      'work',
      'close-plan',
      '--workspace',
      '/project',
      '--initiative-id',
      'initiative-1',
      '--assignment-id',
      'assignment-1',
    ],
    [
      'work',
      'close',
      '--workspace',
      '/project',
      '--initiative-id',
      'initiative-1',
      '--assignment-id',
      'assignment-1',
      '--actor',
      'local-user',
      '--expected-plan-root',
      plan.planRoot,
      '--execute',
    ],
  ]);
});

test('Projects restores the retained Agent receipt for a selected native Work', async () => {
  const calls: string[][] = [];
  const receipt = {
    schema: 'kungfu.work-start.receipt/v1' as const,
    ok: true,
    status: 'agent-finished' as const,
    workPhase: 'executing',
    workspace: { workspace_root: '/project' },
    work: {
      initiativeId: 'initiative-1',
      assignmentId: 'assignment-1',
      title: 'Retained Work',
      objective: 'Keep the Agent result',
      acceptanceChecks: ['result is reviewable'],
    },
    agent: {
      id: 'codex.profile.1',
      provider: 'codex',
      label: 'Codex',
    },
    agentReport: {
      runId: 'agent-retained-1',
      episode: { reportPath: '/project/.kungfu/report.json' },
    },
    nextActions: ['run-independent-assessment'],
    writeOccurred: true,
    receiptRoot: `sha256:${'2'.repeat(64)}`,
  };
  const projects = openProjects({
    bin: 'kungfu',
    env: {},
    execFile: async (_file, args) => {
      calls.push(args);
      if (args[1] === 'resume-prepare') {
        return JSON.stringify({
          schema: 'kungfu.work.resume-prepare/v1',
          status: 'ready',
          writeOccurred: false,
        });
      }
      if (args[1] === 'close-resume') {
        return JSON.stringify({
          schema: 'kungfu.work-close.resume/v1',
          status: 'not-ready',
          reviewReceipt: null,
          closeReceipt: null,
          writeOccurred: false,
        });
      }
      assert.equal(args[1], 'start-resume');
      return JSON.stringify({
        schema: 'kungfu.work-start.resume/v1',
        status: 'retained-agent-run',
        workReceipt: receipt,
        writeOccurred: false,
      });
    },
  });

  const restored = await projects.resumeRun('/project', {
    initiativeId: 'initiative-1',
    assignmentId: 'assignment-1',
  });

  assert.equal(restored?.receipt?.status, 'agent-finished');
  assert.equal(restored?.work, 'assignment-1');
  assert.deepEqual(calls, [
    [
      'work',
      'resume-prepare',
      '--workspace',
      '/project',
      '--actor',
      'kungfu-product-project-resume',
      '--execute',
    ],
    [
      'work',
      'start-resume',
      '--workspace',
      '/project',
      '--initiative-id',
      'initiative-1',
      '--assignment-id',
      'assignment-1',
    ],
    [
      'work',
      'close-resume',
      '--workspace',
      '/project',
      '--initiative-id',
      'initiative-1',
      '--assignment-id',
      'assignment-1',
    ],
  ]);
});

test('Projects restores a passed independent review from native Work authority', async () => {
  const receipt = {
    schema: 'kungfu.work-start.receipt/v1' as const,
    ok: true,
    status: 'agent-finished' as const,
    workPhase: 'independently-reviewed',
    workspace: { workspace_root: '/project' },
    work: {
      initiativeId: 'initiative-1',
      assignmentId: 'assignment-1',
      title: 'Retained Work',
      objective: 'Keep the Agent result',
      acceptanceChecks: ['result is reviewable'],
    },
    agent: {
      id: 'codex.profile.1',
      provider: 'codex',
      label: 'Codex',
    },
    agentReport: {
      runId: 'agent-retained-1',
      episode: { reportPath: '/project/.kungfu/report.json' },
    },
    nextActions: ['run-independent-review'],
    writeOccurred: true,
    receiptRoot: `sha256:${'2'.repeat(64)}`,
  };
  const reviewReceipt = {
    schema: 'kungfu.work-review.receipt/v1' as const,
    ok: true,
    status: 'review-passed' as const,
    planRoot: `sha256:${'3'.repeat(64)}`,
    receiptRoot: `sha256:${'4'.repeat(64)}`,
    workPhase: 'independently-reviewed',
    nativeVerdict: 'fit',
    nextActions: ['decide-close-or-continue'],
    writeOccurred: true,
  };
  const projects = openProjects({
    bin: 'kungfu',
    env: {},
    execFile: async (_file, args) => {
      if (args[1] === 'resume-prepare') {
        return JSON.stringify({
          schema: 'kungfu.work.resume-prepare/v1',
          status: 'ready',
          writeOccurred: false,
        });
      }
      if (args[1] === 'start-resume') {
        return JSON.stringify({
          schema: 'kungfu.work-start.resume/v1',
          status: 'retained-agent-run',
          workReceipt: receipt,
          writeOccurred: false,
        });
      }
      assert.equal(args[1], 'close-resume');
      return JSON.stringify({
        schema: 'kungfu.work-close.resume/v1',
        status: 'review-passed',
        reviewReceipt,
        closeReceipt: null,
        writeOccurred: false,
      });
    },
  });

  const restored = await projects.resumeRun('/project', {
    initiativeId: 'initiative-1',
    assignmentId: 'assignment-1',
  });

  assert.equal(restored?.kind, 'review');
  assert.equal(restored?.reviewReceipt?.status, 'review-passed');
  assert.ok(
    projects.runs().some((run) => run.receipt?.status === 'agent-finished'),
  );
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

test('Project Work launches one fresh read-only independent review from the retained run', async () => {
  const calls: string[][] = [];
  const reportPath =
    '/project/.kungfu/runtime/agent-runs/run-1/bundle/report.json';
  const projects = openProjects({
    bin: 'kungfu',
    env: {},
    execFile: async (_file, args) => {
      calls.push(args);
      if (args[1] === 'resume-prepare') {
        return JSON.stringify({
          schema: 'kungfu.work.resume-prepare/v1',
          status: 'reconciled',
          writeOccurred: true,
        });
      }
      assert.deepEqual(args, [
        'work',
        'review-agent-plan',
        reportPath,
        '--workspace',
        '/project',
        '--initiative-id',
        'initiative-1',
        '--assignment-id',
        'assignment-1',
        '--reviewer',
        'codex.profile.1',
      ]);
      return JSON.stringify({
        schema: 'kungfu.work-review.plan/v1',
        planRoot: `sha256:${'3'.repeat(64)}`,
        executable: true,
        confirmationRequired: true,
        workspace: { id: 'project:1', root: '/project', identityRoot: 'root' },
        work: {
          initiativeId: 'initiative-1',
          assignmentId: 'assignment-1',
          phase: 'executing',
          queryProofRoot: 'query',
          assignmentRoot: 'assignment',
          workDefinitionRoot: 'definition',
          acceptanceChecks: ['evidence exists'],
        },
        deliverable: {
          path: '/project/result.md',
          root: 'result',
          content: '',
        },
        inputs: [],
        evidenceMode: 'project-files',
        execution: {
          reportPath,
          reportRoot: 'report',
          runId: 'run-1',
          episodeId: 'episode-1',
          agent: {},
        },
        reviewer: {
          id: 'codex.profile.1',
          label: 'Codex',
          provider: 'codex',
          profileRoot: 'profile',
          selection: 'explicit',
          verification: {
            ok: true,
            available: true,
            version: '1.0.0',
            error: null,
          },
          permissionMode: 'read-only',
          freshProcess: true,
          priorTranscriptBytes: 0,
        },
        reviewExecution: {
          mode: 'fresh-process',
          reportPath: null,
          reportRoot: null,
          runId: null,
          episodeId: null,
          reviewCut: null,
          assessmentRoot: null,
        },
        admissionBinding: { ok: true, state: 'current-checkout' },
        effects: [{ stage: 'run', label: 'Launch fresh reviewer' }],
        skippedEffects: ['git-push'],
        writeOccurred: false,
      });
    },
    execFileEvents: async (_file, args, _options, onLine) => {
      if (args[0] === 'run') {
        onLine(
          JSON.stringify({
            schema: 'kungfu.work-start.receipt/v1',
            ok: true,
            status: 'agent-finished',
            workPhase: 'executing',
            workspace: { workspace_root: '/project' },
            work: {
              initiativeId: 'initiative-1',
              assignmentId: 'assignment-1',
            },
            agent: {
              id: 'codex.profile.1',
              provider: 'codex',
              label: 'Codex',
            },
            agentReport: { episode: { reportPath } },
            nextActions: ['run-independent-assessment'],
            writeOccurred: true,
            receiptRoot: `sha256:${'2'.repeat(64)}`,
          }),
        );
        return;
      }
      assert.deepEqual(args, [
        'work',
        'review-agent-run',
        reportPath,
        '--workspace',
        '/project',
        '--initiative-id',
        'initiative-1',
        '--assignment-id',
        'assignment-1',
        '--reviewer',
        'codex.profile.1',
        '--expected-plan-root',
        `sha256:${'3'.repeat(64)}`,
        '--execute',
        '--events-json',
      ]);
      onLine(
        JSON.stringify({
          schema: 'kungfu.work-review.event/v1',
          index: 1,
          stage: 'run',
          status: 'started',
          text: 'Fresh reviewer started',
          root: null,
        }),
      );
      onLine(
        JSON.stringify({
          schema: 'kungfu.work-review.receipt/v1',
          ok: true,
          status: 'review-passed',
          planRoot: `sha256:${'3'.repeat(64)}`,
          receiptRoot: `sha256:${'4'.repeat(64)}`,
          workPhase: 'independently-reviewed',
          nextActions: ['decide-continuation-and-close'],
          writeOccurred: true,
        }),
      );
    },
  });

  await projects.run(
    'codex',
    { workspace: '/project', work: 'assignment-1' },
    () => undefined,
  );
  const sourceRun = projects.runs()[0];
  assert.ok(sourceRun);
  const plan = await projects.planReview(sourceRun.id);
  const events: string[] = [];
  const receipt = await projects.review(sourceRun.id, plan, (event) =>
    events.push(event.text),
  );

  assert.deepEqual(calls[0], [
    'work',
    'resume-prepare',
    '--workspace',
    '/project',
    '--actor',
    'kungfu-product-project-review',
    '--execute',
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(events, ['Fresh reviewer started']);
  assert.equal(receipt.status, 'review-passed');
  assert.equal(projects.runs()[0]?.kind, 'review');
  assert.equal(
    projects.runs()[0]?.reviewReceipt?.workPhase,
    'independently-reviewed',
  );
  const reviewCount = projects
    .runs()
    .filter((run) => run.kind === 'review').length;
  const repeated = await projects.review(sourceRun.id, plan);
  assert.equal(repeated.receiptRoot, receipt.receiptRoot);
  assert.equal(
    projects.runs().filter((run) => run.kind === 'review').length,
    reviewCount,
  );
});

test('Project Work rejects a concurrent independent review for the same Agent result', async () => {
  const sourceReceipt: ProjectWorkRunReceipt = {
    schema: 'kungfu.work-start.receipt/v1',
    ok: true,
    status: 'agent-finished',
    workPhase: 'executing',
    workspace: { workspace_root: '/project' },
    work: {
      initiativeId: 'initiative-1',
      assignmentId: 'assignment-1',
      title: 'Retained Work',
      objective: 'Keep the Agent result',
      acceptanceChecks: ['result is reviewable'],
    },
    agent: {
      id: 'codex.profile.1',
      provider: 'codex',
      label: 'Codex',
    },
    agentReport: {
      runId: 'run-1',
      episode: {
        reportPath:
          '/project/.kungfu/runtime/agent-runs/run-1/bundle/report.json',
      },
    },
    nextActions: ['run-independent-assessment'],
    writeOccurred: true,
    receiptRoot: `sha256:${'2'.repeat(64)}`,
  };
  const plan = {
    workspace: { root: '/project' },
    work: {
      initiativeId: 'initiative-1',
      assignmentId: 'assignment-1',
    },
    reviewer: { id: 'codex.profile.1', provider: 'codex' },
    planRoot: `sha256:${'3'.repeat(64)}`,
  } as WorkReviewPlan;
  let releaseReview = () => undefined;
  const reviewGate = new Promise<void>((resolve) => {
    releaseReview = resolve;
  });
  let launches = 0;
  const projects = openProjects({
    bin: 'kungfu',
    env: {},
    execFile: async () => {
      throw new Error('streaming path expected');
    },
    execFileEvents: async (_file, _args, _options, onLine) => {
      launches += 1;
      await reviewGate;
      onLine(
        JSON.stringify({
          schema: 'kungfu.work-review.receipt/v1',
          ok: true,
          status: 'review-passed',
          planRoot: plan.planRoot,
          receiptRoot: `sha256:${'4'.repeat(64)}`,
          workPhase: 'independently-reviewed',
          nextActions: ['decide-continuation-and-close'],
          writeOccurred: true,
        }),
      );
    },
  });
  const sourceRun = await projects.restoreRun(sourceReceipt, '/project');

  const firstReview = projects.review(sourceRun.id, plan, () => undefined);
  assert.equal(projects.runs()[0]?.running, true);
  await assert.rejects(
    projects.review(sourceRun.id, plan, () => undefined),
    /Independent review is already running/,
  );
  assert.equal(launches, 1);
  releaseReview();
  assert.equal((await firstReview).status, 'review-passed');
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
  let controller: { holderId: string } | null = null;
  const cliCalls: string[][] = [];
  const ref = {
    workConsoleId: 'work:qualification:assignment:alpha',
    sessionAttemptId: 'attempt:alpha:1',
  };
  const projects = openProjects({
    bin: 'kungfu',
    env: {},
    execFile: async (_file, args) => {
      cliCalls.push(args);
      if (args[1] === 'start-resume') {
        return JSON.stringify({
          schema: 'kungfu.work-start.resume/v1',
          status: 'retained-agent-run',
          workReceipt: {
            schema: 'kungfu.work-start.receipt/v1',
            ok: true,
            status: 'agent-finished',
            planRoot: `sha256:${'3'.repeat(64)}`,
            receiptRoot: `sha256:${'4'.repeat(64)}`,
            workPhase: 'executing',
            work: {
              initiativeId: 'initiative-alpha',
              assignmentId: 'alpha',
              title: 'Alpha',
              objective: 'Exercise controls',
              acceptanceChecks: ['all states observed'],
            },
            agent: { provider: 'synthetic' },
            workspace: { workspace_root: '/project' },
            agentReport: {
              runId: 'attempt:alpha:1',
              reportRoot: `sha256:${'8'.repeat(64)}`,
              session: { ...ref, live: false },
              episode: {
                reportPath: '/project/.kungfu/runtime/final/report.json',
              },
            },
            nextActions: ['run-independent-review'],
            writeOccurred: true,
          },
          writeOccurred: false,
        });
      }
      return JSON.stringify({
        schema: 'kungfu.work-start.agent-session-finalization/v1',
        status: 'agent-finished',
        reportPath: '/project/.kungfu/runtime/final/report.json',
        agentReport: {
          runId: 'attempt:alpha:1',
          reportRoot: `sha256:${'8'.repeat(64)}`,
          session: { ...ref, live: false },
          episode: {
            reportPath: '/project/.kungfu/runtime/final/report.json',
          },
        },
        writeOccurred: true,
      });
    },
    agentSession: {
      invoke: async (request) => {
        operations.push(request.operation);
        if (request.operation === 'plan-control') {
          return { root: `sha256:${'9'.repeat(64)}` };
        }
        if (request.operation === 'acquire-control') {
          controller = { holderId: 'kungfu-project-work' };
          return { status: 'granted' };
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
          await Promise.resolve();
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
            controller,
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
      initiativeId: 'initiative-alpha',
      assignmentId: 'alpha',
      title: 'Alpha',
      objective: 'Exercise controls',
      acceptanceChecks: ['all states observed'],
    },
    agent: { provider: 'synthetic' },
    workspace: { workspace_root: '/project' },
    agentReport: {
      runId: 'attempt:alpha:1',
      session: ref,
      episode: { reportPath: '/project/.kungfu/runtime/initial/report.json' },
    },
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
  assert.equal(projects.runs()[0]?.receipt?.status, 'agent-finished');
  assert.equal(
    (projects.runs()[0]?.receipt?.agentReport as { reportRoot?: string })
      .reportRoot,
    `sha256:${'8'.repeat(64)}`,
  );
  assert.deepEqual(cliCalls, [
    [
      'work',
      'finalize-agent-session',
      '/project/.kungfu/runtime/initial/report.json',
      '--workspace',
      '/project',
      '--initiative-id',
      'initiative-alpha',
      '--assignment-id',
      'alpha',
    ],
    [
      'work',
      'start-resume',
      '--workspace',
      '/project',
      '--initiative-id',
      'initiative-alpha',
      '--assignment-id',
      'alpha',
    ],
  ]);
  assert.deepEqual(
    operations.filter((operation) =>
      ['acquire-control', 'instruct', 'send-key', 'end'].includes(operation),
    ),
    ['acquire-control', 'instruct', 'send-key', 'send-key', 'end'],
  );
});

test('Project Work rediscovers native UI attempts as observer-only without terminal access', async () => {
  const operations: string[] = [];
  let workStatusQueries = 0;
  const ref = {
    workConsoleId: 'work:kungfu.work-control:assignment:alpha',
    sessionAttemptId: 'native:alpha:1',
  };
  const status = {
    ...ref,
    workspaceId: 'workspace:test',
    backend: 'native-interactive',
    live: true,
    terminalObservable: false,
    controllable: false,
    lifecycleState: 'running',
    interactionState: 'external-native-ui',
    providerAdapter: { provider: 'amp' },
    binding: {
      kind: 'work',
      workRef: {
        workspaceId: 'workspace:test',
        entityId: 'alpha',
      },
    },
    workAgent: { attempt: 'working', attention: null },
    nativeObserver: {
      state: 'fresh',
      ageMs: 40,
      staleAfterMs: 2000,
      diagnostic: null,
      workProjection: {
        state: 'fresh',
        observedAt: 4000,
        source: 'bounded-fallback',
        queryCount: 2,
        queryProofRoot: `sha256:${'1'.repeat(64)}`,
        diagnostic: null,
      },
      work: {
        state: 'available',
        initiativeId: 'initiative:alpha',
        assignmentId: 'alpha',
        title: 'Native continuity',
        objective: 'Keep Work visible across native UIs',
        acceptanceChecks: ['Rediscover the same Work'],
        phase: 'executing',
        queryProofRoot: `sha256:${'1'.repeat(64)}`,
        nextActions: ['stage: Record the stage-ready boundary'],
        evidenceEpisodeRoots: [],
        continuation: {
          completionClaimCount: 0,
          independentReviewCount: 0,
          continuationDecisionCount: 0,
        },
        remainingObligation: null,
        nextAction: 'stage: Record the stage-ready boundary',
      },
    },
  };
  const agentSession = {
    invoke: async (request: Record<string, unknown>) => {
      operations.push(String(request.operation));
      if (request.operation === 'list') {
        return {
          sessions: [],
          attempts: [
            {
              ...status,
              sessionAttemptId: 'native:alpha:0',
              live: false,
              lifecycleState: 'ended',
            },
            status,
          ],
        };
      }
      if (request.operation === 'status') return status;
      throw new Error(
        `unexpected native observer operation ${request.operation}`,
      );
    },
  };
  const options = {
    bin: 'kungfu',
    env: {},
    execFile: async (_bin: string, args: string[]) => {
      workStatusQueries += 1;
      assert.deepEqual(args.slice(0, 2), ['work', 'status']);
      return JSON.stringify({
        schema: 'kungfu.assignment-orchestration.status/v1',
        assignment: {
          title: 'Native continuity',
          objective: 'Keep Work visible across native UIs',
          work_definition: {
            title: 'Native continuity',
            objective: 'Keep Work visible across native UIs',
            acceptance_criteria: ['Rediscover the same Work'],
          },
        },
      });
    },
    agentSession,
  };

  const projects = openProjects(options);
  const publications: number[] = [];
  projects.subscribeRuns((runs) => publications.push(runs.length));
  const [observed] = await projects.syncSessions({
    workspace: '/project',
    workspaceId: 'workspace:test',
  });
  assert.equal(observed?.provider, 'amp');
  assert.equal(observed?.session?.backend, 'native-interactive');
  assert.equal(observed?.session?.controllable, false);
  assert.equal(observed?.session?.terminalObservable, false);
  assert.deepEqual(observed?.session?.terminalLines, []);
  assert.equal(observed?.session?.nativeObserver?.work?.phase, 'executing');
  assert.equal(
    observed?.session?.nativeObserver?.work?.objective,
    'Keep Work visible across native UIs',
  );
  assert.equal(
    observed?.session?.nativeObserver?.workProjection?.queryCount,
    2,
  );
  assert.equal(workStatusQueries, 0);
  assert.deepEqual(publications, [0, 2]);
  assert.deepEqual(observed?.session?.receiptRoots, []);
  await assert.rejects(
    projects.replyToRun(String(observed?.id), 'do not deliver'),
    /observer-only/u,
  );

  const restarted = openProjects(options);
  const [rediscovered] = await restarted.syncSessions({
    workspace: '/project',
    workspaceId: 'workspace:test',
  });
  assert.deepEqual(
    {
      workConsoleId: rediscovered?.session?.workConsoleId,
      sessionAttemptId: rediscovered?.session?.sessionAttemptId,
    },
    ref,
  );
  assert.equal(operations.includes('snapshot'), false);
  assert.equal(operations.includes('plan-control'), false);
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
