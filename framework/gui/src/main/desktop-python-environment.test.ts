import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configureProductCacheEnvironment,
  resolveProductCacheHome,
  runtimeBuildIdFromManifest,
} from './desktop-python-environment.ts';

test('product cache precedence and platform defaults stay cross-platform', () => {
  assert.equal(
    resolveProductCacheHome(
      {
        HOME: '/Users/kf',
        KF_INSTANCE_HOME: '/instances/a',
        KF_CACHE_HOME: '/cache/explicit',
      },
      { platform: 'darwin', homeDir: '/Users/kf', cwd: '/workspace' },
    ),
    '/cache/explicit',
  );
  assert.equal(
    resolveProductCacheHome(
      { HOME: '/home/kf', KF_INSTANCE_HOME: '/instances/a' },
      { platform: 'linux', homeDir: '/home/kf', cwd: '/workspace' },
    ),
    '/instances/a/cache',
  );
  assert.equal(
    resolveProductCacheHome(
      { HOME: '/Users/kf' },
      { platform: 'darwin', homeDir: '/Users/kf', cwd: '/workspace' },
    ),
    '/Users/kf/Library/Caches/kungfu',
  );
  assert.equal(
    resolveProductCacheHome(
      { LOCALAPPDATA: 'C:\\Users\\kf\\AppData\\Local' },
      {
        platform: 'win32',
        homeDir: 'C:\\Users\\kf',
        cwd: 'C:\\workspace',
      },
    ),
    'C:\\Users\\kf\\AppData\\Local\\Kungfu\\Cache',
  );
  assert.equal(
    resolveProductCacheHome(
      { HOME: '/home/kf', XDG_CACHE_HOME: '/xdg/cache' },
      { platform: 'linux', homeDir: '/home/kf', cwd: '/workspace' },
    ),
    '/xdg/cache/kungfu',
  );
});

test('packaged desktop exports a runtime-versioned Python cache prefix', () => {
  const env: NodeJS.ProcessEnv = { HOME: '/Users/kf' };
  const result = configureProductCacheEnvironment(env, {
    isPackaged: true,
    resourcesPath: '/Applications/Kungfu.app/Contents/Resources',
    platform: 'darwin',
    homeDir: '/Users/kf',
    cwd: '/workspace',
    readFile: () =>
      JSON.stringify({ runtimeBuildId: 'runtime-4.0.0-alpha.1-deadbeef' }),
  });
  assert.deepEqual(result, {
    cacheHome: '/Users/kf/Library/Caches/kungfu',
    runtimeBuildId: 'runtime-4.0.0-alpha.1-deadbeef',
    pycachePrefix:
      '/Users/kf/Library/Caches/kungfu/python/runtime-4.0.0-alpha.1-deadbeef',
  });
  assert.equal(env.KF_CACHE_HOME, result.cacheHome);
  assert.equal(env.PYTHONPYCACHEPREFIX, result.pycachePrefix);
  assert.equal(
    env.KUNGFU_UPGRADE_MANIFEST,
    '/Applications/Kungfu.app/Contents/Resources/upgrade/kungfu-release-manifest.json',
  );
  assert.equal(env.PYTHONDONTWRITEBYTECODE, undefined);
});

test('development and manifest namespaces fail safe', () => {
  const env: NodeJS.ProcessEnv = { HOME: '/home/kf' };
  configureProductCacheEnvironment(env, {
    isPackaged: false,
    resourcesPath: '/unused',
    platform: 'linux',
    homeDir: '/home/kf',
    cwd: '/workspace',
  });
  assert.equal(
    env.PYTHONPYCACHEPREFIX,
    '/home/kf/.cache/kungfu/python/development',
  );
  assert.throws(
    () => runtimeBuildIdFromManifest('{"runtimeBuildId":"../escape"}'),
    /safe cache namespace/,
  );
});
