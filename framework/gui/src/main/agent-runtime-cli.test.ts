import assert from 'node:assert/strict';
import test from 'node:test';
import { executeAgentRuntimeCli } from './agent-runtime-cli.ts';

test('Agent Runtime CLI transport rejects commands outside its namespace', async () => {
  let called = false;
  const result = await executeAgentRuntimeCli(
    { args: ['agent', 'brief', '--json'] },
    {
      bin: '/kungfu',
      env: {},
      execFile: () => {
        called = true;
      },
    },
  );
  assert.deepEqual(result, {
    ok: false,
    error: 'invalid Agent Runtime CLI request',
  });
  assert.equal(called, false);
});

test('Agent Runtime CLI transport permits bounded catalog operations', async () => {
  let callback:
    | ((error: Error | null, stdout: string, stderr: string) => void)
    | undefined;
  const pending = executeAgentRuntimeCli(
    { args: ['agent', 'runtime', 'list', '--json'] },
    {
      bin: '/kungfu',
      env: { KF_RUNTIME_DIR: '/runtime' },
      execFile: (file, args, options, next) => {
        assert.equal(file, '/kungfu');
        assert.deepEqual(args, ['agent', 'runtime', 'list', '--json']);
        assert.equal(options.maxBuffer, 64 * 1024 * 1024);
        callback = next;
      },
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(callback);
  callback(null, '{"configured":[]}', '');
  assert.deepEqual(await pending, { ok: true, stdout: '{"configured":[]}' });
});
