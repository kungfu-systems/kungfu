// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const readJson = (path) => JSON.parse(fs.readFileSync(path, 'utf8'));

test('Work Control exposes one native Initiative and Assignment domain', () => {
  const profile = readJson('extensions/work-control/profile.json');
  const actions = readJson('extensions/work-control/actions/registry.json');
  const world = readJson('extensions/work-control/contracts/world.json');

  assert.equal(profile.id, 'kungfu.work-control');
  assert.equal(world.profileId, 'kungfu.work-control');
  assert.deepEqual(profile.migrations.registry, {
    path: 'migrations/registry.json',
    sha256: '440c1dd01fc89f137dd3636a262a7e00b21b9d38d4c030330e5ccfc7e21675a8',
  });
  const ids = actions.actions.map((row) => row.id);
  assert(ids.includes('create-initiative'));
  assert(ids.includes('create-assignment'));
  assert(actions.actions.every((action) => action.compatibility === undefined));
});
