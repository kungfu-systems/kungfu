// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import {
  productReleaseChannelConfig,
  releaseChannelKeyId,
  releaseChannelTrust,
} from './release-channel-trust.mjs';

function rawPublicKey() {
  const { publicKey } = generateKeyPairSync('ed25519');
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
}

function fixture() {
  const active = rawPublicKey().toString('base64');
  const retired = rawPublicKey().toString('base64');
  return {
    schema: 'kungfu.release-channel-trust/v1',
    channels: {
      alpha: {
        indexUrl: 'https://kungfu.tech/.well-known/kungfu/alpha.json',
        activeKeyId: releaseChannelKeyId(active),
        trustedKeys: [
          {
            keyId: releaseChannelKeyId(retired),
            publicKey: retired,
            status: 'retired',
          },
          {
            keyId: releaseChannelKeyId(active),
            publicKey: active,
            status: 'active',
          },
        ],
      },
    },
  };
}

test('installed CLI projects canonical Alpha authority and retained keys', () => {
  const source = fixture();
  const trust = releaseChannelTrust(source);
  const product = productReleaseChannelConfig(source);
  assert.equal(
    product.indexUrl,
    'https://kungfu.tech/.well-known/kungfu/alpha.json',
  );
  assert.equal(product.trustedKeys.length, 2);
  assert.equal(trust.activeKeyId, source.channels.alpha.activeKeyId);
  assert.deepEqual(Object.keys(product.trustedKeys[0]).sort(), [
    'keyId',
    'publicKey',
  ]);
});

test('release channel trust rejects key, URL, and active-set drift', () => {
  const invalidKey = fixture();
  invalidKey.channels.alpha.trustedKeys[1].keyId = 'ed25519-wrong';
  assert.throws(() => releaseChannelTrust(invalidKey), /does not match/);

  const mutableUrl = fixture();
  mutableUrl.channels.alpha.indexUrl =
    'https://kungfu.tech/.well-known/kungfu/alpha.json?candidate=1';
  assert.throws(() => releaseChannelTrust(mutableUrl), /public HTTPS/);

  const twoActive = fixture();
  twoActive.channels.alpha.trustedKeys[0].status = 'active';
  assert.throws(() => releaseChannelTrust(twoActive), /exactly one active/);
});
