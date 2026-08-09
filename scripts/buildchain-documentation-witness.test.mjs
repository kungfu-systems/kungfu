// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../framework/project-cut/src/project-cut.mjs';
import { witnessOnlyBodyRoots } from './buildchain-documentation-witness.mjs';

function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hexRoot(fill) {
  return `sha256:${fill.repeat(64)}`;
}

const ATLAS_ROOT = hexRoot('a');
const MANIFEST = {
  atlas_root: ATLAS_ROOT,
  manifest_root: hexRoot('b'),
  context_pack_root: hexRoot('c'),
};
const RECEIPT = { receipt_root: hexRoot('d') };
const SEALED_ROOTS = {
  contextPack: MANIFEST.context_pack_root,
  cut: hexRoot('1'),
  semantic: hexRoot('2'),
  source: hexRoot('3'),
};

function sealedPromotion(atlasRoots) {
  const preimage = {
    schema: 'project.cut.atlas-promotion/v1',
    atlasRoot: ATLAS_ROOT,
    manifestRoot: MANIFEST.manifest_root,
    receiptRoot: RECEIPT.receipt_root,
    ...(atlasRoots === undefined ? {} : { atlasRoots }),
  };
  return {
    ...preimage,
    promotionRoot: `sha256:${sha(Buffer.from(canonicalJson(preimage), 'utf8'))}`,
  };
}

function fixture(t, { promotion } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kfd-witness-roots-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (promotion !== undefined) {
    const file = path.join(
      root,
      '.xinfa',
      'manifests',
      'project-cuts',
      `${ATLAS_ROOT.slice('sha256:'.length)}.json`,
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(promotion, null, 2)}\n`);
  }
  return { root };
}

test('sealed promotion atlasRoots authenticate witness-only body roots', (t) => {
  const { root } = fixture(t, {
    promotion: sealedPromotion(SEALED_ROOTS),
  });
  assert.deepEqual(witnessOnlyBodyRoots(ATLAS_ROOT, MANIFEST, RECEIPT, root), {
    packRoot: SEALED_ROOTS.contextPack,
    cutRoot: SEALED_ROOTS.cut,
    claimGraphRoot: SEALED_ROOTS.semantic,
    xinfaSourceRoot: SEALED_ROOTS.source,
  });
});

test('missing promotion fails closed', (t) => {
  const { root } = fixture(t, {});
  assert.throws(
    () => witnessOnlyBodyRoots(ATLAS_ROOT, MANIFEST, RECEIPT, root),
    /settlement promotion is missing/,
  );
});

test('tampered promotion fails witness verification', (t) => {
  const promotion = sealedPromotion(SEALED_ROOTS);
  promotion.atlasRoots = { ...SEALED_ROOTS, cut: hexRoot('9') };
  const { root } = fixture(t, { promotion });
  assert.throws(
    () => witnessOnlyBodyRoots(ATLAS_ROOT, MANIFEST, RECEIPT, root),
    /promotion fails witness verification/,
  );
});

test('sealed promotion with malformed semantic root fails closed', (t) => {
  const { root } = fixture(t, {
    promotion: sealedPromotion({ ...SEALED_ROOTS, source: 'sha256:short' }),
  });
  assert.throws(
    () => witnessOnlyBodyRoots(ATLAS_ROOT, MANIFEST, RECEIPT, root),
    /promotion fails witness verification/,
  );
});

test('promotion without sealed semantic roots fails closed', (t) => {
  const { root } = fixture(t, { promotion: sealedPromotion(undefined) });
  assert.throws(
    () => witnessOnlyBodyRoots(ATLAS_ROOT, MANIFEST, RECEIPT, root),
    /does not seal semantic roots/,
  );
});
