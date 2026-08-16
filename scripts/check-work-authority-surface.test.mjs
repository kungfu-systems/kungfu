// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (file) => fs.readFileSync(file, 'utf8');

const retiredPaths = [
  'framework/core/src/python/kungfu/cli/commands/work.py',
  'framework/core/src/python/kungfu/work_facade.py',
  'framework/core/src/python/kungfu/work/__init__.py',
  'framework/core/src/python/kungfu/work/store.py',
  'framework/core/src/libkungfu/include/kungfu/runtime/action/work_journal.h',
  'framework/core/src/libkungfu/src/runtime/action/work_journal.cpp',
  'framework/core/src/libkungfu/schemas/work_events.fbs',
  'framework/core/src/libkungfu/schemas/work_events.bfbs',
];

test('the retired WorkStore authority has no executable or schema surface', () => {
  for (const file of retiredPaths) {
    assert.equal(
      fs.existsSync(file),
      false,
      `retired authority remains: ${file}`,
    );
  }
  assert.doesNotMatch(
    read('framework/core/src/libkungfu/src/runtime/action/action_runtime.cpp'),
    /work_journal|native-work-journal/u,
  );
  assert.doesNotMatch(
    read('framework/core/src/python/kungfu/cli/commands/__registry__.py'),
    /from \. import work\b/u,
  );
});

test('the only public Work mutation family is kungfu work', () => {
  const command = read(
    'framework/core/src/python/kungfu/cli/commands/assignment.py',
  );
  assert.match(command, /@kfc\.group\(\s*name="work"/u);
  assert.doesNotMatch(command, /@kfc\.group\(\s*name="assignment"/u);

  const workControl = read(
    'extensions/work-control/work-control-actions/domain/work_control.py',
  );
  assert.doesNotMatch(workControl, /^def create_mission\(/mu);
  assert.doesNotMatch(workControl, /^def create_go\(/mu);

  assert.equal(
    fs.existsSync('framework/core/src/python/kungfu/cli/commands/atlas.py'),
    false,
  );
});

test('agent catalogs cannot advertise a retired Work mutation authority', () => {
  for (const file of [
    'framework/core/src/python/kungfu/agent/kfd3_api.registry.json',
    'framework/core/src/python/kungfu/agent/commands.json',
  ]) {
    const source = read(file);
    assert.doesNotMatch(source, /kungfu\.codex\.report-goal/u);
    assert.doesNotMatch(
      source,
      /kungfu\.atlas\.(?:create-mission|create-go|claim-completion|review-completion|decide-continuation)/u,
    );
    assert.match(source, /kungfu\.work\.claim-completion/u);
    assert.doesNotMatch(
      source,
      /kungfu\.work\.(?:create|complete|settle|import|export|recover|loop|inspect)/u,
    );
  }
});
