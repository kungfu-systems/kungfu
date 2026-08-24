// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type {
  AgentWorkLabEvent,
  AgentWorkLabReport,
} from '@kungfu-tech/api/capability';
import {
  AGENT_WORK_LAB_SUITE,
  agentWorkLabRecommendation,
} from '../../../extensions/agent-work-lab/experience/src/index.js';
import {
  projectInventoryWorkRows,
  resolveSelectedProjectWorkRow,
} from '../../../extensions/work-dashboard/src/view/index';
import {
  actionableKfxFailures,
  shouldOpenAgentWorkLab,
  unavailableKfxMessage,
} from './kfx-availability';
import {
  AGENT_WORK_LAB_MODES,
  AGENT_WORK_LAB_PLAYBACK_TIMING,
  agentWorkLabBehaviorFindings,
  agentWorkLabModeNeeds,
  agentWorkLabPlaybackLines,
  agentWorkLabSessionStories,
} from './renderer/src/agent-work-lab';
import { openRendererProjects } from './renderer/src/projects-panel/index';

const qualifiedReport = {
  status: 'qualified',
  events: [
    { step: 'session-1', status: 'ended-partial' },
    { step: 'session-2', status: 'ended-complete' },
  ],
  assessment: {
    oracleChecks: [
      {
        id: 'second-attempt-recognized-partial-state',
        passed: true,
      },
    ],
    residualRisks: [],
  },
} as unknown as AgentWorkLabReport;

test('the Lab exposes one explicit selector for all three experiment modes', () => {
  assert.deepEqual(
    AGENT_WORK_LAB_MODES.map(({ id }) => id),
    ['offline-demo', 'same-agent', 'cross-agent'],
  );
  assert.deepEqual(agentWorkLabModeNeeds('offline-demo'), {
    source: false,
    target: false,
  });
  assert.deepEqual(agentWorkLabModeNeeds('same-agent'), {
    source: true,
    target: false,
  });
  assert.deepEqual(agentWorkLabModeNeeds('cross-agent'), {
    source: true,
    target: true,
  });
  assert.equal(AGENT_WORK_LAB_SUITE.title, 'Agent Work Lab');
  assert.equal(AGENT_WORK_LAB_SUITE.collection.title, 'Work Continuity');
  assert.deepEqual(
    AGENT_WORK_LAB_MODES.map(({ id, label }) => ({ id, label })),
    AGENT_WORK_LAB_SUITE.cases.map(({ id, title }) => ({
      id,
      label: title,
    })),
  );
  assert.equal(
    agentWorkLabRecommendation('offline-demo').nextCase,
    'same-agent',
  );
});

test('the shell falls back to Agent Work Lab when no KFX is admitted', () => {
  assert.equal(shouldOpenAgentWorkLab('work-graph', 0), true);
  assert.equal(shouldOpenAgentWorkLab('agent-work-lab', 10), true);
  assert.equal(shouldOpenAgentWorkLab('work-graph', 10), false);
  assert.equal(
    unavailableKfxMessage(10),
    '10 extensions discovered, but none admitted for GUI execution',
  );
  assert.equal(
    unavailableKfxMessage(0),
    'no extensions found on the extension path',
  );
  assert.deepEqual(
    actionableKfxFailures(
      [
        {
          error:
            'KF_KFX_HOST_NOT_AUTHORIZED: exact Core host authorization required',
        },
        { error: 'bundle syntax error' },
      ],
      false,
    ),
    [{ error: 'bundle syntax error' }],
  );
});

test('the two session stories distinguish bounded progress from continuation', () => {
  const [first, second] = agentWorkLabSessionStories(
    'cross-agent',
    false,
    qualifiedReport,
  );

  assert.equal(first.title, 'Session 1');
  assert.equal(first.subtitle, 'Source local agent');
  assert.equal(first.milestones[0]?.status, 'correct');
  assert.equal(first.milestones[0]?.title, 'Partial result saved');

  assert.equal(second.title, 'Session 2');
  assert.equal(second.subtitle, 'Target local agent');
  assert.equal(second.milestones[0]?.status, 'correct');
  assert.equal(second.milestones[1]?.title, 'Continued correctly');
  assert.match(
    second.milestones[1]?.detail ?? '',
    /remaining work.*same task identity/,
  );
});

