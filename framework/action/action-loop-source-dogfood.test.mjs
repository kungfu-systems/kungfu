// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  beginNativeRequest,
  projectQualificationResult,
  pythonSearchPath,
  qualificationExecutorProfile,
  renderQualificationResult,
  resolveProjectCutAuthority,
} from './action-loop-source-dogfood.mjs';

const ROOT = `sha256:${'1'.repeat(64)}`;

test('human and JSON qualification surfaces project the same canonical fields', () => {
  const result = {
    ok: true,
    code: 'resumed',
    state: 'running',
    envelope: {
      state: 'running',
      roles: {
        pursuit: { id: 'pursuit:one', root: ROOT },
        atlas: { id: 'atlas:one', root: ROOT },
        warrant: { id: 'warrant:one', root: ROOT },
        episode: { id: 'episode:one', root: null },
        fact: { id: 'fact:one', root: ROOT },
      },
      factRef: { name: 'action-loop/one', cutRoot: ROOT, revision: 3 },
      residualRisk: ['source checkout only'],
    },
    receipts: [{ receiptRoot: ROOT }],
    checkpointRoot: ROOT,
    nextStep: 'seal-episode',
    writeOccurred: false,
  };

  const projected = projectQualificationResult(result);
  const rendered = renderQualificationResult(projected);

  assert.equal(projected.status, 'running');
  assert.equal(projected.message, null);
  assert.equal(projected.current, null);
  assert.equal(projected.identities.pursuit, 'pursuit:one');
  assert.equal(projected.authority.pursuit, ROOT);
  assert.deepEqual(projected.residualRisk, ['source checkout only']);
  assert.match(rendered, /status: running \(resumed\)/);
  assert.match(rendered, new RegExp(`pursuit: pursuit:one @ ${ROOT}`));
  assert.match(rendered, /residualRisk: source checkout only/);
});

test('qualification completion uses only native executor profiles', () => {
  assert.equal(qualificationExecutorProfile(), 'inline');
  assert.equal(qualificationExecutorProfile('thread'), 'thread');
  assert.equal(qualificationExecutorProfile('process'), 'process');
  assert.throws(
    () => qualificationExecutorProfile('source-dogfood'),
    /must be inline, thread, or process/,
  );
});

test('native entry loads the exact source adapter before the build binding', () => {
  const binding = path.join('tmp', 'core-build-python');
  const inherited = path.join('tmp', 'inherited-python');
  const entries = pythonSearchPath(binding, inherited).split(path.delimiter);

  assert.match(entries[0], /framework[/\\]core[/\\]src[/\\]python$/);
  assert.equal(entries[1], binding);
  assert.equal(entries[2], inherited);
});

test('native entry deterministically selects an available source-build binding', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-action-loop-'));
  const bindingDir = path.join(repo, 'framework/core/build/python');
  fs.mkdirSync(bindingDir, { recursive: true });
  fs.writeFileSync(path.join(bindingDir, 'pykungfu.fixture.so'), 'fixture');
  const state = {
    phase: 'native-go',
    goal_id: 'goal-one',
    coordinates: {
      binding_dir: '/opt/kungfu/binding',
      external_repo_path: repo,
    },
    native: {
      mission_id: 'mission-one',
      go_id: 'goal-one',
      go_receipt: {
        go_subject: 'kungfu:goal-one',
        receipt: { payload_hash: ROOT },
      },
    },
    roots: {
      acceptance_root: `sha256:${'2'.repeat(64)}`,
      context_binding_root: `sha256:${'3'.repeat(64)}`,
      input_atlas_root: `sha256:${'4'.repeat(64)}`,
    },
    context: {
      receipts: {
        atlas_verify: {
          valid: true,
          atlas_root: `sha256:${'4'.repeat(64)}`,
          diagnostics: [],
        },
      },
    },
  };

  const authority = resolveProjectCutAuthority(state, {
    missionId: 'mission-one',
    goalId: 'goal-one',
  });
  assert.equal(authority.bindingDir, bindingDir);
});

test('native entry resolves authority from stable Project Cut coordinates', () => {
  const state = {
    schema: 'atlas.project-cut-go/v1',
    phase: 'native-go',
    goal_id: 'goal-one',
    coordinates: { binding_dir: '/opt/kungfu/binding' },
    native: {
      mission_id: 'mission-one',
      go_id: 'goal-one',
      go_receipt: {
        go_subject: 'kungfu:goal-one',
        receipt: { payload_hash: ROOT },
      },
    },
    roots: {
      acceptance_root: `sha256:${'2'.repeat(64)}`,
      context_binding_root: `sha256:${'3'.repeat(64)}`,
      input_atlas_root: `sha256:${'4'.repeat(64)}`,
    },
    context: {
      receipts: {
        atlas_verify: {
          valid: true,
          atlas_root: `sha256:${'4'.repeat(64)}`,
          diagnostics: [],
        },
      },
    },
  };
  const authority = resolveProjectCutAuthority(state, {
    missionId: 'mission-one',
    goalId: 'goal-one',
  });
  const request = beginNativeRequest({ actor: 'agent-one' }, authority, {
    schema: 'kungfu.action-loop.native-authority/v0',
    id: 'native:binding-one',
    root: `sha256:${'5'.repeat(64)}`,
    state: 'current',
    binding: { path: '/opt/kungfu/binding', root: ROOT },
    profile: {
      id: 'kungfu.mission-control',
      root: `sha256:${'6'.repeat(64)}`,
    },
  });

  assert.equal(authority.bindingDir, '/opt/kungfu/binding');
  assert.equal(request.pursuit.binding.id, 'kungfu:goal-one');
  assert.equal(request.pursuit.binding.root, ROOT);
  assert.equal(request.atlas.binding.root, state.roots.input_atlas_root);
  assert.equal(request.warrant.binding.root, state.roots.acceptance_root);
  assert.equal(request.nativeAuthority.root, `sha256:${'5'.repeat(64)}`);
  assert.equal(request.loopRef, 'action-loop/goal-one');
  state.phase = 'reviewed';
  assert.equal(
    resolveProjectCutAuthority(state, {
      missionId: 'mission-one',
      goalId: 'goal-one',
    }).goalId,
    'goal-one',
  );
  assert.throws(
    () =>
      resolveProjectCutAuthority(state, {
        missionId: 'mission-one',
        goalId: 'different-goal',
      }),
    /goal coordinate does not match/,
  );
});
