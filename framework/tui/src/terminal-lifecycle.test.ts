// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  ENTER_ALTERNATE_SCREEN,
  HIDE_CURSOR,
  LEAVE_ALTERNATE_SCREEN,
  SHOW_CURSOR,
  type TerminalInput,
  TerminalLifecycle,
  type TerminalOutput,
  decodeTerminalMouseInput,
  existingProjectWorkspaceRoot,
  resolveTuiCoreDir,
  resolveTuiProductPaths,
  tuiChildCliEnvironment,
} from './terminal-lifecycle.js';

test('child CLI retains the packaged KFX root without recursive libnode selection', () => {
  const parent = {
    KUNGFU_AS_VARIANT: 'node',
    KUNGFU_DIR: '/product/runtime',
    KUNGFU_KFX_CONTRACT: '/product/runtime/config/kungfu-kfx.contract.json',
    KF_BUNDLED_EXTENSION_ROOT: '/product/extensions',
  };

  const child = tuiChildCliEnvironment(parent);

  assert.equal(child.KUNGFU_AS_VARIANT, undefined);
  assert.equal(child.KUNGFU_DIR, undefined);
  assert.equal(child.KUNGFU_KFX_CONTRACT, undefined);
  assert.equal(child.KF_BUNDLED_EXTENSION_ROOT, '/product/extensions');
  assert.equal(parent.KUNGFU_AS_VARIANT, 'node');
});

class FakeOutput extends EventEmitter implements TerminalOutput {
  isTTY = true;
  columns = 120;
  rows = 36;
  writes: string[] = [];
  write(value: string) {
    this.writes.push(value);
    return true;
  }
}