test('an in-flight atomic report never fabricates Session 2 progress', () => {
  const [first, second] = agentWorkLabSessionStories('same-agent', true, null);

  assert.equal(first.milestones[0]?.status, 'running');
  assert.equal(second.milestones[0]?.status, 'waiting');
  assert.match(
    second.milestones[0]?.detail ?? '',
    /waits rather than guessing/,
  );
});

test('canonical oracle failures and residuals stay visually distinct', () => {
  const report = {
    ...qualifiedReport,
    status: 'qualified-with-residuals',
    assessment: {
      oracleChecks: [
        {
          id: 'second-attempt-recognized-partial-state',
          passed: false,
        },
      ],
      residualRisks: [
        'Provider confinement remains to be independently proven.',
      ],
    },
  } as AgentWorkLabReport;
  const findings = agentWorkLabBehaviorFindings(report);

  assert.deepEqual(
    findings.map(({ status }) => status),
    ['undesirable', 'warning'],
  );
});

test('canonical runtime events expand into public terminal activity', () => {
  const event = {
    schema: 'kungfu.agent-work-lab.event/v1',
    step: 'session-2-start',
    status: 'running',
    root: `sha256:${'a'.repeat(64)}`,
  } as const;
  const lines = agentWorkLabPlaybackLines(event);

  assert.deepEqual(
    lines.map(({ session, kind }) => ({ session, kind })),
    [
      { session: 2, kind: 'user' },
      { session: 2, kind: 'agent' },
      { session: 2, kind: 'tool' },
    ],
  );
  assert.equal(lines[0]?.kind, 'user');
  assert.match(lines[1]?.command ?? '', /recover the task state/);
  assert.match(lines[1]?.detail ?? '', /agent\/live/);
  assert.match(lines[2]?.command ?? '', /fresh provider process 2/);
  assert.match(
    lines[2]?.detail ?? '',
    /instead of treating terminal text as proof/,
  );
  assert.equal(AGENT_WORK_LAB_PLAYBACK_TIMING.eventDelayMs, 1000);
  assert.equal(AGENT_WORK_LAB_PLAYBACK_TIMING.verdictDelayMs, 520);
  assert.equal(
    AGENT_WORK_LAB_PLAYBACK_TIMING.eventDelayMs,
    AGENT_WORK_LAB_SUITE.timing.eventIntervalMs,
  );
});

test('live provider activity becomes safe agent and tool narration', () => {
  const agentEvent = {
    schema: 'kungfu.agent-work-lab.event/v1',
    step: 'session-1-activity',
    status: 'running',
    root: `sha256:${'c'.repeat(64)}`,
    publicActivity: {
      schema: 'kungfu.agent-work-lab.public-activity/v1',
      source: 'provider-jsonl',
      kind: 'agent',
      phase: 'progress',
      text: 'I’m starting fresh, so I’ll inspect the governed task state first.',
      rawOutputRedacted: true,
    },
  } as const;
  const toolEvent = {
    ...agentEvent,
    publicActivity: {
      ...agentEvent.publicActivity,
      kind: 'tool',
      phase: 'started',
      text: 'Using a bounded tool inside the isolated test workspace.',
    },
  } as const;

  assert.deepEqual(agentWorkLabPlaybackLines(agentEvent)[0], {
    session: 1,
    kind: 'agent',
    origin: 'provider-observation',
    status: 'running',
    command:
      'I’m starting fresh, so I’ll inspect the governed task state first.',
    detail:
      'A live public status message emitted by the selected Agent. It is not private reasoning.',
  });
  assert.equal(agentWorkLabPlaybackLines(toolEvent)[0]?.kind, 'tool');
  assert.match(
    agentWorkLabPlaybackLines(toolEvent)[0]?.detail ?? '',
    /raw tool output remain redacted/,
  );
});

