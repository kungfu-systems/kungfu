// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type {
  ProjectTemplateCreationReceipt,
  ProjectTemplateWorkspaceSelection,
  WorkCloseReceipt,
  WorkReviewReceipt,
  WorkStartReceipt,
} from '@kungfu-tech/api/capability';

import { renderProfileShellSnapshot } from './profile-shell.js';
import {
  agentProfileSourceLabel,
  deterministicMockAgentSelection,
  deterministicMockSelectionForStage,
  openedProjectWorkReference,
  openedProjectWorks,
  projectSectionNavigationAtPoint,
  reviewReceiptCanResume,
  starterProjectInputAction,
  starterProjectModel,
  starterProjectOverviewEnterStage,
  starterWorkEventLine,
  workReceiptHasRetainedSession,
} from './starter-project-view/index.js';

test('starter project input state machine preserves stage-specific commands', () => {
  const context = {
    stage: 'detail' as const,
    planExecutable: false,
    reviewPlanExecutable: false,
    closePlanExecutable: false,
  };
  assert.deepEqual(starterProjectInputAction('\r', context), {
    kind: 'open-agents',
  });
  assert.deepEqual(
    starterProjectInputAction('\u001b[B', { ...context, stage: 'agents' }),
    { kind: 'select-profile', delta: 1 },
  );
  assert.deepEqual(
    starterProjectInputAction('\r', {
      ...context,
      stage: 'preview',
      planExecutable: true,
    }),
    { kind: 'start' },
  );
  assert.deepEqual(
    starterProjectInputAction('a', { ...context, stage: 'review' }),
    { kind: 'reset-review', stage: 'detail' },
  );
  assert.deepEqual(
    starterProjectInputAction('\t', { ...context, stage: 'overview' }),
    { kind: 'select-region', delta: 1 },
  );
  assert.deepEqual(
    starterProjectInputAction('q', { ...context, stage: 'running' }),
    { kind: 'none' },
  );
});

const receipt = {
  schema: 'kungfu.project-template.creation-receipt/v1',
  status: 'created',
  templateId: 'kungfu.agent-work-starter',
  templateRoot: `sha256:${'1'.repeat(64)}`,
  planRoot: `sha256:${'2'.repeat(64)}`,
  destination: '/projects/agent-work-starter',
  actor: 'local-user',
  files: [{ path: 'AGENTS.md', contentRoot: `sha256:${'3'.repeat(64)}` }],
  verification: { ok: true, checks: [] },
  initialWork: {
    state: 'captured-pending-admission',
    initiativeId: 'agent-work-starter',
    assignmentId: 'create-launch-brief',
    requestRoot: `sha256:${'4'.repeat(64)}`,
    receiptRoot: `sha256:${'5'.repeat(64)}`,
    requestPath:
      '/projects/agent-work-starter/.kungfu/assignment-capture/request.json',
  },
  openAction: {
    kind: 'select-project-workspace',
    label: 'Open Starter Project',
  },
  nonClaims: [],
  writeOccurred: true,
  receiptRoot: `sha256:${'6'.repeat(64)}`,
} satisfies ProjectTemplateCreationReceipt;

const workspace = {
  schema: 'kungfu.workspace.registry/v1',
  last_workspace_id: 'project:starter',
  recent: [],
  updated_at: '2026-07-29T00:00:00Z',
  registry_path: '/config/workspaces.json',
  selected: {
    schema: 'kungfu.workspace.identity/v1',
    workspace_id: 'project:starter',
    identity_root: `sha256:${'7'.repeat(64)}`,
    identity_state: 'qualified',
    workspace_kind: 'project',
    workspace_root: receipt.destination,
    display_path: receipt.destination,
    data_home: `${receipt.destination}/.kungfu`,
    runtime_dir: `${receipt.destination}/.kungfu/runtime`,
    initialized: false,
    state: 'uninitialized',
    resolution_reason: 'explicit-project',
    continuation: {},
    available: true,
    selected_at: '2026-07-29T00:00:00Z',
  },
} satisfies ProjectTemplateWorkspaceSelection;

