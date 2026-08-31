// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import test from 'node:test';
import { render } from 'ink';
import React from 'react';
import {
  PROJECT_TOUR_EPISODE_SCENE_IDS,
  PROJECT_TOUR_EPISODE_TWO_EVENT_SCALE,
  PROJECT_TOUR_EPISODE_TWO_FINAL_GUIDE_SCALE,
  PROJECT_TOUR_EPISODE_TWO_GUIDE_SCALE,
  PROJECT_TOUR_EPISODE_TWO_STANDALONE_SCENE,
  PROJECT_TOUR_GUIDE_SCENES,
  PROJECT_TOUR_PACING,
  PROJECT_TOUR_STORY_STEPS,
  PROJECT_TOUR_STREAM_TRANSITIONS,
  ProjectTourHeader,
  type ProjectTourLiveEvent,
  ProjectTourLiveStream,
  parseProjectTourEpisode,
  parseProjectTourLaunchOptions,
  parseProjectTourSpeed,
  projectTourActivityCells,
  projectTourActivityWidth,
  projectTourArtifactPreview,
  projectTourAudienceLine,
  projectTourEpisodeNarrationBudget,
  projectTourGuidePanelLines,
  projectTourLayout,
  projectTourPacingForSpeed,
  projectTourProtocolLine,
  projectTourReceiptText,
  projectTourSummaryMode,
  projectTourSummaryTitles,
  updateProjectTourStream,
} from './starter-project-view/index.js';

