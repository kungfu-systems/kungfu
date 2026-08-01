// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROJECT_TOUR_GUIDE_SCENES,
  PROJECT_TOUR_STORY_STEPS,
  projectTourGuidePanelLines,
  projectTourLayout,
  projectTourProtocolLine,
} from './starter-project-view/index.js';

test('Project recovery tour tells the complete user lifecycle without granting mock authority', () => {
  assert.equal(PROJECT_TOUR_STORY_STEPS.length, 7);
  assert.match(PROJECT_TOUR_STORY_STEPS[0], /Starter template/u);
  assert.match(PROJECT_TOUR_STORY_STEPS[1], /file tree/u);
  assert.match(PROJECT_TOUR_STORY_STEPS[2], /exit 75/u);
  assert.match(PROJECT_TOUR_STORY_STEPS[3], /exit 23/u);
  assert.match(PROJECT_TOUR_STORY_STEPS[5], /native Work authority/u);
  assert.match(PROJECT_TOUR_STORY_STEPS[6], /inventory/u);
});

test('Project tour guide explains failures, review, and settlement without impersonating events', () => {
  assert.equal(PROJECT_TOUR_GUIDE_SCENES.length, 10);
  const story = PROJECT_TOUR_GUIDE_SCENES.map(
    (scene) => `${scene.kicker} ${scene.title} ${scene.detail}`,
  ).join('\n');
  assert.match(story, /exit 75/u);
  assert.match(story, /exit 23/u);
  assert.match(story, /同一个 Work/u);
  assert.match(story, /独立审查/u);
  assert.match(story, /原生 Work authority/u);
  assert.doesNotMatch(story, /TOUR GUIDE.*agent ·/u);
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

test('Project tour reserves a useful lower event window at common terminal sizes', () => {
  const compact = projectTourLayout(24);
  const large = projectTourLayout(36);
  assert.ok(compact.visibleStreamRows >= 6);
  assert.ok(large.visibleStreamRows > compact.visibleStreamRows);
  assert.equal(
    compact.summaryRows + compact.streamRows + 3,
    compact.canvasRows,
  );
});

test('Project tour guide paints six complete opaque rows at 80 columns', () => {
  const lines = projectTourGuidePanelLines(PROJECT_TOUR_GUIDE_SCENES[7], 70);
  assert.equal(lines.length, 6);
  assert.equal(lines[0]?.length, 70);
  assert.equal(lines[4], ' '.repeat(70));
  assert.match(lines.join('\n'), /真实事件流已暂停/u);
});