test('opened Starter Project shows captured Work without claiming admission', () => {
  const model = starterProjectModel({ receipt, workspace });
  const snapshot = renderProfileShellSnapshot(model, {
    columns: 100,
    rows: 28,
  });

  assert.equal(model.subject.id, 'work');
  assert.equal(model.cards[0]?.id, 'create-launch-brief');
  assert.equal(model.cards[0]?.status, 'pending admission');
  assert.match(model.cards[0]?.summary ?? '', /Press Enter/);
  assert.match(model.notice ?? '', /no Agent has run/);
  assert.match(model.notice ?? '', /AGENTS\.md/);
  assert.match(snapshot, /Project · agent-work-starter/);
  assert.match(snapshot, /Files\[tree\] · Work\[1\]/);
  assert.match(snapshot, /Create an evidence-backed launch brief/);
  assert.match(snapshot, /pending admission/);
  assert.doesNotMatch(snapshot, /completed/i);
});

test('retained Agent run keeps Work visibly unsettled', () => {
  const model = starterProjectModel(
    { receipt, workspace },
    {
      schema: 'kungfu.work-start.receipt/v1',
      ok: true,
      status: 'agent-finished',
      planRoot: `sha256:${'8'.repeat(64)}`,
      receiptRoot: `sha256:${'9'.repeat(64)}`,
      workPhase: 'executing',
      nextActions: ['review-project-changes'],
      writeOccurred: true,
    },
  );

  assert.equal(model.cards[0]?.status, 'executing · review required');
  assert.match(model.cards[0]?.summary ?? '', /Press Enter to review/);
  assert.match(model.notice ?? '', /not completion/);
});

test('failed Agent run points to retained evidence without claiming review readiness', () => {
  const model = starterProjectModel(
    { receipt, workspace },
    {
      schema: 'kungfu.work-start.receipt/v1',
      ok: false,
      status: 'agent-failed',
      planRoot: `sha256:${'8'.repeat(64)}`,
      receiptRoot: `sha256:${'9'.repeat(64)}`,
      workPhase: 'executing',
      failedAt: 'run',
      message: 'Agent process exited 1.',
      nextActions: ['inspect-retained-agent-report'],
      writeOccurred: true,
    },
  );

  assert.equal(model.cards[0]?.status, 'executing · attention required');
  assert.match(model.cards[0]?.summary ?? '', /report is retained/);
  assert.match(model.cards[0]?.summary ?? '', /run failed/);
  assert.doesNotMatch(model.cards[0]?.summary ?? '', /Review the changed/);
  assert.match(model.notice ?? '', /no completion is claimed/);
});

test('partial authority failure does not pretend that an Agent ran', () => {
  const model = starterProjectModel(
    { receipt, workspace },
    {
      schema: 'kungfu.work-start.receipt/v1',
      ok: false,
      status: 'failed',
      planRoot: `sha256:${'8'.repeat(64)}`,
      receiptRoot: `sha256:${'9'.repeat(64)}`,
      workPhase: 'admitted',
      failedAt: 'claim',
      message: 'Claim failed.',
      nextActions: ['inspect-current-work-status'],
      writeOccurred: true,
    },
  );

  assert.equal(model.cards[0]?.status, 'admitted · attention required');
  assert.match(model.cards[0]?.summary ?? '', /stopped at claim/);
  assert.doesNotMatch(model.cards[0]?.summary ?? '', /Agent run is retained/);
  assert.match(model.notice ?? '', /Work start is incomplete/);
});

test('a retained successful run opens Review Work instead of repeating Work start', () => {
  assert.equal(starterProjectOverviewEnterStage(), 'detail');
  assert.equal(
    starterProjectOverviewEnterStage({
      schema: 'kungfu.work-start.receipt/v1',
      ok: true,
      status: 'agent-finished',
      planRoot: `sha256:${'8'.repeat(64)}`,
      receiptRoot: `sha256:${'9'.repeat(64)}`,
      workPhase: 'executing',
      nextActions: ['review-project-changes'],
      writeOccurred: true,
    }),
    'review',
  );
});

