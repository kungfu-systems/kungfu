// SPDX-License-Identifier: Apache-2.0

// biome-ignore lint/suspicious/noRedundantUseStrict: this test executes as CommonJS
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  resolveSourceExtensionRoot,
  resolveSourceTuiEntry,
  sourceCliEnvironment,
} = require('../lib/kungfu-cli');

function installedTui(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-cli-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const provider = path.join(root, 'node_modules', '@kungfu-tech', 'tui');
  fs.mkdirSync(provider, { recursive: true });
  fs.writeFileSync(
    path.join(provider, 'package.json'),
    JSON.stringify({
      name: '@kungfu-tech/tui',
      exports: { './bundle': './public-bundle.mjs' },
    }),
  );
  const bundle = path.join(provider, 'public-bundle.mjs');
  fs.writeFileSync(bundle, 'export {};');
  return { coreLibDir: path.join(root, 'core', 'lib'), bundle };
}

test('source kungfu launcher resolves the declared TUI public bundle regardless of layout', (t) => {
  const { coreLibDir, bundle } = installedTui(t);
  let inspected = '';
  const entry = resolveSourceTuiEntry(coreLibDir, (candidate) => {
    inspected = candidate;
    return true;
  });

  assert.equal(entry, inspected);
  assert.equal(entry, bundle);
});

test('source kungfu launcher preserves an explicit TUI entry', () => {
  const env = sourceCliEnvironment(
    { KUNGFU_TUI_ENTRY: '/explicit/tui.mjs' },
    '/workspace/framework/core/lib',
    () => true,
  );

  assert.equal(env.KUNGFU_TUI_ENTRY, '/explicit/tui.mjs');
});

test('source kungfu launcher ignores a blank explicit TUI entry', (t) => {
  const { coreLibDir, bundle } = installedTui(t);
  const env = sourceCliEnvironment(
    { KUNGFU_TUI_ENTRY: '' },
    coreLibDir,
    () => true,
  );

  assert.equal(env.KUNGFU_TUI_ENTRY, bundle);
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
