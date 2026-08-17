// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import test from 'node:test';
import { Box, Text, render } from 'ink';
import React from 'react';

import { AGENT_WORK_LAB_QUICK_COMMANDS } from './agent-work-lab-view.js';
import {
  CLOSED_CONTROL_PLANE,
  CONTROL_PLANE_CURSOR_BLINK_MS,
  ControlPlaneBar,
  ControlPlaneOverlay,
  type ControlPlaneState,
  type ProductSurface,
  QUICK_COMMANDS,
  contextualProjectRestoreCanCommit,
  createControlPlaneInputFence,
  directWorkspaceNavigationFromInput,
  projectWorkOwnsInput,
  quickCommandMatches,
  reduceControlPlaneInput,
  resolveProductStartupSurface,
  shouldStartContextualProjectRestore,
} from './profile-shell.js';
import {
  PROJECTS_QUICK_COMMANDS,
  PROJECT_WORK_QUICK_COMMANDS,
  projectWorkQuickCommandAvailable,
  selectVisibleProjectWorkRun,
} from './projects-view/index.js';
import {
  globalWorkContribution,
  globalWorkObserverArgs,
  loadLatestGlobalWorkCache,
  parseGlobalWorkObserverLine,
} from './work-control-contribution.js';

test('p opens Projects directly from an empty Project input prompt', () => {
  assert.equal(
    directWorkspaceNavigationFromInput(
      CLOSED_CONTROL_PLANE,
      'p',
      'project-work',
    ),
    'projects',
  );
  assert.equal(
    directWorkspaceNavigationFromInput(
      CLOSED_CONTROL_PLANE,
      'p',
      'project-assignment',
    ),
    'projects',
  );
  assert.equal(
    directWorkspaceNavigationFromInput(
      { ...CLOSED_CONTROL_PLANE, query: 'hel' },
      'p',
      'project-work',
    ),
    null,
  );
  assert.equal(
    directWorkspaceNavigationFromInput(
      { ...CLOSED_CONTROL_PLANE, focus: 'workspace' },
      'p',
      'project-work',
    ),
    null,
  );
});

test('Project Work owns the answer shortcut before the global input bar', () => {
  const workspace = { ...CLOSED_CONTROL_PLANE, focus: 'workspace' as const };

  assert.equal(projectWorkOwnsInput(workspace, 'i', 'project-work'), true);
  assert.equal(projectWorkOwnsInput(workspace, 'i', 'projects'), false);
  assert.equal(
    projectWorkOwnsInput(CLOSED_CONTROL_PLANE, 'i', 'project-work'),
    false,
  );
  assert.equal(projectWorkOwnsInput(workspace, 'j', 'project-work'), false);
});