test('independent review state remains distinct from Agent exit', () => {
  const workReceipt: WorkStartReceipt = {
    schema: 'kungfu.work-start.receipt/v1',
    ok: true,
    status: 'agent-finished',
    planRoot: `sha256:${'8'.repeat(64)}`,
    receiptRoot: `sha256:${'9'.repeat(64)}`,
    workPhase: 'executing',
    nextActions: ['review-project-changes'],
    writeOccurred: true,
  };
  const reviewReceipt: WorkReviewReceipt = {
    schema: 'kungfu.work-review.receipt/v1',
    ok: true,
    status: 'review-passed',
    planRoot: `sha256:${'a'.repeat(64)}`,
    receiptRoot: `sha256:${'b'.repeat(64)}`,
    workPhase: 'independently-reviewed',
    nativeVerdict: 'fit',
    nextActions: ['decide-close-or-continue'],
    writeOccurred: true,
  };

  const model = starterProjectModel(
    { receipt, workspace },
    workReceipt,
    reviewReceipt,
  );
  assert.equal(
    model.cards[0]?.status,
    'independently reviewed · decision required',
  );
  assert.match(model.cards[0]?.summary ?? '', /final completion decision/);
  assert.equal(
    starterProjectOverviewEnterStage(workReceipt, reviewReceipt),
    'review-result',
  );
});

test('a failed independent review returns Work to a fresh Agent attempt', () => {
  const reviewReceipt = {
    schema: 'kungfu.work-review.receipt/v1',
    ok: false,
    status: 'revision-required',
    workPhase: 'executing',
  } as WorkReviewReceipt;

  assert.equal(
    starterProjectOverviewEnterStage(undefined, reviewReceipt),
    'detail',
  );
});

