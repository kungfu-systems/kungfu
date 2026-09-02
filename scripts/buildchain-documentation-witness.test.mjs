// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../framework/project-cut/index.mjs';
import {
  LEGACY_ATLAS_ROOTS_DIGEST,
  LEGACY_ATLAS_ROOTS_PATH,
  witnessOnlyBodyRoots,
} from './buildchain-documentation-witness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function fixture(t, { promotion, backfill } = {}) {
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
  let digest = hexRoot('0');
  if (backfill !== undefined) {
    const bytes = `${JSON.stringify(backfill, null, 2)}\n`;
    const file = path.join(root, LEGACY_ATLAS_ROOTS_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    digest = `sha256:${sha(bytes)}`;
  }
  return { root, digest };
}

test('sealed promotion atlasRoots authenticate witness-only body roots', (t) => {
  const { root, digest } = fixture(t, {
    promotion: sealedPromotion(SEALED_ROOTS),
  });
  assert.deepEqual(
    witnessOnlyBodyRoots(ATLAS_ROOT, MANIFEST, RECEIPT, root, digest),
    {
      packRoot: SEALED_ROOTS.contextPack,
      cutRoot: SEALED_ROOTS.cut,
      claimGraphRoot: SEALED_ROOTS.semantic,
      xinfaSourceRoot: SEALED_ROOTS.source,
    },
  );
});

test('missing promotion fails closed', (t) => {
  const { root, digest } = fixture(t, {});
  assert.throws(
    () => witnessOnlyBodyRoots(ATLAS_ROOT, MANIFEST, RECEIPT, root, digest),
    /settlement promotion is missing/,
  );
});

test('tampered promotion fails witness verification', (t) => {
  const promotion = sealedPromotion(SEALED_ROOTS);
  promotion.atlasRoots = { ...SEALED_ROOTS, cut: hexRoot('9') };
  const { root, digest } = fixture(t, { promotion });
  assert.throws(
    () => witnessOnlyBodyRoots(ATLAS_ROOT, MANIFEST, RECEIPT, root, digest),
    /promotion fails witness verification/,
  );
});

test('sealed promotion with malformed semantic root fails closed', (t) => {
  const { root, digest } = fixture(t, {
    promotion: sealedPromotion({ ...SEALED_ROOTS, source: 'sha256:short' }),
  });
  assert.throws(
    () => witnessOnlyBodyRoots(ATLAS_ROOT, MANIFEST, RECEIPT, root, digest),
    /promotion fails witness verification/,
  );
});

test('legacy promotion resolves through the digest-pinned backfill', (t) => {
  const { root, digest } = fixture(t, {
    promotion: sealedPromotion(undefined),
    backfill: {
      schema: 'xinfa.legacy-atlas-roots/v1',
      entries: { [ATLAS_ROOT]: SEALED_ROOTS },
    },
  });
  assert.deepEqual(
    witnessOnlyBodyRoots(ATLAS_ROOT, MANIFEST, RECEIPT, root, digest),
    {
      packRoot: SEALED_ROOTS.contextPack,
      cutRoot: SEALED_ROOTS.cut,
      claimGraphRoot: SEALED_ROOTS.semantic,
      xinfaSourceRoot: SEALED_ROOTS.source,
    },
  );
});

test('tampered backfill fails digest verification', (t) => {
  const { root, digest } = fixture(t, {
    promotion: sealedPromotion(undefined),
    backfill: {
      schema: 'xinfa.legacy-atlas-roots/v1',
      entries: { [ATLAS_ROOT]: SEALED_ROOTS },
    },
  });
  const file = path.join(root, LEGACY_ATLAS_ROOTS_PATH);
  const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
  tampered.entries[ATLAS_ROOT].cut = hexRoot('9');
  fs.writeFileSync(file, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.throws(
    () => witnessOnlyBodyRoots(ATLAS_ROOT, MANIFEST, RECEIPT, root, digest),
    /backfill fails digest verification/,
  );
});

test('missing backfill file fails digest verification', (t) => {
  const { root } = fixture(t, { promotion: sealedPromotion(undefined) });
  assert.throws(
    () =>
      witnessOnlyBodyRoots(ATLAS_ROOT, MANIFEST, RECEIPT, root, hexRoot('0')),
    /backfill fails digest verification/,
  );
});

test('legacy promotion without a backfill entry fails closed', (t) => {
  const { root, digest } = fixture(t, {
    promotion: sealedPromotion(undefined),
    backfill: { schema: 'xinfa.legacy-atlas-roots/v1', entries: {} },
  });
  assert.throws(
    () => witnessOnlyBodyRoots(ATLAS_ROOT, MANIFEST, RECEIPT, root, digest),
    /no authenticated source binds its semantic roots/,
  );
});

test('backfill entry contradicting the manifest fails closed', (t) => {
  const { root, digest } = fixture(t, {
    promotion: sealedPromotion(undefined),
    backfill: {
      schema: 'xinfa.legacy-atlas-roots/v1',
      entries: { [ATLAS_ROOT]: { ...SEALED_ROOTS, contextPack: hexRoot('9') } },
    },
  });
  assert.throws(
    () => witnessOnlyBodyRoots(ATLAS_ROOT, MANIFEST, RECEIPT, root, digest),
    /backfill contradicts the tracked witness/,
  );
});

test('tracked legacy backfill matches the pinned digest', () => {
  const bytes = fs.readFileSync(path.join(REPO, LEGACY_ATLAS_ROOTS_PATH));
  assert.equal(`sha256:${sha(bytes)}`, LEGACY_ATLAS_ROOTS_DIGEST);
  const backfill = JSON.parse(bytes.toString('utf8'));
  assert.equal(backfill.schema, 'xinfa.legacy-atlas-roots/v1');
  const pattern = /^sha256:[0-9a-f]{64}$/;
  for (const [atlasRoot, roots] of Object.entries(backfill.entries)) {
    assert.match(atlasRoot, pattern);
    for (const key of ['contextPack', 'cut', 'semantic', 'source'])
      assert.match(String(roots[key]), pattern, `${atlasRoot} ${key}`);
  }
});
