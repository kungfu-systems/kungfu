import assert from 'node:assert/strict';
import test from 'node:test';

import { openWorkLoop } from '../src/capability/work-loop.ts';

test('WorkLoop exposes only the admitted read-only CLI projection', async () => {
  const calls: Array<{
    file: string;
    args: string[];
    env: Record<string, string | undefined>;
  }> = [];
  const loop = openWorkLoop({
    runtimeDir: '/runtime',
    repoRoot: '/repo',
    bin: '/kungfu',
    env: { KF_TEST: 'yes' },
    execFile: async (file, args, options) => {
      calls.push({ file, args, env: options.env });
      if (args[1] === 'capabilities') {
        return JSON.stringify({ schema: 'kungfu.work-loop-capabilities/v1' });
      }
      if (args[1] === 'inspect') {
        return JSON.stringify({ schema: 'kungfu.work.inspect/v1' });
      }
      return JSON.stringify({ schema: 'kungfu.work.recovery-plan/v1' });
    },
  });

  await loop.capabilities();
  await loop.inspect();
  await loop.recover('/other-repo');

  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ['work', 'capabilities', '--json'],
      ['work', 'inspect', '--repo', '/repo', '--json'],
      ['work', 'recover', '--repo', '/other-repo', '--json'],
    ],
  );
  assert.ok(calls.every((call) => call.file === '/kungfu'));
  assert.ok(calls.every((call) => call.env.KF_RUNTIME_DIR === '/runtime'));
  assert.ok(calls.every((call) => call.env.KF_TEST === 'yes'));
});

test('WorkLoop rejects malformed JSON instead of inventing a projection', async () => {
  const loop = openWorkLoop({
    runtimeDir: '/runtime',
    repoRoot: '/repo',
    execFile: async () => 'not-json',
  });
  await assert.rejects(loop.inspect(), SyntaxError);
});

test('WorkLoop fails visibly when no project workspace is selected', async () => {
  let called = false;
  const loop = openWorkLoop({
    runtimeDir: '/runtime',
    repoRoot: '',
    execFile: async () => {
      called = true;
      return '{}';
    },
  });
  await assert.rejects(loop.inspect(), /project workspace root is unavailable/);
  assert.equal(called, false);
});