test('only admitted provider output is identified as actual agent output', () => {
  const event: AgentWorkLabEvent = {
    schema: 'kungfu.agent-work-lab.event/v1',
    step: 'session-2',
    status: 'complete',
    root: `sha256:${'b'.repeat(64)}`,
    publicOutput: {
      schema: 'kungfu.agent-work-lab.public-output/v1',
      source: 'provider-stdout',
      admission: 'exact-agent-work-lab-marker',
      lines: [
        'Found the prior governed state and completed only the remaining step.',
      ],
      rawOutputRedacted: true,
    },
  };
  const lines = agentWorkLabPlaybackLines(event);

  assert.equal(lines[0]?.origin, 'provider-observation');
  assert.equal(lines[0]?.kind, 'agent');
  assert.match(lines[0]?.command ?? '', /completed only the remaining step/);
  assert.ok(
    lines.slice(1).every(({ origin }) => origin === 'canonical-projection'),
  );
});

test('the shell moves product navigation into the title-bar menu', () => {
  const source = readFileSync(
    new URL('./renderer/src/main.tsx', import.meta.url),
    'utf8',
  );
  const body = source.slice(
    source.indexOf('<ShellWorkspaceContent'),
    source.indexOf('<NotificationToasts'),
  );

  assert.match(source, /aria-label="Open product menu"/);
  assert.match(source, /aria-label="Kungfu product menu"/);
  assert.match(source, /title: 'All Work'/);
  assert.match(source, /id: 'current-project'/);
  assert.match(source, /title: currentProjectTitle/);
  assert.match(source, /title: 'All Projects'/);
  assert.match(source, /title: 'Agent Work Lab'/);
  assert.ok(body.length > 0);
  assert.doesNotMatch(body, /<ProductNavigation/);
});

