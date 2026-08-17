#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { canonicalJson } from '../framework/project-cut/src/project-cut.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {Buffer|string} value */
function sha(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

/** @param {object} value */
function semanticRoot(value) {
  return sha(Buffer.from(`${canonicalJson(value)}\n`, 'utf8'));
}

/** @param {object} manifest @param {object} receipt */
function verifyCompileRecords(manifest, receipt) {
  const { manifest_root: manifestRoot, ...manifestPreimage } = manifest;
  const { receipt_root: receiptRoot, ...receiptPreimage } = receipt;
  if (
    manifest.schema !== 'xinfa.atlas-manifest/v1' ||
    !/^sha256:[0-9a-f]{64}$/.test(String(manifest.atlas_root || '')) ||
    semanticRoot(manifestPreimage) !== manifestRoot ||
    receipt.schema !== 'xinfa.atlas-compile-receipt/v1' ||
    semanticRoot(receiptPreimage) !== receiptRoot ||
    receipt.verdict !== 'pass' ||
    receipt.atlas_root !== manifest.atlas_root ||
    receipt.manifest_root !== manifestRoot
  ) {
    throw new Error('compiled Documentation Atlas fails semantic verification');
  }
}

/** @param {string} relative */
function safeArtifact(relative) {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes('\\') ||
    relative.split('/').includes('..')
  ) {
    throw new Error(`invalid Documentation Atlas artifact path: ${relative}`);
  }
  return relative;
}

/** @param {string[]} args */
function options(args) {
  const result = { source: '', originCommit: '' };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[++index];
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === '--source') result.source = path.resolve(value);
    else if (flag === '--origin-commit') result.originCommit = value;
    else throw new Error(`unknown option: ${flag}`);
  }
  if (Boolean(result.source) !== Boolean(result.originCommit))
    throw new Error('--source and --origin-commit must be supplied together');
  if (result.originCommit && !/^[0-9a-f]{40}$/.test(result.originCommit))
    throw new Error('--origin-commit must be an exact lowercase 40-hex commit');
  return result;
}

const parsed = options(process.argv.slice(2));
let selector;
let manifest;
let receipt;
let readArtifact;

if (parsed.source) {
  const originTree = execFileSync(
    'git',
    ['rev-parse', `${parsed.originCommit}^{tree}`],
    { cwd: ROOT, encoding: 'utf8' },
  ).trim();
  manifest = JSON.parse(
    fs.readFileSync(path.join(parsed.source, 'manifest.json'), 'utf8'),
  );
  receipt = JSON.parse(
    fs.readFileSync(path.join(parsed.source, 'receipt.json'), 'utf8'),
  );
  const atlasDigest = manifest.atlas_root.slice('sha256:'.length);
  selector = {
    schema: 'kungfu.product-documentation-pack/v1',
    atlasRoot: manifest.atlas_root,
    contextPackRoot: manifest.context_pack_root,
    visibility: 'public',
    compilerAuthority: 'xinfa',
    runtimeAuthority: 'read-only',
    materialSource: {
      kind: 'tracked-gzip',
      originCommit: parsed.originCommit,
      originTree,
      bundleRoot: `.xinfa/material-bundles/sha256/${atlasDigest}`,
    },
  };
  readArtifact = (relative) =>
    fs.readFileSync(path.join(parsed.source, relative));
} else {
  selector = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, '.xinfa', 'product-documentation-pack.json'),
    ),
  );
  const atlasDigest = String(selector.atlasRoot || '').slice('sha256:'.length);
  const baselineRelative = `.xinfa/baselines/sha256/${atlasDigest}`;
  manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, baselineRelative, 'manifest.json')),
  );
  receipt = JSON.parse(
    fs.readFileSync(path.join(ROOT, baselineRelative, 'receipt.json')),
  );
  const materialRelative = String(selector.materialSource?.bundleRoot || '');
  readArtifact = (relative) =>
    zlib.gunzipSync(
      fs.readFileSync(
        `${path.join(ROOT, materialRelative, ...relative.split('/'))}.gz`,
      ),
    );
}

verifyCompileRecords(manifest, receipt);

const atlasDigest = String(selector.atlasRoot || '').slice('sha256:'.length);
const sourceCommit = String(selector.materialSource?.originCommit || '');
const sourceTree = String(selector.materialSource?.originTree || '');
const bundleRelative = String(selector.materialSource?.bundleRoot || '');
const expectedBundle = `.xinfa/material-bundles/sha256/${atlasDigest}`;
if (
  selector.materialSource?.kind !== 'tracked-gzip' ||
  !/^[0-9a-f]{64}$/.test(atlasDigest) ||
  !/^[0-9a-f]{40}$/.test(sourceCommit) ||
  !/^[0-9a-f]{40}$/.test(sourceTree) ||
  bundleRelative !== expectedBundle
) {
  throw new Error('invalid tracked-gzip Documentation Atlas selector');
}
const baselineRelative = `.xinfa/baselines/sha256/${atlasDigest}`;
const baseline = path.join(ROOT, baselineRelative);
fs.mkdirSync(baseline, { recursive: true });
fs.writeFileSync(
  path.join(baseline, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
fs.writeFileSync(
  path.join(baseline, 'receipt.json'),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
for (const artifact of manifest.artifacts || []) {
  const relative = String(artifact.path || '');
  safeArtifact(relative);
  const bytes = readArtifact(relative);
  const contentRoot = sha(bytes);
  if (bytes.length !== artifact.size || contentRoot !== artifact.content_root) {
    throw new Error(
      `Documentation Atlas material differs from witness: ${relative}`,
    );
  }
  const baselineTarget = path.join(baseline, ...relative.split('/'));
  fs.mkdirSync(path.dirname(baselineTarget), { recursive: true });
  fs.writeFileSync(baselineTarget, bytes);
  const target = `${path.join(ROOT, bundleRelative, ...relative.split('/'))}.gz`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, zlib.gzipSync(bytes, { level: 9 }));
  console.log(path.relative(ROOT, target).split(path.sep).join('/'));
}
if (parsed.source) {
  fs.writeFileSync(
    path.join(ROOT, '.xinfa', 'product-documentation-pack.json'),
    `${JSON.stringify(selector, null, 2)}\n`,
  );
  console.log('.xinfa/product-documentation-pack.json');
}
