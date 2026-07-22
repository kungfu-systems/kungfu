import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  KFX_SHARED_MODULE_KEYS,
  createKfxSharedModules,
} from './shared-modules';

test('every declared kfx external has a renderer injection', () => {
  const sentinel = {
    react: {},
    jsxRuntime: {},
    reactDom: {},
    reactDomClient: {},
    api: {},
    capability: {},
    query: {},
  };
  const shared = createKfxSharedModules(sentinel);

  assert.deepEqual(
    Object.keys(shared).sort(),
    [...KFX_SHARED_MODULE_KEYS].sort(),
  );
  assert.equal(shared['@kungfu-tech/api/query'], sentinel.query);
  assert.equal(shared['react-dom/client'], sentinel.reactDomClient);
});
