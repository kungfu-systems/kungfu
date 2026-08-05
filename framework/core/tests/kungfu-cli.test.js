// SPDX-License-Identifier: Apache-2.0

// biome-ignore lint/suspicious/noRedundantUseStrict: this test executes as CommonJS
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  resolveSourceExtensionRoot,
  resolveSourceTuiEntry,
  sourceCliEnvironment,
} = require('../lib/kungfu-cli');

test('source kungfu launcher resolves the sibling built TUI bundle', () => {
  const coreLibDir = path.join('workspace', 'framework', 'core', 'lib');
  let inspected = '';
  const entry = resolveSourceTuiEntry(coreLibDir, (candidate) => {
    inspected = candidate;
    return true;
  });

  assert.equal(entry, inspected);
  assert.equal(
    entry?.endsWith(path.join('framework', 'tui', 'dist', 'tui.mjs')),
    true,
  );
});

test('source kungfu launcher preserves an explicit TUI entry', () => {
  const env = sourceCliEnvironment(
    { KUNGFU_TUI_ENTRY: '/explicit/tui.mjs' },
    '/workspace/framework/core/lib',
    () => true,
  );

  assert.equal(env.KUNGFU_TUI_ENTRY, '/explicit/tui.mjs');
});

test('source kungfu launcher ignores a blank explicit TUI entry', () => {
  const env = sourceCliEnvironment(
    { KUNGFU_TUI_ENTRY: '' },
    '/workspace/framework/core/lib',
    () => true,
  );

  assert.equal(
    env.KUNGFU_TUI_ENTRY,
    path.resolve('/workspace/framework/tui/dist/tui.mjs'),
  );
});

test('source kungfu launcher does not invent an unbuilt TUI entry', () => {
  const env = sourceCliEnvironment(
    {},
    '/workspace/framework/core/lib',
    () => false,
  );

  assert.equal(env.KUNGFU_TUI_ENTRY, undefined);
});

test('source kungfu launcher resolves assembled Product extensions', () => {
  const inspected = [];
  const root = resolveSourceExtensionRoot(
    '/workspace/framework/core/lib',
    (candidate) => {
      inspected.push(candidate);
      return candidate.includes(
        path.join('product', 'extensions', 'agent-work-lab'),
      );
    },
  );

  assert.equal(root, path.resolve('/workspace/product/extensions'));
  assert.equal(inspected.length, 1);
});

test('source kungfu launcher preserves an explicit extension root', () => {
  const env = sourceCliEnvironment(
    { KF_BUNDLED_EXTENSION_ROOT: '/explicit/extensions' },
    '/workspace/framework/core/lib',
    () => true,
  );

  assert.equal(env.KF_BUNDLED_EXTENSION_ROOT, '/explicit/extensions');
});

test('source kungfu launcher does not invent an unavailable extension root', () => {
  const env = sourceCliEnvironment(
    {},
    '/workspace/framework/core/lib',
    () => false,
  );

  assert.equal(env.KF_BUNDLED_EXTENSION_ROOT, undefined);
});
