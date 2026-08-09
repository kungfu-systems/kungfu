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
  resolveAssignmentAuthority,
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

function assignmentAuthorityState(coordinates) {
  return {
    schema: 'kungfu.action-loop.assignment-authority/v0',
    phase: 'executing',
    initiativeId: 'initiative-one',
    assignmentId: 'assignment-one',
    coordinates,
    contextBindingRoot: `sha256:${'3'.repeat(64)}`,
    pursuit: { id: 'kungfu:assignment-one', root: ROOT },
    atlas: {
      id: 'xinfa:assignment-one',
      root: `sha256:${'4'.repeat(64)}`,
      verification: {
        valid: true,
        atlas_root: `sha256:${'4'.repeat(64)}`,
        diagnostics: [],
      },
    },
    warrant: {
      id: 'assignment-warrant:assignment-one',
      root: `sha256:${'2'.repeat(64)}`,
    },
  };
}

test('native entry deterministically selects an available source-build binding', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-action-loop-'));
  const bindingDir = path.join(repo, 'framework/core/build/python');
  fs.mkdirSync(bindingDir, { recursive: true });
  fs.writeFileSync(path.join(bindingDir, 'pykungfu.fixture.so'), 'fixture');
  const state = assignmentAuthorityState({
    bindingDir: '/opt/kungfu/binding',
    externalRepoPath: repo,
  });

  const authority = resolveAssignmentAuthority(state, {
    initiativeId: 'initiative-one',
    assignmentId: 'assignment-one',
  });
  assert.equal(authority.bindingDir, bindingDir);
});

test('native entry resolves authority from exact Assignment coordinates', () => {
  const state = assignmentAuthorityState({ bindingDir: '/opt/kungfu/binding' });
  const authority = resolveAssignmentAuthority(state, {
    initiativeId: 'initiative-one',
    assignmentId: 'assignment-one',
  });
  const request = beginNativeRequest({ actor: 'agent-one' }, authority, {
    schema: 'kungfu.action-loop.native-authority/v0',
    id: 'native:binding-one',
    root: `sha256:${'5'.repeat(64)}`,
    state: 'current',
    binding: { path: '/opt/kungfu/binding', root: ROOT },
    profile: {
      id: 'kungfu.work-control',
      root: `sha256:${'6'.repeat(64)}`,
    },
  });

  assert.equal(authority.bindingDir, '/opt/kungfu/binding');
  assert.equal(request.pursuit.binding.id, 'kungfu:assignment-one');
  assert.equal(request.pursuit.binding.root, ROOT);
  assert.equal(request.atlas.binding.root, state.atlas.root);
  assert.equal(request.warrant.binding.root, state.warrant.root);
  assert.equal(request.nativeAuthority.root, `sha256:${'5'.repeat(64)}`);
  assert.equal(request.loopRef, 'action-loop/assignment-one');
  state.phase = 'reviewed';
  assert.equal(
    resolveAssignmentAuthority(state, {
      initiativeId: 'initiative-one',
      assignmentId: 'assignment-one',
    }).assignmentId,
    'assignment-one',
  );
  assert.throws(
    () =>
      resolveAssignmentAuthority(state, {
        initiativeId: 'initiative-one',
        assignmentId: 'different-assignment',
      }),
    /Assignment authority coordinate does not match/,
  );
});
