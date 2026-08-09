// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';

export const RELEASE_CHANNEL_TRUST_SCHEMA = 'kungfu.release-channel-trust/v1';

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function publicHttps(value, label) {
  const normalized = requiredString(value, label);
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${label} must be a public HTTPS URL`);
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${label} must be public HTTPS without credentials, query, or fragment`,
    );
  }
  return url.href;
}

export function rawEd25519PublicKey(value, label = 'publicKey') {
  const normalized = requiredString(value, label);
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== normalized) {
    throw new Error(`${label} must be canonical base64 for 32 Ed25519 bytes`);
  }
  return normalized;
}

export function releaseChannelKeyId(publicKey) {
  const normalized = rawEd25519PublicKey(publicKey);
  return `ed25519-${crypto
    .createHash('sha256')
    .update(Buffer.from(normalized, 'base64'))
    .digest('hex')
    .slice(0, 16)}`;
}

export function releaseChannelTrust(document, channel = 'alpha') {
  if (document?.schema !== RELEASE_CHANNEL_TRUST_SCHEMA) {
    throw new Error(
      `release channel trust schema must be ${RELEASE_CHANNEL_TRUST_SCHEMA}`,
    );
  }
  const source = document.channels?.[channel];
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`release channel trust must configure ${channel}`);
  }
  const activeKeyId = requiredString(source.activeKeyId, 'activeKeyId');
  if (!Array.isArray(source.trustedKeys) || source.trustedKeys.length === 0) {
    throw new Error('trustedKeys must retain at least one public key');
  }
  const seen = new Set();
  let activeCount = 0;
  const trustedKeys = source.trustedKeys.map((entry, index) => {
    const label = `trustedKeys[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${label} must be an object`);
    }
    const publicKey = rawEd25519PublicKey(
      entry.publicKey,
      `${label}.publicKey`,
    );
    const keyId = requiredString(entry.keyId, `${label}.keyId`);
    if (keyId !== releaseChannelKeyId(publicKey)) {
      throw new Error(`${label}.keyId does not match its public key`);
    }
    if (seen.has(keyId)) {
      throw new Error(`duplicate release channel key: ${keyId}`);
    }
    seen.add(keyId);
    if (!['active', 'retired'].includes(entry.status)) {
      throw new Error(`${label}.status must be active or retired`);
    }
    if (entry.status === 'active') activeCount += 1;
    return { keyId, publicKey, status: entry.status };
  });
  if (
    activeCount !== 1 ||
    !trustedKeys.some(
      (entry) => entry.keyId === activeKeyId && entry.status === 'active',
    )
  ) {
    throw new Error('release channel trust must select exactly one active key');
  }
  return {
    indexUrl: publicHttps(source.indexUrl, 'indexUrl'),
    activeKeyId,
    trustedKeys,
  };
}

export function productReleaseChannelConfig(document, channel = 'alpha') {
  const trust = releaseChannelTrust(document, channel);
  return {
    indexUrl: trust.indexUrl,
    trustedKeys: trust.trustedKeys.map(({ keyId, publicKey }) => ({
      keyId,
      publicKey,
    })),
  };
}
