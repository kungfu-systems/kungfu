#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import path from 'node:path';

const UUID_V7 =
  '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const NEW_ID = new RegExp(`^(KF|SHIFU)-ADR-(${UUID_V7})$`);
const LEGACY_ID = /^(SHIFU-)?ADR-[0-9]{4}$/;
const PATH_ID = new RegExp(
  `^(?:((?:KF|SHIFU)-ADR-${UUID_V7})|((?:SHIFU-)?ADR-[0-9]{4}))-`,
);

/**
 * Create an RFC 9562 UUIDv7 using only local time and operating-system
 * randomness. No counter, registry, network, or repository state is read.
 *
 * @param {{timestamp?: number, random?: Uint8Array}} [options]
 */
export function createUuidV7(options = {}) {
  const timestamp = options.timestamp ?? Date.now();
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    timestamp > 0xffffffffffff
  ) {
    throw new Error('UUIDv7 timestamp must be a non-negative 48-bit integer');
  }
  const random = Buffer.from(options.random ?? crypto.randomBytes(10));
  if (random.length !== 10) {
    throw new Error('UUIDv7 generation requires exactly 10 random bytes');
  }

  const bytes = Buffer.alloc(16);
  let remaining = BigInt(timestamp);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  bytes[6] = 0x70 | (random[0] & 0x0f);
  bytes[7] = random[1];
  bytes[8] = 0x80 | (random[2] & 0x3f);
  random.copy(bytes, 9, 3);

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** @param {string} id */
export function classifyAdrIdentity(id) {
  const modern = NEW_ID.exec(id);
  if (modern) {
    return {
      kind: 'uuidv7',
      owner: modern[1] === 'SHIFU' ? 'shifu' : 'kungfu',
    };
  }
  if (LEGACY_ID.test(id)) {
    return {
      kind: 'legacy',
      owner: id.startsWith('SHIFU-') ? 'shifu' : 'kungfu',
    };
  }
  return null;
}

/** @param {string} rel */
export function identityFromAdrPath(rel) {
  const match = PATH_ID.exec(path.posix.basename(rel));
  return match?.[1] || match?.[2] || null;
}

/** @param {string} rel @param {string} adrRoot */
export function inspectAdrRecordPath(rel, adrRoot) {
  const normalized = rel.replaceAll(path.sep, '/');
  const identity = identityFromAdrPath(normalized);
  if (!identity) return { kind: 'other', identity: null };
  if (
    path.posix.dirname(normalized) !== adrRoot ||
    !/\.md$/.test(path.posix.basename(normalized))
  ) {
    return { kind: 'invalid', identity };
  }
  return { kind: 'record', identity };
}

/** @param {'kungfu' | 'shifu'} owner @param {string} uuid */
export function formatAdrIdentity(owner, uuid) {
  if (!new RegExp(`^${UUID_V7}$`).test(uuid)) {
    throw new Error(`not a canonical UUIDv7: ${uuid}`);
  }
  return `${owner === 'shifu' ? 'SHIFU' : 'KF'}-ADR-${uuid}`;
}
