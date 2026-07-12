import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { executeAtlasCli } from './atlas-cli.ts';

test('main registers Atlas CLI with the shared channel constant', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const electronImport = source.match(
    /import \{([\s\S]*?)\} from 'electron';/,
  )?.[1];
  const channelImport = source.match(
    /import \{([\s\S]*?)\} from '\.\.\/sandbox\/channels';/,
  )?.[1];

  assert.ok(electronImport);
  assert.ok(channelImport);
  assert.doesNotMatch(electronImport, /ATLAS_CLI_EXEC_CHANNEL/);
  assert.match(channelImport, /ATLAS_CLI_EXEC_CHANNEL/);
  assert.match(source, /ipcMain\.handle\(ATLAS_CLI_EXEC_CHANNEL/);
});

test('renderer runtime status does not poll native ledger health', () => {
  const source = readFileSync(
    new URL('../renderer/src/main.tsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /ledger\?\.health\(\)/);
  assert.match(source, /\.invoke\(RUNTIME_STATUS_GET_CHANNEL\)/);
});

test('Atlas CLI transport rejects non-Atlas commands before process startup', async () => {
  let called = false;
  const result = await executeAtlasCli(
    { args: ['runtime', 'stop'] },
    {
      bin: '/kungfu',
      env: {},
      execFile: () => {
        called = true;
      },
    },
  );

  assert.deepEqual(result, { ok: false, error: 'invalid Atlas CLI request' });
  assert.equal(called, false);
});

test('Atlas CLI transport is asynchronous, bounded, and preserves stdout', async () => {
  let callback:
    | ((error: Error | null, stdout: string, stderr: string) => void)
    | undefined;
  const pending = executeAtlasCli(
    { args: ['atlas', 'show', 'dashboard', '--json'] },
    {
      bin: '/kungfu',
      env: { KF_RUNTIME_DIR: '/runtime' },
      execFile: (file, args, options, next) => {
        assert.equal(file, '/kungfu');
        assert.deepEqual(args, ['atlas', 'show', 'dashboard', '--json']);
        assert.equal(options.maxBuffer, 64 * 1024 * 1024);
        assert.equal(options.timeout, 120_000);
        callback = next;
      },
    },
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(callback, 'transport returned control before the child completed');
  callback(null, '{"ok":true}', '');
  assert.deepEqual(await pending, { ok: true, stdout: '{"ok":true}' });
});
