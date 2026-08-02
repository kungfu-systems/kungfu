// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanupProjectTourTemporaryProject,
  playbackQuitRequested,
  projectTourTemporaryContainer,
} from './project-tour-lifecycle.js';

test('playback accepts q as a global exit key without matching other input', () => {
  assert.equal(playbackQuitRequested('q'), true);
  assert.equal(playbackQuitRequested(Buffer.from('Q')), true);
  assert.equal(playbackQuitRequested('quit'), false);
  assert.equal(playbackQuitRequested('\n'), false);
});

test('Project tour cleanup admits only its exact system-temporary container', () => {
  const destination =
    '/private/tmp/kungfu-project-tour-a1b2c3/my-first-kungfu-project';
  assert.equal(
    projectTourTemporaryContainer(destination, '/private/tmp'),
    '/private/tmp/kungfu-project-tour-a1b2c3',
  );
  assert.equal(
    projectTourTemporaryContainer(
      '/Users/example/kungfu-project-tour-a1b2c3/my-first-kungfu-project',
      '/private/tmp',
    ),
    null,
  );
  assert.equal(
    projectTourTemporaryContainer(
      '/private/tmp/kungfu-project-tour-a1b2c3/real-project',
      '/private/tmp',
    ),
    null,
  );
});

test('Project tour cleanup removes the admitted container and rejects other paths', () => {
  const removed: string[] = [];
  const destination =
    '/private/tmp/kungfu-project-tour-a1b2c3/my-first-kungfu-project';
  assert.equal(
    cleanupProjectTourTemporaryProject(destination, {
      systemTemporaryRoot: '/private/tmp',
      remove: (container) => removed.push(container),
    }),
    '/private/tmp/kungfu-project-tour-a1b2c3',
  );
  assert.deepEqual(removed, ['/private/tmp/kungfu-project-tour-a1b2c3']);
  assert.throws(
    () =>
      cleanupProjectTourTemporaryProject('/Users/example/Documents/project', {
        systemTemporaryRoot: '/private/tmp',
        remove: (container) => removed.push(container),
      }),
    /refusing to remove unrecognized Project tour path/u,
  );
  assert.equal(removed.length, 1);
});