test('the visual contract keeps a fixed frame with independently scrolling sessions', () => {
  const source = readFileSync(
    new URL('./renderer/src/agent-work-lab.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /aria-label="Test mode"/);
  assert.match(source, /aria-label="Session 1 agent"/);
  assert.match(source, /aria-label="Session 2 agent"/);
  assert.match(source, /<output[\s\S]*aria-label=\{meta\.label\}/);
  assert.match(source, /className="kf-lab-frame"/);
  assert.match(source, /gridTemplateRows: 'auto auto minmax\(0, 1fr\) auto'/);
  assert.match(source, /overflow: 'hidden'/);
  assert.match(source, /className="kf-lab-terminal-scroll"/);
  assert.match(source, /overflowY: 'auto'/);
  assert.match(
    source,
    /gridTemplateColumns: 'repeat\(2, minmax\(320px, 1fr\)\)'/,
  );
  assert.match(source, /kf-lab-report-dock/);
  assert.match(source, /Create Starter Project/);
  assert.match(source, /PREVIEW BEFORE CREATE/);
  assert.doesNotMatch(source, /Not now/);
  assert.match(source, /lab\.planStarterProject\(\)/);
  assert.match(source, /lab\.createStarterProject/);
  assert.match(source, /captured and remains pending explicit admission/);
  assert.match(source, /role="tooltip"/);
  assert.match(source, /WHAT TO TRY NEXT/);
  assert.match(source, /recommendationDurationMs/);
  assert.match(source, /createPortal/);
  assert.match(source, /position: fixed/);
  assert.match(source, /window\.innerWidth/);
  assert.match(source, /PUBLIC ACTIVITY TRANSCRIPT/);
  assert.match(source, /PRIVATE REASONING HIDDEN/);
  assert.match(source, /COMMANDS \+ RAW OUTPUT REDACTED/);
  assert.match(source, /agent\/live/);
  assert.match(source, /lab\.runDemo\(receiveEvent\)/);
  assert.match(source, /lab\.runAgent\(selectedAgent, receiveEvent\)/);
  assert.match(source, /setVisiblePlaybackLines/);
  assert.match(source, /agentWorkLabRunProgressLabel/);
  assert.match(source, /progress=\{progress\}/);
  assert.match(source, /kf-lab-verdict-focus/);
  assert.match(source, /prefers-reduced-motion: reduce/);
});

test('the GUI shell uses the shared startup surface policy', () => {
  const source = readFileSync(
    new URL('./renderer/src/main.tsx', import.meta.url),
    'utf8',
  );
  const projectsSource = readFileSync(
    new URL('./renderer/src/projects-panel/index.tsx', import.meta.url),
    'utf8',
  );
  const navigationSource = readFileSync(
    new URL('./renderer/src/product-navigation/index.tsx', import.meta.url),
    'utf8',
  );
  const mainSource = readFileSync(
    new URL('./main/index.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /agentWorkLabStartupSurface\(startup\)/);
  assert.match(source, /startupSurface === 'work-graph'/);
  assert.match(
    source,
    /const initialCoreWorkOpen =\s*!initialProjectsOpen && !agentFirst\.initialOpen/u,
  );
  assert.match(
    source,
    /const skipKfx =[\s\S]*initialProjectsOpen \|\| agentFirst\.initialOpen \|\| initialCoreWorkOpen[\s\S]*skipKfx[\s\S]*emptyKfxLoadResult\(\)[\s\S]*: loadKfx\(/,
  );
  assert.match(
    source,
    /initialShellSurface\(\{[\s\S]*onboardingOpen: agentFirst\.initialOpen,[\s\S]*projectsOpen: initialProjectsOpen,[\s\S]*focusedProjectPath: initialFocusedProjectPath/,
  );
  assert.match(source, /projectPath: initialFocusedProjectPath/);
  assert.match(
    source,
    /initialProjectsOpen &&[\s\S]*params\.projectPath\?\.trim\(\)/,
  );
  assert.match(
    source,
    /shouldOpenAgentWorkLab\(startupSurface, loaded\.entries\.length\)/,
  );
  assert.match(navigationSource, /shouldShowKungfuOnboarding/);
  assert.match(navigationSource, /AgentFirstOnboardingPanel/);
  assert.match(projectsSource, /WORKSPACE_SELECT_PATH_CHANNEL/);
  assert.match(source, /onOpenStarterProject/);
  assert.match(source, /onLabComplete/);
  assert.match(navigationSource, /finishKungfuOnboarding\(state/);
  assert.match(navigationSource, /\.then\(\(\) => openPath\(root\)\)/);
  assert.match(mainSource, /ipcMain\.handle\(WORKSPACE_SELECT_PATH_CHANNEL/);
  assert.match(mainSource, /transition: 'development-supervisor-restart'/);
  assert.match(mainSource, /transition: 'application-relaunch'/);
  assert.match(mainSource, /prepareDesktopWorkspaceEnvironmentForRelaunch/);
  assert.match(mainSource, /KUNGFU_GUI_DEV_USER_DATA/);
  assert.match(mainSource, /app\.setPath\('userData', developmentUserData\)/);
  assert.doesNotMatch(mainSource, /shellWindow\.webContents\.reload\(\)/);
  assert.match(mainSource, /realpathSync\(requestedPath\)/);
  assert.match(mainSource, /statSync\(workspaceRoot\)\.isDirectory\(\)/);
});

test('Projects and Work use the shared exact-plan Agent session surface', () => {
  const projects = readFileSync(
    new URL('./renderer/src/projects-panel/index.tsx', import.meta.url),
    'utf8',
  );
  const work = readFileSync(
    new URL(
      '../../../extensions/work-dashboard/src/view/index.tsx',
      import.meta.url,
    ),
    'utf8',
  );
  const runSurface = readFileSync(
    new URL('../../kfx/src/project-work-run.tsx', import.meta.url),
    'utf8',
  );

  assert.match(work, /ProjectWorkRunConfirmation/);
  assert.match(work, /ProjectWorkCloseConfirmation/);
  assert.match(work, /ProjectWorkReviewConfirmation/);
  assert.match(work, /ProjectWorkRunSession/);
  assert.match(work, /expectedPlanRoot/);
  assert.match(work, /Run Agent · \{agentProviderLabel\(agentProvider\)\}/);
  assert.match(work, /aria-label="Choose Agent"/);
  assert.match(work, /orderedProviders/);
  assert.match(work, /kungfu\.project-work\.last-agent-provider/);
  assert.match(work, /window\.localStorage\.setItem/);
  assert.doesNotMatch(work, /Run \{provider === 'opencode'/);
  assert.match(work, /projects\s*\.planReview\(run\.id\)/);
  assert.match(work, /projects\s*\.review\(/);
  assert.match(work, /projects\s*\.resumeRun\(/);
  assert.match(work, /projects\s*\.planClose\(/);
  assert.match(work, /projects\s*\.close\(/);
  assert.match(work, /Settle Work…/);
  assert.match(work, /Continue with new Work…/);
  assert.match(work, /COMPLETED · EVIDENCE RETAINED/);
  assert.match(work, /sessionPanelRef/);
  assert.match(work, /scrollIntoView/);
  assert.match(work, /openVisibleRun/);
  assert.match(work, /currentReviewableRun/);
  assert.match(work, /Review Agent result/);
  assert.match(runSurface, /plan\.blockedReason/);
  assert.match(runSurface, /Confirm independent review/);
  assert.match(runSurface, /fresh read-only process/);
  assert.match(runSurface, /Review changes/);
  assert.match(runSurface, /aria-label="Resize Agent session"/);
  assert.match(runSurface, /Fullscreen session view/);
  assert.match(runSurface, /setPointerCapture/);
  assert.match(runSurface, /background: '#20262e'/);
  assert.match(runSurface, /color: '#e6edf3'/);
  assert.match(projects, /Opening Project/);
  assert.match(projects, /onRestoreProject\(focusedPath, 'files'\)/);
  assert.match(projects, /forwardedProject\.current = focusedPath/);
  assert.match(projects, /Open Project…/);
  assert.match(projects, /New Project/);
  assert.match(projects, /Open Project/);
  assert.match(projects, /project\.workCount/);
  assert.match(projects, /project\.updatedAt/);
  assert.match(projects, /projects\.cachedCatalog/);
  assert.match(projects, /execFileInput:/);
  assert.match(projects, /stdio: \['pipe', 'pipe', 'pipe'\]/);
  assert.match(projects, /child\.stdin\.end\(input\)/);
  assert.doesNotMatch(projects, /Run Codex|Open Session|New Work/);
  assert.doesNotMatch(projects, /Remove from Kungfu|Remove from Projects/);
  assert.doesNotMatch(projects, /PROJECT OPENED/);
  assert.doesNotMatch(projects, /Import Existing|New Starter|Assignment/);
  assert.match(work, /All Work/);
  assert.match(work, /ProjectNavigation/);
  assert.match(work, /aria-expanded=\{section === 'work'\}/);
  assert.match(work, /aria-expanded=\{section === 'files'\}/);
  assert.match(work, /isProjectWorkSettled\(currentInventoryWork\)/);
  assert.match(
    work,
    /currentRetainedRun\?\.receipt\?\.status === 'agent-finished' &&[\s\S]*isProjectWorkReviewable\(currentInventoryWork\)/,
  );
  assert.match(
    work,
    /refreshProjectInventory\(\)[\s\S]*isProjectWorkSettled\(work\)[\s\S]*isProjectWorkReviewable\(work\)[\s\S]*projects\.planReview\(run\.id\)/,
  );
  assert.match(
    work,
    /section === 'work'[\s\S]*aria-label="Filter Project Work"[\s\S]*<ProjectWorkList[\s\S]*section === 'files'/,
  );
  assert.match(work, /background: selected \? '#04395e' : '#252526'/);
  assert.match(
    work,
    /<ProjectNavigation[\s\S]*works=\{visible\}[\s\S]*onSelectWork=\{selectWork\}/,
  );
  assert.match(work, /\{workDetail\}/);
  assert.match(work, /ProjectFilesView/);
  assert.match(
    work,
    /projects\.previewFile\(project\.path, selected\.relativePath\)/,
  );
  assert.match(work, /aria-label=\{`\$\{preview\.value\.name\} contents`\}/);
  assert.match(
    work,
    /Symbolic links cannot be previewed|supported UTF-8 text file/,
  );
  assert.match(work, /Loading retained Project Work/);
  assert.match(
    work,
    /requestedProject[\s\S]*\? !projectInventory \|\| !projectsCatalogReady[\s\S]*: !snapshot \|\| !projectsCatalogReady/,
  );
  assert.match(work, /Copy absolute path/);
  assert.match(work, /aria-label="Project menu"/);
  assert.match(work, /Remove from Projects…/);
  assert.match(work, /Confirm once more/);
  assert.match(work, /aria-label=\{`Create Work in \$\{project\.name\}`\}/);
  assert.match(work, /position: 'fixed'/);
  assert.match(work, /maxWidth: 'none'/);
  assert.match(work, /border: 'none'/);
  assert.match(work, /color: '#e6edf3'/);
  assert.match(work, /fontSize: 15/);
  assert.match(work, /projectSection/);
  assert.doesNotMatch(work, /Portfolio ·|connecting live Portfolio/);
});

test('renderer Projects sends the exact Work capture request through stdin', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let capturedInput = '';
  let capturedArgs: string[] = [];
  let stdoutListener: ((chunk: unknown) => void) | undefined;
  let closeListener: ((code: number | null) => void) | undefined;
  const captureResponse = {
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
  };
  const child = {
    stdin: {
      once: () => undefined,
      end: (input: string) => {
        capturedInput = input;
        queueMicrotask(() => {
          stdoutListener?.(JSON.stringify(captureResponse));
          closeListener?.(0);
        });
      },
    },
    stdout: {
      on: (_event: string, listener: (chunk: unknown) => void) => {
        stdoutListener = listener;
      },
    },
    stderr: { on: () => undefined },
    once: (event: string, listener: (value: Error | number | null) => void) => {
      if (event === 'close') {
        closeListener = listener as (code: number | null) => void;
      }
    },
    kill: () => undefined,
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      process: { env: {}, platform: 'darwin' },
      require: (specifier: string) => {
        if (specifier === 'node:child_process') {
          return {
            execFile: () => undefined,
            spawn: (_file: string, args: string[]) => {
              capturedArgs = args;
              return child;
            },
          };
        }
        if (specifier === 'electron') {
          return { ipcRenderer: { invoke: async () => undefined } };
        }
        throw new Error(`Unexpected renderer require: ${specifier}`);
      },
    },
  });

  try {
    const projects = openRendererProjects();
    const plan = projects.prepareWork(
      'Create a launch checklist',
      'The checklist has five verified steps',
    );
    const receipt = await projects.captureWork('/project', plan);

    assert.equal(receipt.status, 'captured');
    assert.deepEqual(capturedArgs, [
      'work',
      'capture',
      '--request',
      '-',
      '--workspace',
      '/project',
      '--json',
    ]);
    assert.deepEqual(JSON.parse(capturedInput), plan.request);
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
});

test('renderer Projects preserves structured CLI stdout on failure', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const diagnosis = JSON.stringify({
    schema: 'kungfu.assignment-orchestration.diagnosis/v1',
    ok: false,
    code: 'assignment-operation-failed',
    message: 'retained review state has conflicting fit reviews',
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      process: { env: {}, platform: 'darwin' },
      require: (specifier: string) => {
        if (specifier === 'node:child_process') {
          return {
            execFile: (
              _file: string,
              _args: string[],
              _options: unknown,
              callback: (
                error: Error | null,
                stdout: string,
                stderr: string,
              ) => void,
            ) => {
              queueMicrotask(() =>
                callback(new Error('Command failed'), diagnosis, ''),
              );
            },
            spawn: () => {
              throw new Error('spawn is not expected');
            },
          };
        }
        if (specifier === 'electron') {
          return { ipcRenderer: { invoke: async () => undefined } };
        }
        throw new Error(`Unexpected renderer require: ${specifier}`);
      },
    },
  });

  try {
    const projects = openRendererProjects();
    await assert.rejects(
      projects.works('/project'),
      /retained review state has conflicting fit reviews/,
    );
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
});

test('Project Work inventory keeps captured Work visible before admission', () => {
  const rows = projectInventoryWorkRows(
    {
      schema: 'kungfu.project-work.inventory/v1',
      projectPath: '/project',
      works: [
        {
          state: 'captured-pending-admission',
          initiativeId: 'initiative-example',
          assignmentId: 'assignment-example',
          title: 'Find two new commercial goals',
          objective: 'Find two new commercial goals',
          acceptanceChecks: ['Two goals are supported by evidence'],
          requestRoot: `sha256:${'1'.repeat(64)}`,
          receiptRoot: `sha256:${'2'.repeat(64)}`,
          requestPath: '/project/.kungfu/inbox/request.json',
        },
      ],
      activeWork: null,
      writeOccurred: false,
      inventoryRoot: `sha256:${'3'.repeat(64)}`,
    },
    {
      schema: 'kungfu.project/v1',
      id: 'project:example',
      name: 'project',
      path: '/project',
      available: true,
      selected: true,
      initialized: true,
      state: 'focused',
    },
  );

  assert.equal(rows[0]?.subject, 'kungfu:assignment-example');
  assert.equal(rows[0]?.display.status, 'captured');
  assert.deepEqual(rows[0]?.display.next_actions, [
    'Choose an Agent to admit and run this Work',
  ]);
  assert.equal(rows[0]?.observations[0]?.workspace_id, 'project:example');
});

test('Project Work selection follows the Assignment when admission changes its canonical root', () => {
  const captured = projectInventoryWorkRows(
    {
      schema: 'kungfu.project-work.inventory/v1',
      projectPath: '/project',
      works: [
        {
          state: 'captured-pending-admission',
          initiativeId: 'initiative-example',
          assignmentId: 'assignment-example',
          title: 'Find four new commercial goals',
          objective: 'Find four new commercial goals',
          acceptanceChecks: ['Four goals are supported by evidence'],
          requestRoot: `sha256:${'1'.repeat(64)}`,
          receiptRoot: `sha256:${'2'.repeat(64)}`,
          requestPath: '/project/.kungfu/inbox/request.json',
        },
      ],
      activeWork: null,
      writeOccurred: false,
      inventoryRoot: `sha256:${'3'.repeat(64)}`,
    },
    {
      schema: 'kungfu.project/v1',
      id: 'project:example',
      name: 'project',
      path: '/project',
      available: true,
      selected: true,
      initialized: true,
      state: 'focused',
    },
  )[0];
  assert.ok(captured);
  const admitted = {
    ...captured,
    canonical_root: `sha256:${'4'.repeat(64)}`,
    display: { ...captured.display, status: 'executing' },
  };

  assert.equal(
    resolveSelectedProjectWorkRow(
      [admitted],
      [admitted],
      captured.canonical_root,
      'assignment-example',
    ),
    admitted,
  );
});
