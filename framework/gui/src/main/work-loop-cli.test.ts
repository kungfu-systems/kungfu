import assert from 'node:assert/strict';
import test from 'node:test';

import { executeWorkLoopCli } from './work-loop-cli.ts';

test('Work Loop CLI transport rejects mutation and unrelated commands', async () => {
  let called = false;
  const deps = {
    bin: '/kungfu',
    env: {},
    execFile: () => {
      called = true;
    },
  };
  assert.deepEqual(
    await executeWorkLoopCli(
      { args: ['work', 'checkpoint', 'w1', 'note'] },
      deps,
    ),
    { ok: false, error: 'invalid Work Loop CLI request' },
  );
  assert.deepEqual(
    await executeWorkLoopCli({ args: ['runtime', 'stop'] }, deps),
    { ok: false, error: 'invalid Work Loop CLI request' },
  );
  assert.equal(called, false);
});

test('Work Loop CLI transport permits exact read-only requests', async () => {
  const seen: string[][] = [];
  const invoke = (args: string[]) =>
    executeWorkLoopCli(
      { args },
      {
        bin: '/kungfu',
        env: { KF_RUNTIME_DIR: '/runtime' },
        execFile: (_file, actual, options, next) => {
          seen.push(actual);
          assert.equal(options.timeout, 120_000);
          next(null, '{}', '');
        },
      },
    );
  assert.deepEqual(await invoke(['work', 'capabilities', '--json']), {
    ok: true,
    stdout: '{}',
  });
  assert.deepEqual(
    await invoke(['work', 'inspect', '--repo', '/repo', '--json']),
    { ok: true, stdout: '{}' },
  );
  assert.deepEqual(
    await invoke(['work', 'recover', '--repo', '/repo', '--json']),
    { ok: true, stdout: '{}' },
  );
  assert.deepEqual(seen, [
    ['work', 'capabilities', '--json'],
    ['work', 'inspect', '--repo', '/repo', '--json'],
    ['work', 'recover', '--repo', '/repo', '--json'],
  ]);
});
