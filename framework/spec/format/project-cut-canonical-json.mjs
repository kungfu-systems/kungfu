// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { createHash } from 'node:crypto';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasValidUnicodeScalars(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * Canonical JSON for Project Cut roots. Objects are ordered by UTF-8 key bytes;
 * arrays retain their declared order. Only NFC strings and safe integers are
 * admitted so another implementation never has to guess number or text rules.
 * @param {unknown} value
 * @param {string} [at]
 * @returns {string}
 */
export function canonicalJson(value, at = '$') {
  if (value === null || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'string') {
    if (!hasValidUnicodeScalars(value)) {
      throw Object.assign(new Error(`${at} contains an unpaired surrogate`), {
        code: 'invalid-unicode',
        path: at,
      });
    }
    if (value.normalize('NFC') !== value) {
      throw Object.assign(new Error(`${at} must be NFC-normalized`), {
        code: 'non-canonical-unicode',
        path: at,
      });
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw Object.assign(
        new Error(`${at} must be a non-negative safe integer`),
        {
          code: 'non-canonical-number',
          path: at,
        },
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((entry, index) => canonicalJson(entry, `${at}[${index}]`))
      .join(',')}]`;
  }
  if (isObject(value)) {
    const entries = Object.entries(value).sort(([left], [right]) =>
      utf8Compare(left, right),
    );
    return `{${entries
      .map(([key, child]) => {
        canonicalJson(key, `${at}.<key>`);
        return `${JSON.stringify(key)}:${canonicalJson(child, `${at}.${key}`)}`;
      })
      .join(',')}}`;
  }
  throw Object.assign(new Error(`${at} contains an unsupported JSON value`), {
    code: 'unsupported-json-value',
    path: at,
  });
}

export function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function semanticRoot(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), 'utf8'));
}
