// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../framework/project-cut/src/project-cut.mjs';
import { legacyAtlasRoots } from './backfill-legacy-atlas-roots.mjs';

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function xinfaRoot(value) {
  return `sha256:${sha(Buffer.from(`${canonicalJson(value)}\n`, 'utf8'))}`;
}

function hexRoot(fill) {
  return `sha256:${fill.repeat(64)}`;
}

const BODY_ROOTS = {
  context_pack: hexRoot('c'),
  cut: hexRoot('1'),
  semantic: hexRoot('2'),
  source: hexRoot('3'),
};

// Builds one fully self-consistent baseline: canonical Atlas body, manifest
// enumerating its exact bytes, passing receipt, and a legacy promotion (no
// atlasRoots) binding the manifest and receipt roots.
function writeBaseline(root, { bodyRoots = BODY_ROOTS, atlasRoot } = {}) {
  const atlasPreimage = { schema: 'xinfa.atlas/v1', roots: bodyRoots };
  const resolvedAtlasRoot = atlasRoot ?? xinfaRoot(atlasPreimage);
  const atlas = { ...atlasPreimage, atlas_root: resolvedAtlasRoot };
  const atlasBytes = `${JSON.stringify(atlas, null, 2)}\n`;
  const manifestPreimage = {
    schema: 'xinfa.atlas-manifest/v1',
    atlas_root: resolvedAtlasRoot,
    context_pack_root: bodyRoots.context_pack,
    artifacts: [
      { path: 'atlas.json', content_root: `sha256:${sha(atlasBytes)}` },
    ],
  };
  const manifest = {
    ...manifestPreimage,
    manifest_root: xinfaRoot(manifestPreimage),
  };
  const receiptPreimage = {
    schema: 'xinfa.atlas-compile-receipt/v1',
    verdict: 'pass',
    atlas_root: resolvedAtlasRoot,
    manifest_root: manifest.manifest_root,
  };
  const receipt = {
    ...receiptPreimage,
    receipt_root: xinfaRoot(receiptPreimage),
  };
  const promotionPreimage = {
    schema: 'project.cut.atlas-promotion/v1',
    atlasRoot: resolvedAtlasRoot,
    manifestRoot: manifest.manifest_root,
    receiptRoot: receipt.receipt_root,
  };
  const promotion = {
    ...promotionPreimage,
    promotionRoot: `sha256:${sha(Buffer.from(canonicalJson(promotionPreimage), 'utf8'))}`,
  };
  const hex = resolvedAtlasRoot.slice('sha256:'.length);
  const baseline = path.join(root, '.xinfa', 'baselines', 'sha256', hex);
  const promotions = path.join(root, '.xinfa', 'manifests', 'project-cuts');
  fs.mkdirSync(baseline, { recursive: true });
  fs.mkdirSync(promotions, { recursive: true });
  fs.writeFileSync(path.join(baseline, 'atlas.json'), atlasBytes);
  fs.writeFileSync(
    path.join(baseline, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(baseline, 'receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(promotions, `${hex}.json`),
    `${JSON.stringify(promotion, null, 2)}\n`,
  );
  return { atlasRoot: resolvedAtlasRoot, baseline, promotions, hex };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-backfill-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('generator freezes roots from a verified legacy baseline', (t) => {
  const root = fixture(t);
  const { atlasRoot } = writeBaseline(root);
  const backfill = legacyAtlasRoots(root);
  assert.equal(backfill.schema, 'xinfa.legacy-atlas-roots/v1');
  assert.deepEqual(backfill.entries[atlasRoot], {
    contextPack: BODY_ROOTS.context_pack,
    cut: BODY_ROOTS.cut,
    semantic: BODY_ROOTS.semantic,
    source: BODY_ROOTS.source,
  });
});

test('a self-consistent rehash of an edited Atlas body is rejected', (t) => {
  // Adversary edits atlas.roots.semantic while keeping atlas_root, then
  // rehashes the manifest, receipt, and promotion so every downstream
  // binding is self-consistent. Only canonical atlas_root recomputation
  // from the body preimage can catch this; the generator must fail closed.
  const root = fixture(t);
  const { atlasRoot } = writeBaseline(root);
  const forged = fixture(t);
  writeBaseline(forged, {
    bodyRoots: { ...BODY_ROOTS, semantic: hexRoot('9') },
    atlasRoot,
  });
  fs.rmSync(path.join(root, '.xinfa'), { recursive: true, force: true });
  fs.cpSync(path.join(forged, '.xinfa'), path.join(root, '.xinfa'), {
    recursive: true,
  });
  assert.throws(
    () => legacyAtlasRoots(root),
    /canonical atlas_root recomputation/,
  );
});

test('a promotion that does not bind the manifest is rejected', (t) => {
  const root = fixture(t);
  const { promotions, hex } = writeBaseline(root);
  const file = path.join(promotions, `${hex}.json`);
  const promotion = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { promotionRoot: _stale, ...preimage } = promotion;
  preimage.manifestRoot = hexRoot('9');
  const forged = {
    ...preimage,
    promotionRoot: `sha256:${sha(Buffer.from(canonicalJson(preimage), 'utf8'))}`,
  };
  fs.writeFileSync(file, `${JSON.stringify(forged, null, 2)}\n`);
  assert.throws(
    () => legacyAtlasRoots(root),
    /promotion fails witness verification/,
  );
});

test('a failing receipt is rejected', (t) => {
  const root = fixture(t);
  const { baseline } = writeBaseline(root);
  const file = path.join(baseline, 'receipt.json');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { receipt_root: _stale, ...preimage } = receipt;
  preimage.verdict = 'fail';
  const forged = { ...preimage, receipt_root: xinfaRoot(preimage) };
  fs.writeFileSync(file, `${JSON.stringify(forged, null, 2)}\n`);
  assert.throws(
    () => legacyAtlasRoots(root),
    /receipt fails witness verification/,
  );
});

test('promotions with sealed atlasRoots are excluded from the legacy set', (t) => {
  const root = fixture(t);
  const { atlasRoot, promotions, hex } = writeBaseline(root);
  const file = path.join(promotions, `${hex}.json`);
  const promotion = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { promotionRoot: _stale, ...preimage } = promotion;
  preimage.atlasRoots = {
    contextPack: BODY_ROOTS.context_pack,
    cut: BODY_ROOTS.cut,
    semantic: BODY_ROOTS.semantic,
    source: BODY_ROOTS.source,
  };
  const sealed = {
    ...preimage,
    promotionRoot: `sha256:${sha(Buffer.from(canonicalJson(preimage), 'utf8'))}`,
  };
  fs.writeFileSync(file, `${JSON.stringify(sealed, null, 2)}\n`);
  const backfill = legacyAtlasRoots(root);
  assert.equal(backfill.entries[atlasRoot], undefined);
});