test('existing Project discovery requires a real .kungfu directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-tui-project-'));
  try {
    const project = path.join(root, 'project');
    const nested = path.join(project, 'nested');
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(
      existingProjectWorkspaceRoot(nested, { HOME: root }),
      undefined,
    );
    fs.mkdirSync(path.join(project, '.kungfu'));
    assert.equal(
      existingProjectWorkspaceRoot(nested, { HOME: root }),
      fs.realpathSync(project),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('packaged runtime resolution does not require the source core package', () => {
  let sourceResolutionCalled = false;
  assert.equal(
    resolveTuiCoreDir({
      env: { KUNGFU_DIR: '/opt/kungfu/product/runtime' },
      resolveCorePackage: () => {
        sourceResolutionCalled = true;
        throw new Error('source package is not installed');
      },
    }),
    path.resolve('/opt/kungfu/product'),
  );
  assert.equal(sourceResolutionCalled, false);
});

test('source runtime resolution keeps the workspace package fallback', () => {
  assert.equal(
    resolveTuiCoreDir({
      env: {},
      resolveCorePackage: () => '/workspace/framework/core/package.json',
    }),
    '/workspace/framework/core',
  );
});

test('source TUI can name the exact Core project independently of the loaded binding', () => {
  const resolved = resolveTuiProductPaths({
    env: {
      KUNGFU_DIR: '/build/Release',
      KUNGFU_TUI_SOURCE_CORE_DIR: '/repo/framework/core',
    },
    resolveCorePackageJson: () => '/unused/package.json',
  });

  assert.equal(resolved.coreDir, '/repo/framework/core');
  assert.equal(resolved.kungfuDir, '/build/Release');
  assert.equal(resolved.packagedBin, '/build/Release/kungfu');
});

test('owns alternate screen, raw mode, resize, and idempotent restoration', () => {
  const output = new FakeOutput();
  const signals = new EventEmitter();
  const raw: boolean[] = [];
  const flow: string[] = [];
  const input: TerminalInput = {
    isTTY: true,
    isRaw: false,
    readableFlowing: null,
    setRawMode: (enabled) => raw.push(enabled),
    resume: () => flow.push('resume'),
    pause: () => flow.push('pause'),
  };
  const sizes: Array<{ columns: number; rows: number }> = [];
  const exits: Array<NodeJS.Signals | undefined> = [];
  const lifecycle = new TerminalLifecycle(input, output, signals);
  lifecycle.start({
    onExit: (signal) => {
      exits.push(signal);
      output.write('INK-UNMOUNTED');
    },
    onResize: (size) => sizes.push(size),
  });
  output.columns = 80;
  output.rows = 24;
  output.emit('resize');
  signals.emit('SIGTERM');
  lifecycle.restore();

  assert.deepEqual(output.writes, [
    `${ENTER_ALTERNATE_SCREEN}${HIDE_CURSOR}${ENABLE_MOUSE_TRACKING}`,
    'INK-UNMOUNTED',
    `${DISABLE_MOUSE_TRACKING}${SHOW_CURSOR}${LEAVE_ALTERNATE_SCREEN}`,
  ]);
  assert.deepEqual(raw, [true, false]);
  assert.deepEqual(flow, ['resume', 'pause']);
  assert.deepEqual(sizes, [{ columns: 80, rows: 24 }]);
  assert.deepEqual(exits, ['SIGTERM']);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(output.listenerCount('resize'), 0);
});

test('rejects non-TTY activation before changing terminal state', () => {
  const output = new FakeOutput();
  const lifecycle = new TerminalLifecycle(
    { isTTY: false },
    output,
    new EventEmitter(),
  );
  assert.throws(
    () =>
      lifecycle.start({ onExit: () => undefined, onResize: () => undefined }),
    /interactive terminal required/,
  );
  assert.deepEqual(output.writes, []);
});

test('restores terminal state when the wrapped task throws', async () => {
  const output = new FakeOutput();
  const raw: boolean[] = [];
  const lifecycle = new TerminalLifecycle(
    { isTTY: true, isRaw: false, setRawMode: (enabled) => raw.push(enabled) },
    output,
    new EventEmitter(),
  );
  await assert.rejects(
    lifecycle.run(
      { onExit: () => undefined, onResize: () => undefined },
      async () => {
        throw new Error('fixture boot failure');
      },
    ),
    /fixture boot failure/,
  );
  assert.deepEqual(raw, [true, false]);
  assert.equal(
    output.writes.at(-1),
    `${DISABLE_MOUSE_TRACKING}${SHOW_CURSOR}${LEAVE_ALTERNATE_SCREEN}`,
  );
});

test('restores alternate screen and input after partial startup failure', async () => {
  const output = new FakeOutput();
  const raw: boolean[] = [];
  const lifecycle = new TerminalLifecycle(
    {
      isTTY: true,
      isRaw: false,
      setRawMode: (enabled) => {
        raw.push(enabled);
        if (enabled) throw new Error('raw startup failure');
      },
    },
    output,
    new EventEmitter(),
  );
  await assert.rejects(
    lifecycle.run(
      { onExit: () => undefined, onResize: () => undefined },
      async () => undefined,
    ),
    /raw startup failure/,
  );
  assert.deepEqual(raw, [true, false]);
  assert.deepEqual(output.writes, [
    `${ENTER_ALTERNATE_SCREEN}${HIDE_CURSOR}${ENABLE_MOUSE_TRACKING}`,
    `${DISABLE_MOUSE_TRACKING}${SHOW_CURSOR}${LEAVE_ALTERNATE_SCREEN}`,
  ]);
});

test('decodes SGR mouse wheel and click events without swallowing mixed input', () => {
  assert.deepEqual(decodeTerminalMouseInput('\u001b[<64;12;8M'), [
    {
      kind: 'wheel',
      button: 'wheel-up',
      column: 12,
      row: 8,
      shift: false,
      alt: false,
      control: false,
    },
  ]);
  assert.deepEqual(
    decodeTerminalMouseInput('\u001b[<65;72;11M\u001b[<0;72;11M'),
    [
      {
        kind: 'wheel',
        button: 'wheel-down',
        column: 72,
        row: 11,
        shift: false,
        alt: false,
        control: false,
      },
      {
        kind: 'press',
        button: 'left',
        column: 72,
        row: 11,
        shift: false,
        alt: false,
        control: false,
      },
    ],
  );
  assert.deepEqual(decodeTerminalMouseInput('a\u001b[<64;12;8M'), []);
});

test('decodes button motion separately so drag input cannot repeat click actions', () => {
  assert.deepEqual(decodeTerminalMouseInput('\u001b[<32;10;5M'), [
    {
      kind: 'motion',
      button: 'left',
      column: 10,
      row: 5,
      shift: false,
      alt: false,
      control: false,
    },
  ]);
});

test(
  'real PTY smoke observes balanced lifecycle sequences',
  { skip: process.platform === 'win32' },
  () => {
    const tsx = path.resolve('node_modules/.bin/tsx');
    const child = path.resolve('src/terminal-lifecycle-smoke.ts');
    const driver = path.resolve('src/terminal-lifecycle-pty-smoke.py');
    const result = spawnSync('python3', [driver, '/bin/sh', tsx, child], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = result.stdout;
    assert.ok(output.includes(ENTER_ALTERNATE_SCREEN));
    assert.ok(output.includes('\u001b[?25l'));
    assert.match(output, /PTY-LIFECYCLE-SMOKE/);
    assert.ok(output.includes('\u001b[?25h'));
    assert.ok(output.includes(LEAVE_ALTERNATE_SCREEN));
  },
);
