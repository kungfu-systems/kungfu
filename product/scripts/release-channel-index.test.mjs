// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  buildChannelIndex,
  canonicalBytes,
  channelSpecFromAdmission,
  contentRoot,
} from './release-channel-index.mjs';

const sourceCommit = '1'.repeat(40);
const root = `sha256:${'2'.repeat(64)}`;

function manifest(overrides = {}) {
  return {
    schema: 'kungfu.product-upgrade.manifest/v1',
    productVersion: '4.0.0-alpha.2',
    releaseChannel: 'alpha',
    sourceCommit,
    runtimeBuildId: 'runtime-4.0.0-alpha.2-linux-x64',
    runtimeArtifactDigest: root,
    runtimeEntrypoint: 'bin/kungfu',
    frontendBuildId: 'cli-4.0.0-alpha.2-linux-x64',
    controlProtocolRange: { min: 1, max: 1 },
    peerWireProtocolRange: { min: 1, max: 1 },
    journalSchemaReadRange: { min: 1, max: 1 },
    journalSchemaWriteVersion: 1,
    migrationClass: 'none',
    rollbackClass: 'automatic',
    minimumSupportedFrontend: '4.0.0-alpha.0',
    minimumSupportedRuntime: '4.0.0-alpha.0',
    platform: 'linux',
    architecture: 'x64',
    artifacts: [
      {
        kind: 'runtime',
        url: 'https://releases.kungfu.invalid/runtime.tar.gz',
        size: 42,
        digest: root,
        signature: 'sigstore:fixture',
      },
    ],
    qualificationEvidenceRef: 'buildchain:qualification/fixture',
    documentationUrl: 'https://www.kungfu.tech/docs/guides/upgrading',
    ...overrides,
  };
}

function fixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-release-channel-'),
  );
  const manifestPath = path.join(directory, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest())}\n`);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    directory,
    baseDirectory: directory,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicKey,
    spec: {
      keyId: 'fixture-2026',
      generatedAt: '2026-07-23T00:00:00Z',
      expiresAt: '2026-07-24T00:00:00Z',
      sourceCommit,
      releasePassport: {
        ref: 'buildchain:passport/fixture',
        root: `sha256:${'3'.repeat(64)}`,
      },
      entries: [
        {
          channel: 'alpha',
          installSource: 'archive',
          rollout: 'current',
          manifestPath: 'manifest.json',
        },
      ],
    },
  };
}

test('channel index generation is deterministic and signs exact canonical bytes', () => {
  const value = fixture();
  const first = buildChannelIndex(value);
  const second = buildChannelIndex(value);
  assert.deepEqual(first, second);
  assert.equal(first.entries.length, 1);
  assert.equal(
    first.payloadRoot,
    contentRoot(
      Object.fromEntries(
        Object.entries(first).filter(
          ([key]) => !['payloadRoot', 'signature'].includes(key),
        ),
      ),
    ),
  );
  const signed = Object.fromEntries(
    Object.entries(first).filter(([key]) => key !== 'signature'),
  );
  assert.equal(
    verify(
      null,
      canonicalBytes(signed),
      value.publicKey,
      Buffer.from(first.signature.value, 'base64'),
    ),
    true,
  );
  const schema = JSON.parse(
    fs.readFileSync(
      path.resolve(
        'framework/upgrade/kungfu-release-channel-index.schema.json',
      ),
      'utf8',
    ),
  );
  const validate = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
  }).compile(schema);
  assert.equal(validate(first), true, JSON.stringify(validate.errors));
});

test('channel index generation rejects source, channel, and identity drift', () => {
  const sourceMismatch = fixture();
  sourceMismatch.spec.sourceCommit = '4'.repeat(40);
  assert.throws(
    () => buildChannelIndex(sourceMismatch),
    /release manifest identity mismatch/,
  );

  const duplicate = fixture();
  duplicate.spec.entries.push({ ...duplicate.spec.entries[0] });
  assert.throws(
    () => buildChannelIndex(duplicate),
    /duplicate release channel entry/,
  );

  const invalidChannel = fixture();
  invalidChannel.spec.entries[0].channel = 'nightly';
  assert.throws(
    () => buildChannelIndex(invalidChannel),
    /release channel is invalid/,
  );

  const signedUrl = fixture();
  signedUrl.spec.entries[0].documentationUrl =
    'https://www.kungfu.tech/docs/guides/upgrading?token=secret';
  assert.throws(
    () => buildChannelIndex(signedUrl),
    /public HTTPS URL without credentials or query/,
  );
});

test('release admission projects exact passport and manifest coordinates', () => {
  const value = fixture();
  const passportPath = path.join(value.directory, 'passport.json');
  const passport = {
    contract: 'kungfu-buildchain-release-candidate-passport',
    source: { headSha: sourceCommit },
  };
  fs.writeFileSync(passportPath, `${JSON.stringify(passport)}\n`);
  const spec = channelSpecFromAdmission({
    admission: {
      manifests: [
        {
          platform: 'linux',
          architecture: 'x64',
          manifestPath: path.join(value.directory, 'manifest.json'),
        },
      ],
    },
    releaseCandidatePassportPath: passportPath,
    channel: 'alpha',
    installSources: ['archive', 'homebrew'],
    keyId: value.spec.keyId,
    generatedAt: value.spec.generatedAt,
    expiresAt: value.spec.expiresAt,
  });
  assert.equal(spec.sourceCommit, sourceCommit);
  assert.equal(spec.releasePassport.root, contentRoot(passport));
  assert.equal(spec.entries.length, 2);
  const index = buildChannelIndex({
    spec,
    privateKeyPem: value.privateKeyPem,
  });
  assert.deepEqual(
    index.entries.map((entry) => entry.installSource),
    ['archive', 'homebrew'],
  );
});
