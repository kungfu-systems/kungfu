import assert from 'node:assert/strict';
import test from 'node:test';
import { executeProfileCli } from './profile-cli.ts';

test('Profile CLI transport rejects commands outside the Agent Profile SDK', async () => {
  let called = false;
  const result = await executeProfileCli(
    { args: ['runtime', 'stop'] },
    {
      bin: '/kungfu',
      env: {},
      execFile: () => {
        called = true;
      },
    },
  );
  assert.deepEqual(result, { ok: false, error: 'invalid Profile CLI request' });
  assert.equal(called, false);
});

test('Profile CLI transport permits the narrow asynchronous manager path', async () => {
  let callback:
    | ((error: Error | null, stdout: string, stderr: string) => void)
    | undefined;
  const pending = executeProfileCli(
    { args: ['profile', 'manager', '--json'] },
    {
      bin: '/kungfu',
      env: { KF_RUNTIME_DIR: '/runtime' },
      execFile: (file, args, options, next) => {
        assert.equal(file, '/kungfu');
        assert.deepEqual(args, ['profile', 'manager', '--json']);
        assert.equal(options.maxBuffer, 64 * 1024 * 1024);
        callback = next;
      },
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(callback);
  callback(null, '{"profiles":[]}', '');
  assert.deepEqual(await pending, { ok: true, stdout: '{"profiles":[]}' });
});
