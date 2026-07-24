// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import {
  publicationCommitEvidence,
  publicationTimestamp,
  signingIdentity,
} from './alpha-publication-commit.mjs';

test('publication signing identity is derived from Ed25519 public bytes', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const identity = signingIdentity(
    privateKey.export({ format: 'pem', type: 'pkcs8' }),
  );
  assert.match(identity.keyId, /^ed25519-[a-f0-9]{16}$/);
  assert.equal(Buffer.from(identity.publicKey, 'base64').length, 32);
});

test('publication evidence binds exact read-back and rollback authority', () => {
  const evidence = publicationCommitEvidence({
    version: '4.0.0-alpha.2',
    sourceSha: '1'.repeat(40),
    releaseSha: '2'.repeat(40),
    releaseTag: 'v4.0.0-alpha.2',
    payloadRoot: `sha256:${'a'.repeat(64)}`,
    previousPayloadRoot: `sha256:${'b'.repeat(64)}`,
    sitePullRequest:
      'https://github.com/kungfu-systems/site-kungfu-tech/pull/126',
    priorUpgrade: 'passed:previous-immutable-installer-to-current-channel',
  });
  assert.equal(evidence.readback.status, 'passed');
  assert.equal(evidence.readback.payloadRoot, evidence.publication.payloadRoot);
  assert.equal(evidence.recovery.previousAuthority, 'preserved');
  assert.equal(evidence.recovery.rollbackReference, `sha256:${'b'.repeat(64)}`);
});

test('channel timestamp is deterministically owned by the final passport', () => {
  assert.equal(
    publicationTimestamp({
      surfaceTimestampPolicy: {
        publishedAt: '2026-07-24T06:00:00.000Z',
      },
    }).toISOString(),
    '2026-07-24T06:00:00.000Z',
  );
  assert.throws(
    () => publicationTimestamp({}),
    /publication timestamp is required/,
  );
});
