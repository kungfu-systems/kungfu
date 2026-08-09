// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeBuilderArgs,
  shouldForceMacPullRequestSigning,
} from './run-electron-builder.mjs';

test('electron-builder defaults to non-publishing mode in CI', () => {
  assert.deepEqual(normalizeBuilderArgs(['--dir'], '/tmp/electron'), [
    '--dir',
    '--publish=never',
    '--config.electronDist=/tmp/electron',
  ]);
});

test('electron-builder preserves an explicit publish mode', () => {
  assert.deepEqual(
    normalizeBuilderArgs(['--publish=always'], '/tmp/electron'),
    ['--publish=always', '--config.electronDist=/tmp/electron'],
  );
});

test('macOS signing is forced only for same-repository channel pull requests', () => {
  const request = {
    platform: 'darwin',
    eventName: 'pull_request',
    repository: 'kungfu-systems/kungfu',
    baseRef: 'alpha/v4/v4.0',
    event: {
      pull_request: {
        base: {
          ref: 'alpha/v4/v4.0',
          repo: { full_name: 'kungfu-systems/kungfu' },
        },
        head: { repo: { full_name: 'kungfu-systems/kungfu' } },
      },
    },
  };
  assert.equal(shouldForceMacPullRequestSigning(request), true);
  assert.equal(
    shouldForceMacPullRequestSigning({
      ...request,
      event: {
        pull_request: {
          ...request.event.pull_request,
          head: { repo: { full_name: 'untrusted/fork' } },
        },
      },
    }),
    false,
  );
  assert.equal(
    shouldForceMacPullRequestSigning({
      ...request,
      baseRef: 'dev/v4/v4.0',
      event: {
        pull_request: {
          ...request.event.pull_request,
          base: {
            ...request.event.pull_request.base,
            ref: 'dev/v4/v4.0',
          },
        },
      },
    }),
    false,
  );
});
