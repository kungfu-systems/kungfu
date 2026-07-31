// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import test from 'node:test';
import { Box, render } from 'ink';
import React from 'react';

import {
  ProjectPathCopyOverlay,
  projectNavigationTabAtPoint,
  projectNavigationTabLabels,
  projectPathCopyNotice,
  projectWorkAmbientRows,
} from './project-files-view/index.js';

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

test('Project navigation renders Files then Work as one bounded tab row', () => {
  const labels = projectNavigationTabLabels({
    navigationWidth: 22,
    workCount: 7,
  });

  assert.equal(`${labels.files}${labels.work}`.length, 18);
  assert.match(labels.work, /Work 7/);
  assert.match(labels.files, /Files/);
  assert.doesNotMatch(`${labels.files}${labels.work}`, /PROJECT/);
});

test('Project navigation pointer distinguishes the two side-by-side tabs', () => {
  assert.equal(
    projectNavigationTabAtPoint({
      column: 4,
      row: 6,
      topOffset: 5,
      navigationWidth: 22,
    }),
    'files',
  );
  assert.equal(
    projectNavigationTabAtPoint({
      column: 14,
      row: 6,
      topOffset: 5,
      navigationWidth: 22,
    }),
    'work',
  );
  assert.equal(
    projectNavigationTabAtPoint({
      column: 14,
      row: 7,
      topOffset: 5,
      navigationWidth: 22,
    }),
    null,
  );
});

test('Project Work navigation uses a distinct animated empty nebula', () => {
  const source = readFileSync(
    new URL('./project-files-view/index.tsx', import.meta.url),
    'utf8',
  );
  const navigation = source.slice(
    source.indexOf('export function ProjectFileTreeNavigation'),
    source.indexOf('export function ProjectFilesHost'),
  );

  assert.match(navigation, /KUNGFU_EMPTY_WORK_NAV_NEBULA_PATTERN/);
  assert.match(navigation, /KUNGFU_PROJECT_DISCOVERY_PATTERN/);
  assert.match(navigation, /onCopyNotice\(projectPathCopyNotice/);
  assert.doesNotMatch(navigation, /animate=\{false\}/);
});

test('Project navigation and main Work share one ambient center height', () => {
  assert.equal(projectWorkAmbientRows({ columns: 80, rows: 24 }), 11);
  assert.equal(projectWorkAmbientRows({ columns: 160, rows: 48 }), 35);
});

test('copying a Project file produces an opaque page-level confirmation overlay', async () => {
  const notice = projectPathCopyNotice(
    '/Users/dkr/Documents/Kungfu/agent-work-starter-4/AGENTS.md',
    { ok: true, method: 'pbcopy' },
  );
  assert.deepEqual(notice, {
    path: '/Users/dkr/Documents/Kungfu/agent-work-starter-4/AGENTS.md',
    ok: true,
    detail: 'Copied with pbcopy.',
  });

  const output = new CaptureOutput();
  const instance = render(
    React.createElement(
      Box,
      { width: 80, height: 23, position: 'relative' },
      React.createElement(ProjectPathCopyOverlay, {
        notice,
        dimensions: { columns: 80, rows: 24 },
      }),
    ),
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
  assert.match(rendered, /FILE PATH COPIED/);
  assert.match(rendered, /agent-work-starter-4\/AGENTS\.md/);
  assert.match(rendered, /Copied with pbcopy\./);
  assert.match(rendered, /closes in 3\.5 seconds/);
});
