// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPassport,
  stableJson,
  verifyPassport,
} from './auditable-demo-passport.mjs';

const SOURCE_SHA = 'a'.repeat(40);
const GATE_ROOT = `sha256:${'b'.repeat(64)}`;
const MEDIA_ROOT = `sha256:${'c'.repeat(64)}`;

function artifact(prefix, id, name, digest) {
  return {
    [`${prefix}_ARTIFACT_ID`]: id,
    [`${prefix}_ARTIFACT_NAME`]: name,
    [`${prefix}_ARTIFACT_DIGEST`]: digest,
    [`${prefix}_ARTIFACT_URL`]: `https://github.com/kungfu-systems/kungfu/actions/runs/42/artifacts/${id}`,
  };
}

function validEnv() {
  return {
    GITHUB_REPOSITORY: 'kungfu-systems/kungfu',
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '1',
    SOURCE_SHA,
    SOURCE_ARTIFACT_EXPIRES_AT: '2026-08-08T12:00:00Z',
    ...artifact(
      'SOURCE',
      '100',
      `kungfu-linux-x64-${SOURCE_SHA}`,
      `sha256:${'1'.repeat(64)}`,
    ),
    ...artifact(
      'GATE',
      '101',
      `auditable-demo-gate-${SOURCE_SHA.slice(0, 12)}-${GATE_ROOT.slice(7, 23)}`,
      `sha256:${'2'.repeat(64)}`,
    ),
    GATE_ROOT,
    BUILDCHAIN_SHA: 'd'.repeat(40),
    RENDERER_IMAGE: `ghcr.io/kungfu-systems/build-images/demo-renderer@sha256:${'e'.repeat(64)}`,
  };
}

test('writes and verifies a Gate-only exact-output passport', () => {
  const passport = buildPassport(validEnv());
  assert.equal(passport.media.status, 'not-requested');
  assert.equal(passport.authority.productionDeployment, false);
  assert.match(passport.root.value, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(verifyPassport(JSON.parse(stableJson(passport))), passport);
});

test('binds a selectively rendered media artifact to its exact root', () => {
  const env = {
    ...validEnv(),
    ...artifact(
      'MEDIA',
      '102',
      `auditable-demo-media-${SOURCE_SHA.slice(0, 12)}-${MEDIA_ROOT.slice(7, 23)}`,
      `sha256:${'3'.repeat(64)}`,
    ),
    MEDIA_ROOT,
  };
  const passport = buildPassport(env);
  assert.equal(passport.media.status, 'rendered');
  assert.equal(passport.media.root, MEDIA_ROOT);
});

test('rejects partial media coordinates', () => {
  const env = {
    ...validEnv(),
    MEDIA_ARTIFACT_ID: '102',
  };
  assert.throws(
    () => buildPassport(env),
    /media artifact coordinate is partial/u,
  );
});

test('rejects a source artifact name not bound to the exact source SHA', () => {
  const env = {
    ...validEnv(),
    SOURCE_ARTIFACT_NAME: 'kungfu-linux-x64-wrong',
  };
  assert.throws(() => buildPassport(env), /source artifact name must equal/u);
});

test('rejects a mutated canonical payload', () => {
  const passport = buildPassport(validEnv());
  passport.gate.status = 'failed';
  assert.throws(
    () => verifyPassport(passport),
    /document root does not match/u,
  );
});
