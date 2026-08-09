// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type ProjectTemplateCreationReceipt,
  type WorkStartReceipt,
  agentWorkLabRunProgressLabel,
  agentWorkLabStartupSurface,
  openAgentWorkLab,
} from '../src/capability/agent-work-lab.ts';

const startup = {
  schema: 'kungfu.agent-work-lab.startup-route/v1',
  state: 'verified-empty',
  route: 'agent-work-lab',
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
  const lab = openAgentWorkLab({
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
              schema: 'kungfu.agent-work-lab.agent-plan/v1',
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

  assert.equal(lab.inspectSync().route, 'agent-work-lab');
  assert.equal((await lab.inspect()).writeOccurred, false);
  assert.deepEqual((await lab.planAgent('codex.local')).commandPreview, [
    '/usr/bin/codex',
  ]);
  await lab.runAgent('codex.local');
  await lab.runMigration('codex.local', 'claude.local');
  assert.deepEqual(calls, [
    {
      file: '/product/kungfu',
      args: ['agent-work-lab', 'inspect', '--json'],
      runtimeDir: '/runtime',
    },
    {
      file: '/product/kungfu',
      args: ['agent-work-lab', 'inspect', '--json'],
      runtimeDir: '/runtime',
    },
    {
      file: '/product/kungfu',
      args: ['agent-work-lab', 'agent-plan', 'codex.local', '--json'],
      runtimeDir: '/runtime',
    },
    {
      file: '/product/kungfu',
      args: [
        'agent-work-lab',
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
        'agent-work-lab',
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

test('Starter Project uses one preview-confirm-create authority path', async () => {
  const calls: string[][] = [];
  const runtimeDirs: Array<string | undefined> = [];
  const plan = {
    schema: 'kungfu.project-template.plan/v1',
    templateId: 'kungfu.agent-work-starter',
    templateVersion: '1',
    templateRoot: `sha256:${'a'.repeat(64)}`,
    templateSource: '/product/starter-project.json',
    destination: '/projects/agent-work-starter',
    files: [{ path: 'README.md', contentRoot: `sha256:${'b'.repeat(64)}` }],
    initialWork: {
      state: 'capture-pending',
      initiativeId: 'agent-work-starter',
      assignmentId: 'create-launch-brief',
      title: 'Create launch brief',
      acceptanceChecks: ['Use evidence'],
    },
    effects: ['Create files'],
    skippedEffects: ['No overwrite'],
    confirmationRequired: true,
    writeOccurred: false,
    planRoot: `sha256:${'c'.repeat(64)}`,
  } as const;
  const receipt = {
    schema: 'kungfu.project-template.creation-receipt/v1',
    status: 'created',
    templateId: plan.templateId,
    templateRoot: plan.templateRoot,
    planRoot: plan.planRoot,
    destination: plan.destination,
    actor: 'local-user',
    files: plan.files,
    verification: { ok: true, checks: [] },
    initialWork: {
      state: 'captured-pending-admission',
      initiativeId: 'agent-work-starter',
      assignmentId: 'create-launch-brief',
      requestRoot: `sha256:${'d'.repeat(64)}`,
      receiptRoot: `sha256:${'e'.repeat(64)}`,
      requestPath: `${plan.destination}/.kungfu/capture/request.json`,
    },
    openAction: {
      kind: 'select-project-workspace',
      label: 'Open Starter Project',
    },
    nonClaims: [],
    writeOccurred: true,
    receiptRoot: `sha256:${'f'.repeat(64)}`,
  } as const;
  const selection = {
    schema: 'kungfu.workspace.registry/v1',
    last_workspace_id: 'project:starter',
    recent: [],
    updated_at: '2026-07-29T00:00:00Z',
    registry_path: '/config/workspaces.json',
    selected: {
      schema: 'kungfu.workspace.identity/v1',
      workspace_id: 'project:starter',
      identity_root: `sha256:${'1'.repeat(64)}`,
      identity_state: 'qualified',
      workspace_kind: 'project',
      workspace_root: plan.destination,
      display_path: plan.destination,
      data_home: `${plan.destination}/.kungfu`,
      runtime_dir: `${plan.destination}/.kungfu/runtime`,
      initialized: false,
      state: 'uninitialized',
      resolution_reason: 'explicit-project',
      continuation: {},
      available: true,
      selected_at: '2026-07-29T00:00:00Z',
    },
  };
  const lab = openAgentWorkLab({
    runtimeDir: '/runtime',
    bin: '/product/kungfu',
    execFile: async (_file, args, options) => {
      calls.push(args);
      runtimeDirs.push(options.env.KF_RUNTIME_DIR);
      if (args[0] === 'workspace') {
        assert.equal(options.env.KF_RUNTIME_DIR, '/runtime');
        return JSON.stringify(selection);
      }
      return JSON.stringify(args[1] === 'starter-plan' ? plan : receipt);
    },
    execFileSync: () => JSON.stringify(startup),
  });

  const reviewed = await lab.planStarterProject();
  assert.equal(reviewed.writeOccurred, false);
  assert.equal(
    (await lab.createStarterProject(reviewed, 'local-user')).writeOccurred,
    true,
  );
  const opened = await lab.openStarterProject(receipt);
  assert.equal(opened.selected.workspace_root, plan.destination);
  await lab.inspect();
  assert.deepEqual(calls, [
    ['agent-work-lab', 'starter-plan', '--json'],
    [
      'agent-work-lab',
      'starter-create',
      '--destination',
      '/projects/agent-work-starter',
      '--expected-plan-root',
      `sha256:${'c'.repeat(64)}`,
      '--actor',
      'local-user',
      '--execute',
      '--json',
    ],
    ['workspace', 'select', '/projects/agent-work-starter', '--json'],
    ['agent-work-lab', 'inspect', '--json'],
  ]);
  assert.deepEqual(runtimeDirs, [
    '/runtime',
    '/runtime',
    '/runtime',
    '/projects/agent-work-starter/.kungfu/runtime',
  ]);
});

test('Starter Work previews and streams only through the public Work authority', async () => {
  const calls: string[][] = [];
  const plan = {
    schema: 'kungfu.work-start.plan/v1',
    workspace: {
      id: 'project:starter',
      root: '/projects/agent-work-starter',
      identityRoot: `sha256:${'1'.repeat(64)}`,
      initialized: false,
    },
    work: {
      requestPath: '/projects/agent-work-starter/.kungfu/request.json',
      requestRoot: `sha256:${'2'.repeat(64)}`,
      initiativeId: 'agent-work-starter',
      assignmentId: 'create-launch-brief',
      title: 'Create launch brief',
      objective: 'Use evidence',
      acceptanceChecks: ['Use evidence'],
    },
    agent: {
      id: 'codex.local',
      label: 'Codex',
      provider: 'codex',
      profileRoot: `sha256:${'3'.repeat(64)}`,
      selection: 'explicit',
      verification: {
        ok: true,
        available: true,
        version: '1.0.0',
        error: null,
      },
    },
    workControl: {
      profileId: 'kungfu.work-control',
      profileRoot: `sha256:${'4'.repeat(64)}`,
    },
    admissionBinding: {
      ok: true,
      state: 'degraded',
      override: true,
      provenanceRoot: `sha256:${'5'.repeat(64)}`,
      sourceRevision: 'a'.repeat(40),
    },
    actor: 'local-user',
    effects: [{ stage: 'admit', label: 'Admit Work' }],
    skippedEffects: ['completion-claim'],
    confirmationRequired: true,
    executable: true,
    writeOccurred: false,
    planRoot: `sha256:${'6'.repeat(64)}`,
  } as const;
  const event = {
    schema: 'kungfu.work-start.event/v1',
    index: 1,
    stage: 'admit',
    status: 'completed',
    text: 'Work admitted.',
    root: `sha256:${'7'.repeat(64)}`,
  } as const;
  const receipt = {
    schema: 'kungfu.work-start.receipt/v1',
    ok: true,
    status: 'agent-finished',
    planRoot: plan.planRoot,
    receiptRoot: `sha256:${'8'.repeat(64)}`,
    workPhase: 'executing',
    nextActions: ['review-project-changes'],
    writeOccurred: true,
  } as const;
  const projectReceipt = {
    schema: 'kungfu.project-template.creation-receipt/v1',
    status: 'created',
    templateId: 'kungfu.agent-work-starter',
    templateRoot: `sha256:${'9'.repeat(64)}`,
    planRoot: `sha256:${'a'.repeat(64)}`,
    destination: plan.workspace.root,
    actor: 'local-user',
    files: [],
    verification: { ok: true, checks: [] },
    initialWork: {
      state: 'captured-pending-admission',
      initiativeId: plan.work.initiativeId,
      assignmentId: plan.work.assignmentId,
      requestRoot: plan.work.requestRoot,
      receiptRoot: `sha256:${'b'.repeat(64)}`,
      requestPath: plan.work.requestPath,
    },
    openAction: {
      kind: 'select-project-workspace',
      label: 'Open Starter Project',
    },
    nonClaims: [],
    writeOccurred: true,
    receiptRoot: `sha256:${'c'.repeat(64)}`,
  } as const;
  const observed: string[] = [];
  const lab = openAgentWorkLab({
    runtimeDir: '/runtime',
    bin: '/product/kungfu',
    allowForeignBinding: true,
    execFile: async (_file, args) => {
      calls.push(args);
      return JSON.stringify(plan);
    },
    execFileSync: () => JSON.stringify(startup),
    execFileEvents: async (_file, args, _options, onLine) => {
      calls.push(args);
      onLine(JSON.stringify(event));
      onLine(JSON.stringify(receipt));
    },
  });

  const reviewed = await lab.planStarterWork(projectReceipt, 'codex.local');
  const result = await lab.startStarterWork(reviewed, (value) =>
    observed.push(value.text),
  );

  assert.equal(reviewed.writeOccurred, false);
  assert.equal(result.status, 'agent-finished');
  assert.deepEqual(observed, ['Work admitted.']);
  assert.deepEqual(calls, [
    [
      'work',
      'start-plan',
      plan.work.requestPath,
      '--workspace',
      plan.workspace.root,
      '--initiative-id',
      plan.work.initiativeId,
      '--assignment-id',
      plan.work.assignmentId,
      '--agent',
      'codex.local',
      '--actor',
      'local-user',
      '--allow-foreign-binding',
    ],
    [
      'work',
      'start',
      plan.work.requestPath,
      '--workspace',
      plan.workspace.root,
      '--initiative-id',
      plan.work.initiativeId,
      '--assignment-id',
      plan.work.assignmentId,
      '--agent',
      'codex.local',
      '--actor',
      'local-user',
      '--expected-plan-root',
      plan.planRoot,
      '--execute',
      '--allow-foreign-binding',
      '--events-json',
    ],
  ]);
});

test('Starter Review streams one fresh read-only review through public Work authority', async () => {
  const calls: string[][] = [];
  const reviewPlan = {
    schema: 'kungfu.work-review.plan/v1',
    workspace: {
      id: 'project:starter',
      root: '/projects/agent-work-starter',
      identityRoot: `sha256:${'1'.repeat(64)}`,
    },
    work: {
      initiativeId: 'agent-work-starter',
      assignmentId: 'create-launch-brief',
      phase: 'executing',
      queryProofRoot: `sha256:${'2'.repeat(64)}`,
      assignmentRoot: `sha256:${'e'.repeat(64)}`,
      workDefinitionRoot: `sha256:${'3'.repeat(64)}`,
      acceptanceChecks: ['Use evidence'],
    },
    deliverable: {
      path: 'deliverables/launch-brief.md',
      root: `sha256:${'4'.repeat(64)}`,
      content: '# Launch brief',
    },
    inputs: [
      { path: 'inputs/product-notes.md', root: `sha256:${'5'.repeat(64)}` },
    ],
    evidenceMode: 'project-files' as const,
    execution: {
      reportPath: '/projects/agent-work-starter/.kungfu/report.json',
      reportRoot: `sha256:${'6'.repeat(64)}`,
      runId: 'agent-run',
      episodeId: '42',
      agent: {},
    },
    reviewer: {
      id: 'codex.local',
      label: 'Codex',
      provider: 'codex',
      profileRoot: `sha256:${'7'.repeat(64)}`,
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
    admissionBinding: {
      ok: true,
      state: 'degraded',
      override: true,
      provenanceRoot: `sha256:${'8'.repeat(64)}`,
      sourceRevision: 'a'.repeat(40),
    },
    effects: [{ stage: 'run', label: 'Run reviewer' }],
    skippedEffects: ['git-push'],
    confirmationRequired: true,
    executable: true,
    writeOccurred: false,
    planRoot: `sha256:${'9'.repeat(64)}`,
  } as const;
  const workReceipt = {
    schema: 'kungfu.work-start.receipt/v1',
    ok: true,
    status: 'agent-finished',
    planRoot: `sha256:${'a'.repeat(64)}`,
    receiptRoot: `sha256:${'b'.repeat(64)}`,
    workPhase: 'executing',
    workspace: {
      workspace_root: reviewPlan.workspace.root,
    },
    work: {
      requestPath: '/projects/agent-work-starter/.kungfu/request.json',
      requestRoot: `sha256:${'c'.repeat(64)}`,
      initiativeId: reviewPlan.work.initiativeId,
      assignmentId: reviewPlan.work.assignmentId,
      title: 'Create launch brief',
      objective: 'Use evidence',
      acceptanceChecks: ['Use evidence'],
    },
    agentReport: {
      episode: { reportPath: reviewPlan.execution.reportPath },
    },
    nextActions: ['run-independent-review'],
    writeOccurred: true,
  } as const;
  const event = {
    schema: 'kungfu.work-review.event/v1',
    index: 1,
    stage: 'run',
    status: 'started',
    text: 'Fresh Codex reviewer started.',
    root: null,
  } as const;
  const receipt = {
    schema: 'kungfu.work-review.receipt/v1',
    ok: true,
    status: 'review-passed',
    planRoot: reviewPlan.planRoot,
    receiptRoot: `sha256:${'d'.repeat(64)}`,
    workPhase: 'independently-reviewed',
    nativeVerdict: 'fit',
    nextActions: ['decide-close-or-continue'],
    writeOccurred: true,
  } as const;
  const observed: string[] = [];
  const lab = openAgentWorkLab({
    runtimeDir: '/runtime',
    bin: '/product/kungfu',
    allowForeignBinding: true,
    execFile: async (_file, args) => {
      calls.push(args);
      return JSON.stringify(reviewPlan);
    },
    execFileSync: () => JSON.stringify(startup),
    execFileEvents: async (_file, args, _options, onLine) => {
      calls.push(args);
      onLine(JSON.stringify(event));
      onLine(JSON.stringify(receipt));
    },
  });

  const planned = await lab.planStarterReview(
    workReceipt as unknown as WorkStartReceipt,
    'codex.local',
  );
  const reviewed = await lab.runStarterReview(planned, (value) =>
    observed.push(value.text),
  );

  assert.equal(planned.reviewer.permissionMode, 'read-only');
  assert.equal(reviewed.status, 'review-passed');
  assert.deepEqual(observed, ['Fresh Codex reviewer started.']);
  assert.equal(calls[0]?.[1], 'review-agent-plan');
  assert.deepEqual(calls[1]?.slice(-3), [
    '--execute',
    '--allow-foreign-binding',
    '--events-json',
  ]);
});

test('Starter Work close previews the exact review before one confirmed close', async () => {
  const calls: string[][] = [];
  const closePlan = {
    schema: 'kungfu.work-close.plan/v1',
    workspace: {
      id: 'project:starter',
      root: '/projects/agent-work-starter',
      identityRoot: `sha256:${'1'.repeat(64)}`,
    },
    work: {
      initiativeId: 'agent-work-starter',
      assignmentId: 'create-launch-brief',
      phase: 'independently-reviewed',
      queryProofRoot: `sha256:${'2'.repeat(64)}`,
      assignmentRoot: `sha256:${'3'.repeat(64)}`,
    },
    review: {
      id: 'review-starter',
      root: `sha256:${'4'.repeat(64)}`,
      verdict: 'fit',
      continuationPlanRoot: `sha256:${'5'.repeat(64)}`,
      allowedActions: ['approve', 'close'],
    },
    decision: {
      mode: 'required',
      action: 'close',
      root: null,
    },
    effects: [
      { stage: 'decide', label: 'Record close decision' },
      { stage: 'seal', label: 'Seal portable state' },
    ],
    skippedEffects: ['git-commit', 'git-push', 'publish'],
    confirmationRequired: true,
    executable: true,
    writeOccurred: false,
    planRoot: `sha256:${'6'.repeat(64)}`,
  } as const;
  const closeReceipt = {
    schema: 'kungfu.work-close.receipt/v1',
    ok: true,
    status: 'completed',
    planRoot: closePlan.planRoot,
    receiptRoot: `sha256:${'7'.repeat(64)}`,
    workPhase: 'continuation-decided',
    decisionAction: 'close',
    reviewRoot: closePlan.review.root,
    sealedState: {
      schema: 'kungfu.assignment-orchestration.seal-receipt/v1',
      stateRoot: `sha256:${'8'.repeat(64)}`,
      statePath: '/projects/agent-work-starter/.kungfu/state.json',
      storageKind: 'workspace-local',
      portable: true,
      runtimeIndependentVerification: true,
      worktreeDeletionSafe: false,
    },
    nextActions: ['start-your-next-work'],
    writeOccurred: true,
  } as const;
  const projectReceipt = {
    schema: 'kungfu.project-template.creation-receipt/v1',
    status: 'created',
    destination: closePlan.workspace.root,
    initialWork: {
      initiativeId: closePlan.work.initiativeId,
      assignmentId: closePlan.work.assignmentId,
    },
  } as unknown as ProjectTemplateCreationReceipt;
  const lab = openAgentWorkLab({
    runtimeDir: '/runtime',
    bin: '/product/kungfu',
    execFile: async (_file, args) => {
      calls.push(args);
      return JSON.stringify(
        args[1] === 'close-plan' ? closePlan : closeReceipt,
      );
    },
    execFileSync: () => JSON.stringify(startup),
  });

  const planned = await lab.planStarterClose(projectReceipt);
  const completed = await lab.closeStarterWork(planned);

  assert.equal(planned.writeOccurred, false);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(calls, [
    [
      'work',
      'close-plan',
      '--workspace',
      closePlan.workspace.root,
      '--initiative-id',
      closePlan.work.initiativeId,
      '--assignment-id',
      closePlan.work.assignmentId,
    ],
    [
      'work',
      'close',
      '--workspace',
      closePlan.workspace.root,
      '--initiative-id',
      closePlan.work.initiativeId,
      '--assignment-id',
      closePlan.work.assignmentId,
      '--actor',
      'local-user',
      '--expected-plan-root',
      closePlan.planRoot,
      '--execute',
    ],
  ]);
});

test('TUI resume restores the selected Starter Project and retained Agent run', async () => {
  const calls: Array<{ args: string[]; runtimeDir?: string }> = [];
  const destination = '/projects/agent-work-starter';
  const selected = {
    schema: 'kungfu.workspace.identity/v1',
    workspace_id: 'project:starter',
    identity_root: `sha256:${'1'.repeat(64)}`,
    identity_state: 'qualified',
    workspace_kind: 'project',
    workspace_root: destination,
    display_path: destination,
    data_home: `${destination}/.kungfu`,
    runtime_dir: `${destination}/.kungfu/runtime`,
    initialized: true,
    state: 'live-runtime',
    resolution_reason: 'explicit-project',
    continuation: {},
    available: true,
    selected_at: '2026-07-29T00:00:00Z',
  } as const;
  const projectReceipt = {
    schema: 'kungfu.project-template.creation-receipt/v1',
    status: 'resumed',
    templateId: 'kungfu.agent-work-starter',
    templateRoot: `sha256:${'2'.repeat(64)}`,
    planRoot: `sha256:${'3'.repeat(64)}`,
    destination,
    actor: 'retained-project',
    files: [],
    verification: { ok: true, checks: [] },
    initialWork: {
      state: 'captured-pending-admission',
      initiativeId: 'agent-work-starter',
      assignmentId: 'create-launch-brief',
      requestRoot: `sha256:${'4'.repeat(64)}`,
      receiptRoot: `sha256:${'5'.repeat(64)}`,
      requestPath: `${destination}/.kungfu/request.json`,
    },
    activeWork: {
      state: 'captured-pending-admission',
      initiativeId: 'project-work-example',
      assignmentId: 'assignment-project-work-example',
      title: 'Analyze the next commercial objective',
      objective: 'Analyze the next commercial objective',
      acceptanceChecks: ['Return one actionable plan'],
      requestRoot: `sha256:${'9'.repeat(64)}`,
      receiptRoot: `sha256:${'a'.repeat(64)}`,
      requestPath: `${destination}/.kungfu/project-work-request.json`,
    },
    works: [
      {
        state: 'captured-pending-admission',
        initiativeId: 'agent-work-starter',
        assignmentId: 'create-launch-brief',
        title: 'Create a launch brief',
        objective: 'Create a launch brief.',
        acceptanceChecks: ['The launch brief is complete'],
        requestRoot: `sha256:${'4'.repeat(64)}`,
        receiptRoot: `sha256:${'5'.repeat(64)}`,
        requestPath: `${destination}/.kungfu/request.json`,
      },
      {
        state: 'captured-pending-admission',
        initiativeId: 'project-work-example',
        assignmentId: 'assignment-project-work-example',
        title: 'Analyze the next commercial objective',
        objective: 'Analyze the next commercial objective',
        acceptanceChecks: ['Return one actionable plan'],
        requestRoot: `sha256:${'9'.repeat(64)}`,
        receiptRoot: `sha256:${'a'.repeat(64)}`,
        requestPath: `${destination}/.kungfu/project-work-request.json`,
      },
    ],
    openAction: {
      kind: 'select-project-workspace',
      label: 'Open Starter Project',
    },
    nonClaims: [],
    writeOccurred: false,
    receiptRoot: `sha256:${'6'.repeat(64)}`,
  } as const;
  const workReceipt = {
    schema: 'kungfu.work-start.receipt/v1',
    ok: true,
    status: 'agent-finished',
    planRoot: `sha256:${'7'.repeat(64)}`,
    receiptRoot: `sha256:${'8'.repeat(64)}`,
    workPhase: 'executing',
    nextActions: ['run-independent-review'],
    writeOccurred: true,
  } as const;
  const lab = openAgentWorkLab({
    runtimeDir: '/runtime',
    bin: '/product/kungfu',
    execFile: async (_file, args, options) => {
      calls.push({ args, runtimeDir: options.env.KF_RUNTIME_DIR });
      if (args[0] === 'workspace' && args[1] === 'list') {
        return JSON.stringify({
          schema: 'kungfu.workspace.registry/v1',
          last_workspace_id: selected.workspace_id,
          recent: [selected],
        });
      }
      if (args[0] === 'agent-work-lab') return JSON.stringify(projectReceipt);
      if (args[0] === 'workspace') {
        return JSON.stringify({
          schema: 'kungfu.workspace.registry/v1',
          last_workspace_id: selected.workspace_id,
          recent: [selected],
          selected,
        });
      }
      if (args[1] === 'resume-prepare') {
        return JSON.stringify({
          schema: 'kungfu.work.resume-prepare/v1',
          status: 'reconciled',
          profileId: 'kungfu.work-control',
          previousProfileSuiteRoot: `sha256:${'b'.repeat(64)}`,
          profileSuiteRoot: `sha256:${'c'.repeat(64)}`,
          profileLifecycleReceiptCount: 3,
          writeOccurred: true,
          workspace: selected,
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
      return JSON.stringify({
        schema: 'kungfu.work-start.resume/v1',
        status: 'retained-agent-run',
        workReceipt,
        writeOccurred: false,
      });
    },
    execFileSync: () => JSON.stringify(startup),
  });

  const resumed = await lab.resumeStarterProject();

  assert.equal(resumed?.project.receipt.status, 'resumed');
  assert.equal(
    resumed?.project.work?.assignmentId,
    'assignment-project-work-example',
  );
  assert.deepEqual(
    resumed?.project.works.map((work) => work.assignmentId),
    ['create-launch-brief', 'assignment-project-work-example'],
  );
  assert.equal(resumed?.workReceipt?.status, 'agent-finished');
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ['workspace', 'list', '--json'],
      [
        'agent-work-lab',
        'starter-resume',
        '--workspace',
        destination,
        '--json',
      ],
      ['workspace', 'select', destination, '--json'],
      [
        'work',
        'resume-prepare',
        '--workspace',
        destination,
        '--actor',
        'kungfu-product-project-resume',
        '--execute',
      ],
      [
        'work',
        'start-resume',
        '--workspace',
        destination,
        '--initiative-id',
        'project-work-example',
        '--assignment-id',
        'assignment-project-work-example',
      ],
      [
        'work',
        'close-resume',
        '--workspace',
        destination,
        '--initiative-id',
        'project-work-example',
        '--assignment-id',
        'assignment-project-work-example',
      ],
    ],
  );
  assert.equal(calls.at(-1)?.runtimeDir, `${destination}/.kungfu/runtime`);
});

test('the adapter streams safe milestones before returning the canonical report', async () => {
  const received: string[] = [];
  const event = {
    schema: 'kungfu.agent-work-lab.event/v1',
    step: 'session-1-start',
    status: 'running',
    root: `sha256:${'a'.repeat(64)}`,
  } as const;
  const report = {
    schema: 'kungfu.agent-work-lab.report/v1',
    status: 'qualified',
    events: [event],
  };
  const lab = openAgentWorkLab({
    runtimeDir: '/runtime',
    bin: '/product/kungfu',
    execFile: async () => JSON.stringify(report),
    execFileSync: () => JSON.stringify(startup),
    execFileEvents: async (_file, args, _options, onLine) => {
      assert.deepEqual(args, [
        'agent-work-lab',
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
    agentWorkLabStartupSurface({
      ...startup,
      state: 'existing-work',
      route: 'work-graph',
      workGraphPresent: true,
    }),
    'work-graph',
  );
  assert.equal(agentWorkLabStartupSurface(startup), 'agent-work-lab');
  assert.equal(
    agentWorkLabStartupSurface({
      ...startup,
      state: 'diagnostic',
      route: 'diagnostic',
      workGraphPresent: null,
    }),
    'agent-work-lab',
  );
  assert.equal(
    agentWorkLabStartupSurface({
      ...startup,
      state: 'verified-empty',
      route: 'work-graph',
      workGraphPresent: true,
    }),
    'agent-work-lab',
  );
});

test('run progress distinguishes a live wait from an admitted event', () => {
  assert.equal(
    agentWorkLabRunProgressLabel({
      elapsedMs: 2400,
      quietMs: 2400,
      eventCount: 0,
    }),
    'Still running · 2s elapsed · waiting for first admitted event',
  );
  assert.equal(
    agentWorkLabRunProgressLabel({
      elapsedMs: 12_400,
      quietMs: 5400,
      eventCount: 4,
    }),
    'Still running · 12s elapsed · 4 admitted events shown · last update 5s ago',
  );
});
