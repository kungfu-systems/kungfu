import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type ExitBundleRequest,
  type ExitPackage,
  openExit,
} from '../src/capability/exit.ts';

test('Exit capability projects every client through the installed Core operation', async () => {
  const calls: string[][] = [];
  const request = {
    schema: 'kungfu.exit-bundle-request/v1',
    mode: 'full',
    scope: {
      id: 'work/demo',
      authority: 'fixture',
      schema: 'fixture.scope/v1',
      protocol: 'fixture-scope/v1',
    },
    members: [
      {
        memberId: 'episode-primary',
        kind: 'episode-v1',
        options: { episodeId: 7 },
      },
    ],
  } satisfies ExitBundleRequest;
  const packageValue = {
    schema: 'kungfu.exit-package/v1',
    manifest: {},
    materials: {},
    execution: {},
    packageRoot: `sha256:${'a'.repeat(64)}`,
  } satisfies ExitPackage;
  const exit = openExit({
    runtimeDir: '/runtime',
    execFileSync: (_file, args, options) => {
      calls.push(args);
      assert.equal(options.env.KF_RUNTIME_DIR, '/runtime');
      return JSON.stringify(packageValue);
    },
    execFile: async (_file, args, options) => {
      calls.push(args);
      assert.equal(options.env.KF_RUNTIME_DIR, '/runtime');
      return JSON.stringify(packageValue);
    },
  });
  const encodedRequest = Buffer.from(JSON.stringify(request), 'utf8').toString(
    'base64',
  );
  const encodedPackage = Buffer.from(
    JSON.stringify(packageValue),
    'utf8',
  ).toString('base64');

  exit.build(request);
  await exit.buildAsync(request);
  exit.inspect(packageValue);
  await exit.inspectAsync(packageValue);
  exit.importPackage(packageValue);
  await exit.importPackageAsync(packageValue, {
    execute: true,
    authorizedBy: 'agent',
  });

  assert.deepEqual(calls, [
    ['exit', 'build', '--input-base64', encodedRequest, '--json'],
    ['exit', 'build', '--input-base64', encodedRequest, '--json'],
    ['exit', 'inspect', '--input-base64', encodedPackage, '--json'],
    ['exit', 'inspect', '--input-base64', encodedPackage, '--json'],
    ['exit', 'import', '--input-base64', encodedPackage, '--json'],
    [
      'exit',
      'import',
      '--input-base64',
      encodedPackage,
      '--execute',
      '--authorized-by',
      'agent',
      '--json',
    ],
  ]);
});