test('Review Work exposes a durable fresh-Agent revision route', () => {
  const source = readFileSync(
    new URL('./starter-project-view/index.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /\[a\] revise with fresh Agent/u);
  assert.deepEqual(
    starterProjectInputAction('a', {
      stage: 'review',
      planExecutable: false,
      reviewPlanExecutable: false,
      closePlanExecutable: false,
    }),
    { kind: 'reset-review', stage: 'detail' },
  );
});

test('human-confirmed close is shown as completed with retained evidence', () => {
  const workReceipt: WorkStartReceipt = {
    schema: 'kungfu.work-start.receipt/v1',
    ok: true,
    status: 'agent-finished',
    planRoot: `sha256:${'8'.repeat(64)}`,
    receiptRoot: `sha256:${'9'.repeat(64)}`,
    workPhase: 'executing',
    nextActions: ['review-project-changes'],
    writeOccurred: true,
  };
  const reviewReceipt: WorkReviewReceipt = {
    schema: 'kungfu.work-review.receipt/v1',
    ok: true,
    status: 'review-passed',
    planRoot: `sha256:${'a'.repeat(64)}`,
    receiptRoot: `sha256:${'b'.repeat(64)}`,
    workPhase: 'independently-reviewed',
    nativeVerdict: 'fit',
    nextActions: ['decide-close-or-continue'],
    writeOccurred: true,
  };
  const closeReceipt: WorkCloseReceipt = {
    schema: 'kungfu.work-close.receipt/v1',
    ok: true,
    status: 'completed',
    planRoot: `sha256:${'c'.repeat(64)}`,
    receiptRoot: `sha256:${'d'.repeat(64)}`,
    workPhase: 'continuation-decided',
    decisionAction: 'close',
    reviewRoot: `sha256:${'e'.repeat(64)}`,
    sealedState: {
      schema: 'kungfu.assignment-orchestration.seal-receipt/v1',
      stateRoot: `sha256:${'f'.repeat(64)}`,
      statePath: '/project/.kungfu/assignment-states/state.json',
      storageKind: 'workspace-fallback',
      portable: true,
      runtimeIndependentVerification: true,
      worktreeDeletionSafe: false,
    },
    nextActions: ['start-your-next-work'],
    writeOccurred: true,
  };

  const model = starterProjectModel(
    { receipt, workspace },
    workReceipt,
    reviewReceipt,
    closeReceipt,
  );

  assert.equal(model.cards[0]?.status, 'completed · evidence retained');
  assert.match(model.cards[0]?.summary ?? '', /human close decision/);
  assert.match(model.notice ?? '', /human-confirmed/);
  assert.equal(
    starterProjectOverviewEnterStage(workReceipt, reviewReceipt, closeReceipt),
    'close-result',
  );
});

test('ordinary captured Project Work reuses the governed Starter work loop', () => {
  const project = {
    workspace,
    work: {
      state: 'captured-pending-admission' as const,
      initiativeId: 'project-work-example',
      assignmentId: 'create-checklist-example',
      title: 'Create a launch checklist',
      objective: 'Create a launch checklist from the repository evidence.',
      acceptanceChecks: [
        'The checklist contains five verified steps',
        'Validation evidence and unresolved risks are reported',
      ],
      requestRoot: `sha256:${'1'.repeat(64)}`,
      receiptRoot: `sha256:${'2'.repeat(64)}`,
      requestPath: '/project/.kungfu/inbox/request.json',
    },
  };

  const model = starterProjectModel(project);

  assert.equal(model.profile.title, 'Project');
  assert.equal(model.cards[0]?.id, 'create-checklist-example');
  assert.equal(model.cards[0]?.status, 'pending admission');
  assert.deepEqual(openedProjectWorkReference(project), {
    destination: workspace.selected.workspace_root,
    initialWork: {
      initiativeId: 'project-work-example',
      assignmentId: 'create-checklist-example',
      requestPath: '/project/.kungfu/inbox/request.json',
    },
  });
});

test('Project lists every retained Work in one flat navigable view', () => {
  const works = [
    {
      ...receipt.initialWork,
      title: 'Create the launch brief',
      objective: 'Create the launch brief.',
      acceptanceChecks: ['The brief is complete'],
      settled: true,
      phase: 'continuation-decided',
      stateRoot: `sha256:${'a'.repeat(64)}`,
    },
    {
      state: 'captured-pending-admission' as const,
      initiativeId: 'commercial-plan',
      assignmentId: 'analyze-objective',
      title: 'Analyze the commercial objective',
      objective: 'Analyze the commercial objective.',
      acceptanceChecks: ['Return one actionable plan'],
      requestRoot: `sha256:${'b'.repeat(64)}`,
      receiptRoot: `sha256:${'c'.repeat(64)}`,
      requestPath: '/project/.kungfu/analyze-objective.json',
    },
    {
      state: 'captured-pending-admission' as const,
      initiativeId: 'commercial-plan',
      assignmentId: 'draft-plan',
      title: 'Draft the execution plan',
      objective: 'Draft the execution plan.',
      acceptanceChecks: ['Return one reviewed plan'],
      requestRoot: `sha256:${'d'.repeat(64)}`,
      receiptRoot: `sha256:${'e'.repeat(64)}`,
      requestPath: '/project/.kungfu/draft-plan.json',
    },
  ];
  const project = { receipt, workspace, work: works[1], works };
  const model = starterProjectModel(project);

  assert.equal(openedProjectWorks(project).length, 3);
  assert.deepEqual(
    model.navigation.map((item) => item.label),
    ['Files', 'Work'],
  );
  assert.equal(model.navigationTitle, 'Project');
  assert.equal(model.retainNavigationInCompact, true);
  assert.deepEqual(
    model.cards.map((card) => card.title),
    [
      'Create the launch brief',
      'Analyze the commercial objective',
      'Draft the execution plan',
    ],
  );
  assert.equal(model.subject.id, 'work');
  assert.doesNotMatch(
    JSON.stringify(model),
    /First real Work|Subjects|Initiative|Assignment|Portfolio/,
  );
});

test('Project navigation pointer resolves only Files and Work rows', () => {
  assert.equal(
    projectSectionNavigationAtPoint({
      dimensions: { columns: 120, rows: 36 },
      column: 8,
      row: 5,
    }),
    'files',
  );
  assert.equal(
    projectSectionNavigationAtPoint({
      dimensions: { columns: 120, rows: 36 },
      column: 8,
      row: 6,
    }),
    'work',
  );
  assert.equal(
    projectSectionNavigationAtPoint({
      dimensions: { columns: 120, rows: 36 },
      column: 8,
      row: 7,
    }),
    null,
  );
  assert.equal(
    projectSectionNavigationAtPoint({
      dimensions: { columns: 80, rows: 24 },
      column: 8,
      row: 5,
    }),
    'files',
  );
});

test('interrupted review settlement resumes without trapping the project overview', () => {
  const workReceipt: WorkStartReceipt = {
    schema: 'kungfu.work-start.receipt/v1',
    ok: true,
    status: 'agent-finished',
    planRoot: `sha256:${'8'.repeat(64)}`,
    receiptRoot: `sha256:${'9'.repeat(64)}`,
    workPhase: 'executing',
    nextActions: ['review-project-changes'],
    writeOccurred: true,
  };
  const reviewReceipt: WorkReviewReceipt = {
    schema: 'kungfu.work-review.receipt/v1',
    ok: false,
    status: 'settlement-interrupted',
    planRoot: `sha256:${'a'.repeat(64)}`,
    receiptRoot: `sha256:${'b'.repeat(64)}`,
    workPhase: 'executing',
    message: 'an active execution lease is required for phase advancement',
    nextActions: ['resume-review-settlement'],
    writeOccurred: true,
  };

  const model = starterProjectModel(
    { receipt, workspace },
    workReceipt,
    reviewReceipt,
  );

  assert.equal(reviewReceiptCanResume(reviewReceipt), true);
  assert.equal(model.cards[0]?.status, 'executing · review settlement paused');
  assert.match(model.cards[0]?.summary ?? '', /resume only the remaining/);
  assert.equal(
    starterProjectOverviewEnterStage(workReceipt, reviewReceipt),
    'review',
  );
});

test('Agent selection exposes configured and auto-discovered sources', () => {
  assert.equal(
    agentProfileSourceLabel('configured'),
    'Configured · Kungfu config',
  );
  assert.equal(
    agentProfileSourceLabel('discovered', 'path_cli'),
    'Auto-discovered · path cli',
  );
  assert.equal(
    agentProfileSourceLabel('qualification'),
    'Qualification fixture · deterministic and credential-free',
  );
});

test('deterministic Mock Agent selection binds the requested scenario', () => {
  const profile = deterministicMockAgentSelection('approval');

  assert.equal(profile.id, 'kungfu.mock-agent.approval');
  assert.equal(profile.label, 'Mock Agent · approval');
  assert.equal(profile.provider, 'synthetic');
  assert.equal(profile.source, 'qualification');
});

test('deterministic Mock onboarding owns execution and review stages', () => {
  const execution = deterministicMockSelectionForStage(
    'recovery-story',
    'agents',
  );
  const review = deterministicMockSelectionForStage(
    'recovery-story',
    'review-agents',
  );

  assert.equal(execution?.id, 'kungfu.mock-agent.recovery-story');
  assert.equal(execution?.label, 'Mock Agent · recovery-story');
  assert.equal(review?.id, 'kungfu.mock-agent.review-fit');
  assert.equal(review?.label, 'Mock Reviewer · deterministic-fit');
  assert.equal(deterministicMockSelectionForStage('  ', 'agents'), null);
  assert.equal(deterministicMockSelectionForStage(undefined, 'agents'), null);
});

test('deterministic Mock onboarding bypasses external Agent discovery', () => {
  const source = readFileSync(
    new URL('./starter-project-view/index.tsx', import.meta.url),
    'utf8',
  );
  const host = source.slice(
    source.indexOf('export function StarterProjectHost'),
  );
  const deterministicBranch = host.indexOf(
    'const deterministicMock = deterministicMockSelectionForStage',
  );
  const externalDiscovery = host.indexOf('.discoverAgents()');

  assert.ok(deterministicBranch >= 0);
  assert.ok(externalDiscovery > deterministicBranch);
  assert.match(
    host.slice(deterministicBranch, externalDiscovery),
    /if \(deterministicMock\)[\s\S]*?setProfiles\(\[deterministicMock\]\)[\s\S]*?return;/u,
  );
});

test('Starter onboarding stabilizes the Agent Session before binding the Work start plan', () => {
  const source = readFileSync(
    new URL('./starter-project-view/index.tsx', import.meta.url),
    'utf8',
  );
  const preview = source.slice(
    source.indexOf('const preview = React.useCallback'),
    source.indexOf('const start = React.useCallback'),
  );

  assert.match(
    preview,
    /ensureAgentSession\(project\.workspace\.selected\.runtime_dir\)[\s\S]*?\.then\(\(\) => lab\.planStarterWork\(workReference, profile\.id\)\)/u,
  );
});

test('retained Agent Session receipts route back to the interactive Project surface', () => {
  const retained = {
    schema: 'kungfu.work-start.receipt/v1',
    ok: true,
    status: 'agent-waiting',
    planRoot: `sha256:${'8'.repeat(64)}`,
    receiptRoot: `sha256:${'9'.repeat(64)}`,
    workPhase: 'executing',
    nextActions: ['reply'],
    writeOccurred: true,
    agentReport: {
      session: {
        workConsoleId: 'work:project:assignment:alpha',
        sessionAttemptId: 'attempt:alpha:1',
      },
    },
  } as unknown as WorkStartReceipt;

  assert.equal(workReceiptHasRetainedSession(retained), true);
  assert.equal(
    workReceiptHasRetainedSession({
      ...retained,
      agentReport: undefined,
    } as unknown as WorkStartReceipt),
    false,
  );
});

test('Starter Project starts Work through its exact runtime-scoped Agent Session', () => {
  const source = readFileSync(
    new URL('./starter-project-view/index.tsx', import.meta.url),
    'utf8',
  );
  const host = source.slice(
    source.indexOf('export function StarterProjectHost'),
  );

  assert.match(
    host,
    /ensureAgentSession\(project\.workspace\.selected\.runtime_dir\)/u,
  );
  assert.ok(
    host.indexOf('ensureAgentSession(project.workspace.selected.runtime_dir)') <
      host.indexOf('lab.startStarterWork'),
    'the exact Project Agent Session must exist before Work start',
  );
});

test('Project Work keeps Agent answer text out of the global control bar', () => {
  const source = readFileSync(
    new URL('./work-window/index.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /Boolean\(composer\) \|\| agentReply !== undefined/u);
  assert.match(source, /onInputModeChange\(workspaceInputActive\)/u);
});

test('ended failed Agent attempts remain retryable when the old Session is observer-only', () => {
  const source = readFileSync(
    new URL('./work-window/index.tsx', import.meta.url),
    'utf8',
  );

  assert.ok(
    source.indexOf("attention?.kind === 'blocked' && value === 'r'") <
      source.indexOf('session?.controllable === false'),
  );
});

test('real Agent activity shows a credential-safe workspace command preview', () => {
  const line = starterWorkEventLine({
    schema: 'kungfu.work-start.event/v1',
    index: 6,
    stage: 'run',
    status: 'started',
    text: 'Workspace command started. pnpm test',
    root: null,
    activity: {
      schema: 'kungfu.agent-run.activity/v1',
      kind: 'tool',
      phase: 'started',
      text: 'Workspace command started. pnpm test',
      commandPreview: 'pnpm test',
      rawToolArgumentsExposed: false,
    },
  });

  assert.equal(line, '06 tool   Workspace command started. pnpm test');
});
