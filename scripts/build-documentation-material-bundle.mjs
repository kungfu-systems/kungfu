#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selector = JSON.parse(
  fs.readFileSync(path.join(ROOT, '.xinfa', 'product-documentation-pack.json')),
);
const atlasDigest = String(selector.atlasRoot || '').slice('sha256:'.length);
const sourceCommit = String(selector.materialSource?.originCommit || '');
const bundleRelative = String(selector.materialSource?.bundleRoot || '');
const expectedBundle = `.xinfa/material-bundles/sha256/${atlasDigest}`;
if (
  selector.materialSource?.kind !== 'tracked-gzip' ||
  !/^[0-9a-f]{64}$/.test(atlasDigest) ||
  !/^[0-9a-f]{40}$/.test(sourceCommit) ||
  bundleRelative !== expectedBundle
) {
  throw new Error('invalid tracked-gzip Documentation Atlas selector');
}
const baselineRelative = `.xinfa/baselines/sha256/${atlasDigest}`;
const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, baselineRelative, 'manifest.json')),
);
for (const artifact of manifest.artifacts || []) {
  const relative = String(artifact.path || '');
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes('\\') ||
    relative.split('/').includes('..')
  ) {
    throw new Error(`invalid Documentation Atlas artifact path: ${relative}`);
  }
  const bytes = execFileSync(
    'git',
    ['show', `${sourceCommit}:${baselineRelative}/${relative}`],
    { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 },
  );
  const contentRoot = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  if (bytes.length !== artifact.size || contentRoot !== artifact.content_root) {
    throw new Error(`historical material differs from witness: ${relative}`);
  }
  const target = `${path.join(ROOT, bundleRelative, ...relative.split('/'))}.gz`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, zlib.gzipSync(bytes, { level: 9 }));
  console.log(path.relative(ROOT, target).split(path.sep).join('/'));
}