const globalWorkSnapshot = {
  schema: 'kungfu.workspace-federation.query/v1' as const,
  observed_at: '2026-07-27T12:00:00Z',
  aggregate: {
    state: 'partial',
    component_count: 3,
    available_component_count: 2,
    unknown_component_count: 1,
  },
  verification: { ok: true },
  proof: { proof_root: 'sha256:proof' },
  global_work: {
    projection_root: 'sha256:projection',
    visible_work: [
      {
        canonical_root: 'sha256:initiative',
        object_kind: 'initiative',
        subject: 'initiative-a',
        display: { title: 'Improve search', status: 'active' },
        observations: [{ workspace_id: 'home' }],
      },
      {
        canonical_root: 'sha256:assignment',
        object_kind: 'assignment',
        subject: 'initiative-a:assignment-a',
        display: {
          title: 'Unify search',
          status: 'executing',
          next_actions: ['continue'],
        },
        observations: [{ workspace_id: 'project:a' }],
      },
      {
        canonical_root: 'sha256:completed',
        object_kind: 'assignment',
        subject: 'initiative-a:assignment-completed',
        display: {
          title: 'Completed Work',
          status: 'completed',
          portfolio_state: 'completed',
          next_actions: [],
        },
        observations: [{ workspace_id: 'project:a' }],
      },
    ],
  },
};

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function ContextualProjectRestoreHarness({
  selected,
  inventory,
  navigation,
}: {
  selected: Promise<void>;
  inventory: Promise<void>;
  navigation?: Promise<ProductSurface>;
}) {
  const [surface, setSurfaceState] = React.useState<ProductSurface>('loading');
  const startupSurface = React.useRef(surface).current;
  const surfaceRef = React.useRef(surface);
  const [loading, setLoading] = React.useState(false);
  const [restored, setRestored] = React.useState(false);
  const setSurface = React.useCallback((next: ProductSurface) => {
    surfaceRef.current = next;
    setSurfaceState(next);
  }, []);

  React.useEffect(() => {
    if (!navigation) return;
    void navigation.then(setSurface);
  }, [navigation, setSurface]);

  React.useEffect(() => {
    if (
      !shouldStartContextualProjectRestore({
        playbackMode: false,
        surface: startupSurface,
        emptyState: false,
        startupProjectRoot: '/tmp/project',
      })
    ) {
      return;
    }
    let active = true;
    setLoading(true);
    void selected
      .then(async () => {
        if (!active || !contextualProjectRestoreCanCommit(surfaceRef.current)) {
          return;
        }
        setSurface('project-work');
        await inventory;
        if (!active || surfaceRef.current !== 'project-work') return;
        setRestored(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [inventory, selected, setSurface, startupSurface]);

  return React.createElement(
    Text,
    null,
    `${surface}:${loading ? 'loading' : 'settled'}:${
      restored ? 'restored' : 'pending'
    }`,
  );
}

test('opens Help, slash commands, and product search from the focused input', () => {
  assert.equal(
    reduceControlPlaneInput(CLOSED_CONTROL_PLANE, '?', 0).state.mode,
    'help',
  );
  assert.deepEqual(
    reduceControlPlaneInput(CLOSED_CONTROL_PLANE, '/', QUICK_COMMANDS.length)
      .state,
    { mode: 'commands', focus: 'input', query: '/', selected: 0 },
  );
  assert.equal(
    reduceControlPlaneInput(CLOSED_CONTROL_PLANE, '\u000b', 0).state.mode,
    'search',
  );
  const typed = reduceControlPlaneInput(CLOSED_CONTROL_PLANE, 'hello', 0);
  assert.equal(typed.handled, true);
  assert.equal(typed.state.query, 'hello');
  assert.match(
    reduceControlPlaneInput(typed.state, '\r', 0).state.notice ?? '',
    /Free-form Agent conversation is coming soon/,
  );
});

test('Esc hands focus to workspace shortcuts and i returns to input', () => {
  const workspace = reduceControlPlaneInput(
    CLOSED_CONTROL_PLANE,
    '\u001b',
    0,
  ).state;
  assert.equal(workspace.focus, 'workspace');
  assert.equal(reduceControlPlaneInput(workspace, 'j', 0).handled, false);
  const focused = reduceControlPlaneInput(workspace, 'i', 0);
  assert.equal(focused.handled, true);
  assert.equal(focused.state.focus, 'input');
});

test('Help and commands return to the workspace focus that opened them', () => {
  const workspace = { ...CLOSED_CONTROL_PLANE, focus: 'workspace' as const };
  const help = reduceControlPlaneInput(workspace, '?', 0).state;
  assert.equal(help.mode, 'help');
  assert.equal(help.returnFocus, 'workspace');
  assert.deepEqual(reduceControlPlaneInput(help, '\u001b', 0).state, workspace);

  const commands = reduceControlPlaneInput(
    workspace,
    '/',
    QUICK_COMMANDS.length,
  ).state;
  assert.equal(commands.returnFocus, 'workspace');
  assert.deepEqual(
    reduceControlPlaneInput(commands, '\u001b', QUICK_COMMANDS.length).state,
    workspace,
  );
});

test('Help opened from text entry still returns to the input', () => {
  const help = reduceControlPlaneInput(CLOSED_CONTROL_PLANE, '?', 0).state;
  assert.equal(help.returnFocus, undefined);
  assert.deepEqual(
    reduceControlPlaneInput(help, '\u001b', 0).state,
    CLOSED_CONTROL_PLANE,
  );
});

test('Tab enters controls and requests one bounded focus move', () => {
  const update = reduceControlPlaneInput(CLOSED_CONTROL_PLANE, '\t', 0);
  assert.equal(update.handled, true);
  assert.equal(update.state.focus, 'workspace');
  assert.equal(update.workspaceNavigation, 'next-focus');

  const typed = reduceControlPlaneInput(CLOSED_CONTROL_PLANE, 'd', 0);
  assert.equal(typed.state.query, 'd');
  assert.equal(typed.workspaceNavigation, undefined);
});

test('edits input, selects results, activates, and returns without leaking keys', () => {
  const opened = reduceControlPlaneInput(
    CLOSED_CONTROL_PLANE,
    '/',
    QUICK_COMMANDS.length,
  ).state;
  const typed = reduceControlPlaneInput(
    opened,
    'wo',
    QUICK_COMMANDS.length,
  ).state;
  assert.equal(typed.query, '/wo');
  assert.deepEqual(
    quickCommandMatches(typed.query).map((row) => row.command),
    ['/work'],
  );
  assert.equal(reduceControlPlaneInput(typed, '\r', 1).activate, true);
  assert.equal(
    reduceControlPlaneInput(typed, '\u001b', 1).state.mode,
    'closed',
  );
});

test('keeps a closing key captured for the rest of its synchronous input emission', async () => {
  const input = new EventEmitter();
  let state: ControlPlaneState = {
    mode: 'help',
    focus: 'input',
    query: '',
    selected: 0,
  };
  const fence = createControlPlaneInputFence(
    () => state.mode !== 'closed' || state.focus === 'input',
  );
  let leaked = false;
  input.prependListener('data', (chunk: string) => {
    const update = reduceControlPlaneInput(state, chunk, 0);
    if (!update.handled) return;
    fence.captureCurrentEmission();
    state = update.state;
  });
  input.on('data', () => {
    leaked = !fence.isCaptured();
  });

  input.emit('data', '\u001b');
  assert.equal(state.mode, 'closed');
  assert.equal(leaked, false);
  await Promise.resolve();
  assert.equal(fence.isCaptured(), true);
  state = reduceControlPlaneInput(state, '\u001b', 0).state;
  assert.equal(fence.isCaptured(), false);
});

test('keeps quick commands bounded to declared product actions', () => {
  assert.deepEqual(
    QUICK_COMMANDS.map((row) => row.action),
    [
      'help',
      'search',
      'health',
      'new-work',
      'work',
      'projects',
      'lab',
      'onboarding',
      'home',
      'quit',
    ],
  );
  assert.equal(quickCommandMatches('/new')[0]?.action, 'new-work');
  assert.equal(quickCommandMatches('/onboarding')[0]?.action, 'onboarding');
  assert.equal(quickCommandMatches('/rm -rf').length, 0);
});

test('projects every machine Work row into product search documents', () => {
  const contribution = globalWorkContribution(globalWorkSnapshot);
  assert.deepEqual(
    contribution.searchDocuments.map((row) => row.title),
    ['Improve search', 'Unify search', 'Completed Work'],
  );
});

test('reads and parses the shared GUI or TUI global Work observer state', () => {
  const files: Record<string, string> = {
    gui: JSON.stringify({
      schema: 'kungfu.gui.global-work-observer/v2',
      query: globalWorkSnapshot,
    }),
    tui: JSON.stringify({
      schema: 'kungfu.gui.global-work-observer/v2',
      query: {
        ...globalWorkSnapshot,
        observed_at: '2026-07-27T13:00:00Z',
      },
    }),
  };
  assert.equal(
    loadLatestGlobalWorkCache(
      (candidate) => files[candidate] ?? '',
      ['gui', 'tui'],
    )?.observed_at,
    '2026-07-27T13:00:00Z',
  );
  const parsed = parseGlobalWorkObserverLine(
    JSON.stringify({
      schema: 'kungfu.gui.global-work-observer-event/v1',
      kind: 'snapshot',
      snapshot: globalWorkSnapshot,
    }),
  );
  assert.equal(
    parsed instanceof Error ? '' : parsed?.schema,
    globalWorkSnapshot.schema,
  );
  assert.match(
    (
      parseGlobalWorkObserverLine(
        JSON.stringify({
          schema: 'kungfu.gui.global-work-observer-event/v1',
          kind: 'error',
          error: 'observer stopped',
        }),
      ) as Error
    ).message,
    /observer stopped/,
  );
  assert.equal(parseGlobalWorkObserverLine('not json'), null);
});

test('source CLI fallback keeps the complete uv Python prefix before global Work observation', () => {
  const args = globalWorkObserverArgs('/tmp/global-work.json', [
    'run',
    '--project',
    '/checkout/framework/core',
    '--frozen',
    'python',
    '-m',
    'kungfu',
  ]);
  assert.deepEqual(args.slice(0, 9), [
    'run',
    '--project',
    '/checkout/framework/core',
    '--frozen',
    'python',
    '-m',
    'kungfu',
    'workspace',
    'work',
  ]);
  const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
  const observerStart = source.indexOf('return startGlobalWorkObserver({');
  const observerEnd = source.indexOf('  }, [applySnapshot', observerStart);
  assert.notEqual(observerStart, -1);
  assert.notEqual(observerEnd, -1);
  const observerCall = source.slice(observerStart, observerEnd);
  assert.match(observerCall, /bin: cli\.bin/);
  assert.match(observerCall, /argsPrefix: cli\.argsPrefix/);
  assert.match(observerCall, /env: cli\.env/);
  assert.doesNotMatch(observerCall, /paths\.bin|cliEnvironment\(\)/);
});

test('adds Suite actions only to the active Lab command catalog', () => {
  const labCommands = [...AGENT_WORK_LAB_QUICK_COMMANDS, ...QUICK_COMMANDS];
  assert.deepEqual(
    quickCommandMatches('/same', labCommands).map((row) => row.action),
    ['lab-same'],
  );
  assert.equal(quickCommandMatches('/same').length, 0);
  assert.deepEqual(
    AGENT_WORK_LAB_QUICK_COMMANDS.map((row) => row.command),
    ['/demo', '/same', '/handoff', '/report', '/new', '/focus'],
  );
});

test('adds Project actions only to the active Projects command catalog', () => {
  const projectCommands = [...PROJECTS_QUICK_COMMANDS, ...QUICK_COMMANDS];
  assert.deepEqual(
    projectCommands
      .slice(0, PROJECTS_QUICK_COMMANDS.length)
      .map((row) => row.command),
    ['/new', '/open', '/remove'],
  );
  assert.equal(
    quickCommandMatches('/new', projectCommands)[0]?.action,
    'project-new',
  );
});

test('gives /new a Work meaning inside an opened Project', () => {
  const projectWorkCommands = [
    ...PROJECT_WORK_QUICK_COMMANDS,
    ...QUICK_COMMANDS,
  ];
  assert.equal(
    quickCommandMatches('/new', projectWorkCommands)[0]?.action,
    'project-work-new',
  );
  assert.match(projectWorkCommands[0]?.summary ?? '', /acceptance criterion/);
});

test('keeps /new available after completed Project Work but not during active review', () => {
  assert.equal(
    projectWorkQuickCommandAvailable({
      surface: 'project-assignment',
      hasOpenedProject: true,
      completedWork: true,
    }),
    true,
  );
  assert.equal(
    projectWorkQuickCommandAvailable({
      surface: 'project-assignment',
      hasOpenedProject: true,
      completedWork: false,
    }),
    false,
  );
  assert.equal(
    projectWorkQuickCommandAvailable({
      surface: 'project-work',
      hasOpenedProject: true,
      completedWork: false,
    }),
    true,
  );
});

test('completed Project Work does not retain the previous Agent run as a new-Work blocker', () => {
  const retained = [{ id: 'old-run', workspace: '/tmp/project' }];
  assert.equal(
    selectVisibleProjectWorkRun(retained, '/tmp/project', false)?.id,
    'old-run',
  );
  assert.equal(
    selectVisibleProjectWorkRun(retained, '/tmp/project', true),
    null,
  );
});

test('startup opens only the current .kungfu Project and otherwise shows All Work', () => {
  assert.equal(
    resolveProductStartupSurface({
      contextualProject: true,
      openedProject: true,
      projectResumeSettled: true,
    }),
    'project-work',
  );
  assert.equal(
    resolveProductStartupSurface({
      contextualProject: true,
      openedProject: false,
      projectResumeSettled: false,
    }),
    null,
  );
  assert.equal(
    resolveProductStartupSurface({
      contextualProject: true,
      openedProject: false,
      projectResumeSettled: true,
    }),
    'all-work',
  );
  assert.equal(
    resolveProductStartupSurface({
      contextualProject: false,
      openedProject: true,
      projectResumeSettled: false,
    }),
    'all-work',
  );
});

test('explicit product navigation cancels contextual Project restoration', () => {
  const startup = {
    playbackMode: false,
    emptyState: false,
    startupProjectRoot: '/tmp/project',
  };
  assert.equal(
    shouldStartContextualProjectRestore({ ...startup, surface: 'loading' }),
    true,
  );
  for (const surface of ['lab', 'projects', 'all-work', 'onboarding']) {
    assert.equal(
      shouldStartContextualProjectRestore({ ...startup, surface }),
      false,
      `${surface} must not be replaced by a late Project restore`,
    );
    assert.equal(
      contextualProjectRestoreCanCommit(surface),
      false,
      `${surface} must revoke a pending restore before React rerenders`,
    );
  }
});

test('contextual Project restore survives its owned async surface transition', async () => {
  const output = new CaptureOutput();
  const selected = deferred<void>();
  const inventory = deferred<void>();
  const instance = render(
    React.createElement(ContextualProjectRestoreHarness, {
      selected: selected.promise,
      inventory: inventory.promise,
    }),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  selected.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(output.chunks.join(''), /project-work:loading:pending/);

  inventory.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const frame = output.chunks.join('');
  instance.unmount();
  instance.cleanup();

  assert.match(frame, /project-work:settled:restored/);
});

test('explicit navigation cancels async Project restore and settles loading', async () => {
  const output = new CaptureOutput();
  const selected = deferred<void>();
  const inventory = deferred<void>();
  const navigation = deferred<ProductSurface>();
  const instance = render(
    React.createElement(ContextualProjectRestoreHarness, {
      selected: selected.promise,
      inventory: inventory.promise,
      navigation: navigation.promise,
    }),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  navigation.resolve('projects');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(output.chunks.join(''), /projects:loading:pending/);

  selected.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const frame = output.chunks.join('');
  instance.unmount();
  instance.cleanup();

  assert.match(frame, /projects:settled:pending/);
  assert.doesNotMatch(frame, /project-work/);
});

test('the real Ink control plane covers the product canvas and keeps a fixed input bar', async () => {
  const output = new CaptureOutput();
  const dimensions = { columns: 80, rows: 24 };
  const instance = render(
    React.createElement(
      Box,
      { width: 80, height: 23, flexDirection: 'column' },
      React.createElement(Text, null, 'UNDERLYING PRODUCT CONTENT'),
      React.createElement(ControlPlaneOverlay, {
        dimensions: { columns: 80, rows: 22 },
        state: { mode: 'help', focus: 'input', query: '', selected: 0 },
        searchResults: [],
        quickCommands: QUICK_COMMANDS,
        catalogStatus: 'catalog ready',
      }),
      React.createElement(ControlPlaneBar, {
        dimensions,
        state: { mode: 'help', focus: 'input', query: '', selected: 0 },
        resultCount: 0,
      }),
    ),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const frame = output.chunks.join('');
  instance.unmount();
  instance.cleanup();
  assert.match(frame, /KUNGFU · HELP/);
  assert.match(frame, /focused input accepts text/);
  assert.match(frame, /Getting Started: \/onboarding/);
  assert.match(frame, /Help open/);
  assert.match(frame, /HELP.*Esc Back/s);
  assert.match(frame, /╭/);
  assert.match(frame, /╰/);
  assert.doesNotMatch(frame, /UNDERLYING PRODUCT CONTENT/);
});

test('the idle input is a focused full panel and renders typed text', async () => {
  const output = new CaptureOutput();
  const typed = reduceControlPlaneInput(
    CLOSED_CONTROL_PLANE,
    'continue work',
    0,
  ).state;
  const instance = render(
    React.createElement(
      Box,
      { width: 80, height: 23, flexDirection: 'column' },
      React.createElement(ControlPlaneBar, {
        dimensions: { columns: 80, rows: 24 },
        state: typed,
        resultCount: 0,
      }),
    ),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const frame = output.chunks.join('');
  instance.unmount();
  instance.cleanup();
  assert.match(frame, /continue work/);
  assert.match(frame, /VIEW CONTROLS/);
  assert.match(frame, /╭─ VIEW CONTROLS/u);
  assert.match(frame, /Esc Controls · \? Help/);
  assert.doesNotMatch(frame, /Kungfu/);
  assert.doesNotMatch(frame, /Type…/u);
  assert.match(frame, /╭/);
  assert.match(frame, /╰/);
});

test('the focused empty input blinks a cursor without placeholder copy', async () => {
  const output = new CaptureOutput();
  const instance = render(
    React.createElement(
      Box,
      { width: 80, height: 23, flexDirection: 'column' },
      React.createElement(ControlPlaneBar, {
        dimensions: { columns: 80, rows: 24 },
        state: CLOSED_CONTROL_PLANE,
        resultCount: 0,
      }),
    ),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const initialWriteCount = output.chunks.length;
  const initialFrame = output.chunks.join('');
  await new Promise<void>((resolve) =>
    setTimeout(resolve, CONTROL_PLANE_CURSOR_BLINK_MS + 80),
  );
  const blinkingWriteCount = output.chunks.length;
  instance.unmount();
  instance.cleanup();

  assert.match(initialFrame, /╭─ VIEW CONTROLS/u);
  assert.doesNotMatch(initialFrame, /Type…/u);
  assert.ok(blinkingWriteCount > initialWriteCount);
});

test('the idle bar makes Lab controls visually explicit', async () => {
  const output = new CaptureOutput();
  const instance = render(
    React.createElement(
      Box,
      { width: 80, height: 23, flexDirection: 'column' },
      React.createElement(ControlPlaneBar, {
        dimensions: { columns: 80, rows: 24 },
        state: { ...CLOSED_CONTROL_PLANE, focus: 'workspace' },
        resultCount: 0,
        controlsLabel: 'LAB CONTROLS',
        controlsHint: 'd Demo · x Same · m Handoff · Tab Focus',
      }),
    ),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const frame = output.chunks.join('');
  instance.unmount();
  instance.cleanup();

  assert.match(frame, /LAB CONTROLS/);
  assert.match(frame, /d Demo · x Same · m Handoff · Tab Focus/);
  assert.match(frame, /i Input/);
  assert.match(frame, /◇ Press i to type/);
});

test('a focused workspace modal does not tell the user to type a literal i', async () => {
  const output = new CaptureOutput();
  const instance = render(
    React.createElement(
      Box,
      { width: 80, height: 23, flexDirection: 'column' },
      React.createElement(ControlPlaneBar, {
        dimensions: { columns: 80, rows: 24 },
        state: { ...CLOSED_CONTROL_PLANE, focus: 'workspace' },
        resultCount: 0,
        controlsLabel: 'NEW WORK INPUT',
        controlsHint: 'Type in the focused panel · Enter Continue · Esc Cancel',
        workspaceInputActive: true,
      }),
    ),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const frame = output.chunks.join('');
  instance.unmount();
  instance.cleanup();

  assert.match(frame, /NEW WORK INPUT/);
  assert.match(frame, /Focused panel accepts text/);
  assert.doesNotMatch(frame, /i Input|Press i to type/);
});

test('search keeps the selected result visible beyond the first viewport', async () => {
  const output = new CaptureOutput();
  const searchResults = Array.from({ length: 12 }, (_, index) => ({
    id: `help.${index}`,
    kind: 'help' as const,
    title: `Help topic ${index}`,
    summary: `Summary ${index}`,
    action: { kind: 'show-help' as const, topicId: String(index) },
    score: 100 - index,
  }));
  const instance = render(
    React.createElement(
      Box,
      { width: 80, height: 11, flexDirection: 'column' },
      React.createElement(ControlPlaneOverlay, {
        dimensions: { columns: 80, rows: 12 },
        state: {
          mode: 'search',
          focus: 'input',
          query: 'help',
          selected: 11,
        },
        searchResults,
        quickCommands: QUICK_COMMANDS,
        catalogStatus: 'catalog ready',
      }),
    ),
    {
      stdout: output as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  const frame = output.chunks.join('');
  instance.unmount();
  instance.cleanup();
  assert.match(frame, /Help topic 11/);
  assert.doesNotMatch(frame, /Help topic 0/);
});