test('Project Work awaits the shared Agent Session before rendering', () => {
  const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
  const main = source.slice(source.indexOf('async function main()'));
  assert.match(
    main,
    /await openTuiAgentWorkLab\(Boolean\(projectTourRoot\)\)/u,
  );
  assert.ok(
    main.indexOf('await openTuiAgentWorkLab') <
      main.indexOf('const lifecycle = new TerminalLifecycle'),
  );
  const lab = source.slice(
    source.indexOf('async function openTuiAgentWorkLab'),
  );
  assert.match(
    lab,
    /const endpoint = await ensureTuiAgentSession\(paths\.runtimeDir\)/u,
  );
  assert.match(lab, /cli\.env\.KUNGFU_AGENT_SESSION_ENDPOINT = endpoint/u);
  assert.match(
    lab,
    /execFileEvents: async[\s\S]*?await ensureTuiAgentSession\(tuiAgentSessionRuntimeDir\)/u,
  );
  assert.match(lab, /bindTuiMockAgentEnvironment\(\{/u);
  assert.ok(
    lab.indexOf('bindTuiMockAgentEnvironment') <
      lab.indexOf('if (projectTour)'),
    'installed Mock Agent paths must be bound outside Project Tour mode',
  );
  assert.doesNotMatch(
    source,
    /KUNGFU_MOCK_AGENT_EXECUTABLE\s*=\s*process\.execPath/u,
  );
});

test('Project Tour delegates each episode to one controller without intermediate Work queries', () => {
  const source = readFileSync(
    new URL('./starter-project-view/index.tsx', import.meta.url),
    'utf8',
  );
  const view = source.slice(source.indexOf('export function ProjectTourView'));

  assert.match(view, /lab\.runProjectTourEpisode\(/u);
  assert.match(view, /report\.controller\.processCount !== 1/u);
  assert.match(view, /report\.controller\.inventoryQueryCount !== 1/u);
  assert.doesNotMatch(view, /projects\.works\(/u);
  assert.doesNotMatch(view, /lab\.planStarterWork\(/u);
  assert.doesNotMatch(view, /lab\.startStarterWork\(/u);
  assert.doesNotMatch(view, /lab\.planStarterReview\(/u);
  assert.doesNotMatch(view, /lab\.runStarterReview\(/u);
  assert.doesNotMatch(view, /lab\.planStarterClose\(/u);
  assert.doesNotMatch(view, /lab\.closeStarterWork\(/u);
});

test('Project tour launch options preserve defaults and validate explicit values', () => {
  assert.deepEqual(parseProjectTourLaunchOptions(['node', 'tui']), {
    root: undefined,
    speed: 1,
    episode: '1',
  });
  assert.deepEqual(
    parseProjectTourLaunchOptions([
      'node',
      'tui',
      '--project-work-tour-root',
      '/tmp/project',
      '--project-tour-speed',
      '0.5',
      '--project-tour-episode',
      '2',
    ]),
    { root: '/tmp/project', speed: 0.5, episode: '2' },
  );
  assert.throws(
    () => parseProjectTourLaunchOptions(['--project-tour-episode']),
    /requires 1, 2, or all/u,
  );
});

class CaptureOutput extends Writable {
  readonly isTTY = false;
  readonly chunks: string[] = [];

  constructor(
    readonly columns = 80,
    readonly rows = 24,
  ) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(String(chunk));
    callback();
  }
}

test('Project recovery tour tells the complete user lifecycle without granting mock authority', () => {
  assert.equal(PROJECT_TOUR_STORY_STEPS.length, 7);
  assert.match(PROJECT_TOUR_STORY_STEPS[0], /Starter template/u);
  assert.match(PROJECT_TOUR_STORY_STEPS[1], /file tree/u);
  assert.match(PROJECT_TOUR_STORY_STEPS[2], /exit 75/u);
  assert.match(PROJECT_TOUR_STORY_STEPS[3], /exit 23/u);
  assert.match(PROJECT_TOUR_STORY_STEPS[4], /launch-brief\.md/u);
  assert.match(PROJECT_TOUR_STORY_STEPS[5], /native Work authority/u);
  assert.match(PROJECT_TOUR_STORY_STEPS[6], /business outcome/u);
});

test('Project tour guide explains failures, review, and settlement without impersonating events', () => {
  assert.equal(PROJECT_TOUR_GUIDE_SCENES.length, 9);
  const story = PROJECT_TOUR_GUIDE_SCENES.map(
    (scene) => `${scene.kicker} ${scene.title} ${scene.detail}`,
  ).join('\n');
  assert.match(story, /exit 75/u);
  assert.match(story, /exit 23/u);
  assert.match(story, /same launch-brief Work/u);
  assert.match(story, /read-only Mock Reviewer/u);
  assert.match(story, /settlement receipt/u);
  assert.match(story, /Agent is mocked/u);
  assert.match(story, /file is evidence/u);
  assert.match(story, /The temporary Project is deleted/u);
  assert.match(story, /Session-first tools bind work to chat/u);
  assert.match(story, /Kungfu keeps Work outside it/u);
  assert.match(story, /Agents are replaceable/u);
  assert.match(story, /session is gone\. The Work is not/u);
  assert.match(story, /Work retains objective, checks, Attempt history/u);
  assert.match(story, /not chat reconstruction/u);
  assert.match(story, /does not silently retry/u);
  assert.match(story, /not universal business truth/u);
  assert.match(story, /\/new adds the next outcome/u);
  assert.match(
    story,
    /EPISODE 2 COMPLETE · REVIEWED, SETTLED, NEXT WORK READY/u,
  );
  assert.match(story, /EPISODE 1 COMPLETE · TWO FAILURES · ONE WORK/u);
  assert.match(story, /EPISODE 2 · RECOVER, REVIEW, AND SETTLE/u);
  assert.match(story, /Start from retained Work/u);
  assert.match(story, /Sessions were replaceable Attempts/u);
  assert.match(story, /Use \/new for the next outcome/u);
  assert.doesNotMatch(story, /deterministic/u);
  assert.doesNotMatch(story, /\p{Script=Han}/u);
  assert.doesNotMatch(story, /TOUR GUIDE.*agent ·/u);
  const standalone = Object.values(
    PROJECT_TOUR_EPISODE_TWO_STANDALONE_SCENE,
  ).join(' ');
  assert.match(standalone, /Episode 1 proved survival/u);
  assert.match(standalone, /real Starter Work/u);
  assert.match(standalone, /Agent exit, independent review, and settlement/u);
  assert.doesNotMatch(standalone, /failed Attempts remain/u);
  assert.doesNotMatch(standalone, /\p{Script=Han}/u);
});

test('Project tour episodes are independently selectable and stay below the default narration budget', () => {
  assert.deepEqual(PROJECT_TOUR_EPISODE_SCENE_IDS['1'], [
    'starter-project',
    'connection-loss',
    'connection-retained',
    'agent-crash',
    'same-work',
  ]);
  assert.deepEqual(PROJECT_TOUR_EPISODE_SCENE_IDS['2'], [
    'recovery',
    'independent-review',
    'native-settlement',
    'next-work',
  ]);
  assert.equal(parseProjectTourEpisode(undefined), '1');
  assert.equal(parseProjectTourEpisode('2'), '2');
  assert.equal(parseProjectTourEpisode('all'), 'all');
  assert.throws(() => parseProjectTourEpisode('3'), /must be 1, 2, or all/u);
  assert.ok(projectTourEpisodeNarrationBudget('1') < 90_000);
  assert.ok(projectTourEpisodeNarrationBudget('2') < 90_000);
  assert.ok(PROJECT_TOUR_EPISODE_TWO_EVENT_SCALE >= 0.5);
  assert.ok(PROJECT_TOUR_EPISODE_TWO_EVENT_SCALE < 1);
  assert.equal(PROJECT_TOUR_EPISODE_TWO_GUIDE_SCALE, 0.875);
  assert.equal(PROJECT_TOUR_EPISODE_TWO_FINAL_GUIDE_SCALE, 0.8);
});

test('Project tour summary windows reuse titles embedded in their borders', () => {
  assert.deepEqual(projectTourSummaryTitles('wide', false), [
    'FILES',
    'PROJECT WORK',
    'RETAINED WORK HISTORY',
  ]);
  assert.deepEqual(projectTourSummaryTitles('compact', false), [
    'FILES',
    'PROJECT WORK · RETAINED HISTORY',
  ]);
  assert.deepEqual(projectTourSummaryTitles('wide', true), [
    'FILES',
    'PROJECT WORK',
    'LAUNCH BRIEF · REVIEW EVIDENCE',
  ]);
});

test('Project tour pacing leaves time to read scenes and follow events', () => {
  assert.ok(PROJECT_TOUR_PACING.guideDwellMs >= 7500);
  assert.ok(PROJECT_TOUR_PACING.activityEventMs >= 850);
  assert.ok(PROJECT_TOUR_PACING.protocolEventMs >= 550);
  assert.ok(PROJECT_TOUR_PACING.summaryDwellMs >= 1500);
});

test('Project tour speed scales every presentation delay without changing the default', () => {
  assert.equal(parseProjectTourSpeed(undefined), 1);
  assert.equal(parseProjectTourSpeed('0.75'), 0.75);
  assert.equal(parseProjectTourSpeed('0.5'), 0.5);
  assert.equal(parseProjectTourSpeed('4'), 4);
  assert.deepEqual(projectTourPacingForSpeed(1), PROJECT_TOUR_PACING);
  assert.deepEqual(projectTourPacingForSpeed(0.5), {
    guideDwellMs: 16000,
    guideGapMs: 800,
    activityEventMs: 1800,
    protocolEventMs: 1200,
    summaryDwellMs: 3600,
    finalDwellMs: 6400,
  });
  assert.throws(() => parseProjectTourSpeed('0.1'), /between 0.25 and 4/u);
  assert.throws(() => parseProjectTourSpeed('fast'), /between 0.25 and 4/u);
});

test('Project tour keeps playback speed at the right edge of the top bar', async () => {
  const output = new CaptureOutput();
  const instance = render(
    React.createElement(ProjectTourHeader, {
      columns: 80,
      episode: '1',
      step: 2,
      projectName: 'my-first-kungfu-project',
      playbackSpeed: 0.5,
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
  const middle = rendered.split('\n')[1] ?? '';
  assert.match(middle, /EPISODE 1\/2 · STEP 3\/4/u);
  assert.match(middle, /SPEED 0\.5×\s*│$/u);
});

test('Project tour event stream projects exact admitted Mock Agent language', () => {
  const event = {
    schema: 'kungfu.work-start.event/v1' as const,
    index: 7,
    stage: 'run',
    status: 'running',
    text: 'public wrapper text',
    root: null,
    activity: {
      kind: 'agent' as const,
      phase: 'progress',
      text: 'I am inspecting the retained project evidence.',
    },
  };
  assert.deepEqual(
    projectTourProtocolLine(event, 'MOCK AGENT · ATTEMPT 1', 'A1', 3),
    {
      id: 3,
      section: 'MOCK AGENT · ATTEMPT 1',
      sectionTag: 'A1',
      index: 7,
      source: 'agent',
      status: 'running',
      text: 'I am inspecting the retained project evidence.',
    },
  );
});

test('Project tour audience projection keeps story and authority events while hiding markers', () => {
  const setup = projectTourAudienceLine(
    {
      schema: 'kungfu.work-start.event/v1',
      index: 2,
      stage: 'admit',
      status: 'running',
      text: 'Minting a bounded Agent execution lease.',
      root: null,
    },
    'MOCK AGENT · ATTEMPT 1',
    'A1',
    1,
  );
  const agent = projectTourAudienceLine(
    {
      schema: 'kungfu.work-start.event/v1',
      index: 7,
      stage: 'run',
      status: 'running',
      text: 'wrapper',
      root: null,
      activity: {
        kind: 'agent',
        phase: 'progress',
        text: 'agent · I recovered the objective without prior chat.',
      },
    },
    'MOCK AGENT · ATTEMPT 2',
    'A2',
    2,
  );
  const marker = projectTourAudienceLine(
    {
      schema: 'kungfu.work-review.event/v1',
      index: 8,
      stage: 'review',
      status: 'running',
      text: 'wrapper',
      root: null,
      activity: {
        schema: 'kungfu.agent-run.activity/v1',
        kind: 'agent',
        phase: 'progress',
        text: 'KUNGFU_REVIEW_RESULT {"verdict":"fit"}',
        rawToolArgumentsExposed: false,
      },
    },
    'INDEPENDENT REVIEW',
    'REV',
    3,
  );
  const tool = projectTourAudienceLine(
    {
      schema: 'kungfu.work-review.event/v1',
      index: 6,
      stage: 'review',
      status: 'running',
      text: 'wrapper',
      root: null,
      activity: {
        schema: 'kungfu.agent-run.activity/v1',
        kind: 'agent',
        phase: 'progress',
        text: 'tool · read deliverables/launch-brief.md',
        rawToolArgumentsExposed: false,
      },
    },
    'INDEPENDENT REVIEW',
    'REV',
    4,
  );

  assert.equal(setup?.text, 'Minting a bounded Agent execution lease.');
  assert.equal(marker, null);
  assert.equal(agent?.text, 'I recovered the objective without prior chat.');
  assert.equal(tool?.source, 'tool');
  assert.equal(tool?.text, 'Read deliverables/launch-brief.md');
});

test('Project tour shows actual launch evidence and a completed settlement receipt', () => {
  const preview = projectTourArtifactPreview(`
# Northstar Notes launch brief
## Who it is for
Small product teams coordinating launches.
## Why it matters
Teams lose context when work continues from chat alone.
## Open questions
- Public release date
- Pricing
- Supported integrations
`);
  assert.deepEqual(preview, [
    'FILE · Northstar Notes launch brief',
    'Small product teams coordinating launches.',
    'Teams lose context when work continues from chat alone.',
    'OPEN · Public release date · Pricing · Supported integrations',
  ]);
  assert.equal(
    projectTourReceiptText({
      schema: 'kungfu.work-close.receipt/v1',
      ok: true,
      status: 'completed',
      planRoot: 'sha256:plan',
      workPhase: 'continuation-decided',
      receiptRoot: 'sha256:receipt',
      nextActions: [],
      writeOccurred: true,
    }),
    'Settlement receipt recorded · Work completed · sha256:receipt',
  );
});

test('Project tour starts each execution boundary with a fresh lower stream', () => {
  const prior = projectTourProtocolLine(
    {
      schema: 'kungfu.work-start.event/v1' as const,
      index: 9,
      stage: 'run',
      status: 'failed',
      text: 'The prior Attempt lost its transport connection.',
      root: null,
    },
    'MOCK AGENT · ATTEMPT 1',
    'A1',
    9,
  );
  const boundary = {
    id: 10,
    section: 'MOCK AGENT · ATTEMPT 2',
    sectionTag: 'A2',
    index: null,
    source: 'kungfu' as const,
    status: 'running',
    text: PROJECT_TOUR_STREAM_TRANSITIONS.A2,
  };

  assert.deepEqual(updateProjectTourStream([prior], boundary, 'begin'), [
    boundary,
  ]);
  assert.match(boundary.text, /A1 KEPT ABOVE · SAME LAUNCH-BRIEF WORK/u);
});

test('Project tour appends admitted events inside the current stream only', () => {
  const boundary = {
    id: 20,
    section: 'INDEPENDENT REVIEW',
    sectionTag: 'REV',
    index: null,
    source: 'kungfu' as const,
    status: 'running',
    text: PROJECT_TOUR_STREAM_TRANSITIONS.REV,
  };
  const reviewEvent = projectTourProtocolLine(
    {
      schema: 'kungfu.work-review.event/v1' as const,
      index: 1,
      stage: 'review',
      status: 'running',
      text: 'The reviewer is checking the retained deliverable.',
      root: null,
    },
    'INDEPENDENT REVIEW',
    'REV',
    21,
  );

  assert.deepEqual(updateProjectTourStream([boundary], reviewEvent, 'append'), [
    boundary,
    reviewEvent,
  ]);
  assert.match(boundary.text, /FRESH MOCK REVIEWER.*READ-ONLY/u);
  assert.match(
    PROJECT_TOUR_STREAM_TRANSITIONS.SET,
    /PASSING REVIEW KEPT ABOVE/u,
  );
});

test('Project tour reserves a useful lower event window at common terminal sizes', () => {
  const compact = projectTourLayout(24);
  const large = projectTourLayout(36);
  assert.ok(compact.visibleStreamRows >= 6);
  assert.ok(large.visibleStreamRows > compact.visibleStreamRows);
  assert.equal(
    compact.summaryRows + compact.streamRows + 3,
    compact.canvasRows,
  );
  assert.equal(projectTourSummaryMode(80), 'compact');
  assert.equal(projectTourSummaryMode(120), 'wide');
});

test('Project tour reuses the Work nebula as a bounded one-line activity signal', () => {
  const heading = 'AGENT EVENT STREAM · MOCK AGENT · ATTEMPT 2';
  assert.equal(projectTourActivityWidth(76, heading), 32);
  assert.equal(projectTourActivityWidth(48, heading), 0);
  const first = projectTourActivityCells(0, 32);
  const later = projectTourActivityCells(24, 32);
  assert.equal(first.length, 32);
  assert.equal(later.length, 32);
  assert.notDeepEqual(first, later);
  assert.ok(first.some((cell) => cell.glyph !== ' '));
  assert.ok(later.some((cell) => cell.glyph !== ' '));
});

test('Project tour guide paints six complete opaque rows at 80 columns', () => {
  for (const scene of PROJECT_TOUR_GUIDE_SCENES) {
    const lines = projectTourGuidePanelLines(scene, 70);
    assert.equal(lines.length, 6);
    assert.ok(lines.every((line) => line.length === 70));
    assert.equal(lines[0]?.trimEnd(), `TOUR GUIDE · ${scene.kicker}`);
    assert.equal(lines[1]?.trimEnd(), scene.title);
    assert.equal(
      lines.slice(2, 4).join(' ').replace(/\s+/gu, ' ').trim(),
      scene.detail,
    );
    assert.equal(lines[4], ' '.repeat(70));
    assert.match(lines.join('\n'), /LIVE EVENT STREAM PAUSED/u);
    assert.doesNotMatch(lines.join('\n'), /\p{Script=Han}/u);
  }
});

type LiveLine = { id: number; status: string; text: string };

function liveStreamFixture() {
  let sequence = 0;
  let now = 0;
  let timer: (() => void) | undefined;
  const lines: LiveLine[] = [];
  const waits: Array<() => void> = [];
  const stream = new ProjectTourLiveStream<LiveLine>({
    active: () => true,
    nextId: () => ++sequence,
    project: (event, id) => ({ id, status: event.status, text: event.text }),
    operationLine: (id, status, text) => ({ id, status, text }),
    append: (line) => lines.push(line),
    replace: (line) => {
      const index = lines.findIndex((candidate) => candidate.id === line.id);
      if (index >= 0) lines[index] = line;
    },
    delay: () => new Promise<void>((resolve) => waits.push(resolve)),
    activityDelayMs: 900,
    protocolDelayMs: 600,
    clock: {
      now: () => now,
      repeat: (callback) => {
        timer = callback;
        return callback;
      },
      cancel: (handle) => {
        if (timer === handle) timer = undefined;
      },
    },
  });
  return {
    lines,
    stream,
    waits,
    advance(milliseconds: number) {
      now += milliseconds;
      timer?.();
    },
  };
}

function liveEvent(index: number, text: string): ProjectTourLiveEvent {
  return {
    schema: 'kungfu.work-start.event/v1',
    index,
    stage: 'run',
    status: 'started',
    text,
    root: null,
  };
}

test('Project Tour shows truthful elapsed progress while an operation is pending', async () => {
  const { advance, lines, stream } = liveStreamFixture();
  let finish!: (value: string) => void;
  const operation = new Promise<string>((resolve) => {
    finish = resolve;
  });

  const pending = stream.during(
    'Checking the Mock Agent launch plan',
    () => operation,
  );
  await Promise.resolve();
  await Promise.resolve();
  advance(2_100);
  assert.equal(
    lines[0]?.text,
    'Checking the Mock Agent launch plan · 2s elapsed',
  );

  finish('qualified');
  assert.equal(await pending, 'qualified');
  assert.deepEqual(lines[0], {
    id: 1,
    status: 'completed',
    text: 'Checking the Mock Agent launch plan · complete',
  });
});

test('Project Tour streams source-ordered events once and retains failures', async () => {
  const { lines, stream, waits } = liveStreamFixture();
  const first = liveEvent(1, 'Starting the Mock Agent.');
  stream.push(first);
  stream.push(first);
  stream.push(liveEvent(2, 'Minting the execution lease.'));
  await Promise.resolve();
  assert.deepEqual(
    lines.map((line) => line.text),
    ['Starting the Mock Agent.'],
  );

  waits.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    lines.map((line) => line.text),
    ['Starting the Mock Agent.', 'Minting the execution lease.'],
  );
  waits.shift()?.();
  await stream.flush();

  await assert.rejects(
    stream.during('Checking independent review', async () => {
      throw new Error('native review failed closed');
    }),
    /native review failed closed/u,
  );
  assert.equal(lines.at(-1)?.status, 'failed');
  assert.equal(lines.at(-1)?.text, 'Checking independent review · failed');
});
