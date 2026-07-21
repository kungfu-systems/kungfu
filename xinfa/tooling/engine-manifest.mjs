// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** @param {string} root */
function filesUnder(root) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} directory */
  function visit(directory) {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) =>
        Buffer.from(left.name).compare(Buffer.from(right.name)),
      )) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile())
        files.push(path.relative(root, absolute).split(path.sep).join('/'));
      else
        throw new Error(
          `Xinfa source tree contains a non-file entry: ${absolute}`,
        );
    }
  }
  visit(root);
  return files;
}

/** @param {string} xinfaRoot */
export function sourceTreeHash(xinfaRoot) {
  const sourceRoot = path.join(xinfaRoot, 'src');
  const hash = crypto.createHash('sha256');
  for (const relative of filesUnder(sourceRoot)) {
    const bytes = fs.readFileSync(path.join(sourceRoot, relative));
    const pathBytes = Buffer.from(relative, 'utf8');
    const lengths = Buffer.alloc(16);
    lengths.writeBigUInt64BE(BigInt(pathBytes.length), 0);
    lengths.writeBigUInt64BE(BigInt(bytes.length), 8);
    hash.update(lengths);
    hash.update(pathBytes);
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

/** @param {Buffer | Uint8Array} bytes */
export function bytesHash(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}
