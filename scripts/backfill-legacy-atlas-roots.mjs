#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

// Settlement promotions written before the atlasRoots projection existed do
// not seal body-derived semantic roots into the Project Cut chain, so a
// witness-only checkout (ADR-0133) has no authenticated source for them. This
// generator extracts those roots from verified local Atlas material exactly
// once and freezes them in .xinfa/manifests/legacy-atlas-roots.json, whose
// digest the KFD-1 witness builder pins. The legacy set is closed: promotions
// created after the projection carry their own sealed atlasRoots and must
// never appear here.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canonicalJson } from '../framework/project-cut/src/project-cut.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(
  ROOT,
  '.xinfa',
  'manifests',
  'legacy-atlas-roots.json',
);
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** @param {Buffer|string} value */
function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** @param {object} value */
function xinfaRoot(value) {
  return `sha256:${sha(Buffer.from(`${canonicalJson(value)}\n`, 'utf8'))}`;
}

// Every consumed byte must verify against the tracked witness chain before
// its roots are frozen: the promotion by promotionRoot recomputation and its
// manifest/receipt bindings, the manifest and receipt by semantic-root
// recomputation and atlas_root binding, the Atlas body by its enumerated
// content root AND canonical atlas_root recomputation from its own preimage,
// and the body's embedded roots by their manifest bindings. The canonical
// recomputation is what stops a self-consistent but unpromoted Atlas (edited
// roots with a rehashed manifest) from freezing forged values.
function verifiedLegacyRoots(root, atlasRootHex, promotion) {
  const atlasRoot = `sha256:${atlasRootHex}`;
  const baseline = path.join(
    root,
    '.xinfa',
    'baselines',
    'sha256',
    atlasRootHex,
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(baseline, 'manifest.json'), 'utf8'),
  );
  const { manifest_root: manifestRoot, ...manifestPreimage } = manifest;
  if (
    manifest.schema !== 'xinfa.atlas-manifest/v1' ||
    xinfaRoot(manifestPreimage) !== manifestRoot ||
    manifest.atlas_root !== atlasRoot
  )
    throw new Error(
      `baseline manifest fails witness verification: ${atlasRoot}`,
    );
  const receipt = JSON.parse(
    fs.readFileSync(path.join(baseline, 'receipt.json'), 'utf8'),
  );
  const { receipt_root: receiptRoot, ...receiptPreimage } = receipt;
  if (
    receipt.schema !== 'xinfa.atlas-compile-receipt/v1' ||
    xinfaRoot(receiptPreimage) !== receiptRoot ||
    receipt.verdict !== 'pass' ||
    receipt.atlas_root !== atlasRoot ||
    receipt.manifest_root !== manifestRoot
  )
    throw new Error(
      `baseline receipt fails witness verification: ${atlasRoot}`,
    );
  const { promotionRoot, ...promotionPreimage } = promotion;
  if (
    `sha256:${sha(Buffer.from(canonicalJson(promotionPreimage), 'utf8'))}` !==
      promotionRoot ||
    promotion.manifestRoot !== manifestRoot ||
    promotion.receiptRoot !== receiptRoot
  )
    throw new Error(
      `baseline promotion fails witness verification: ${atlasRoot}`,
    );
  const artifact = (manifest.artifacts ?? []).find(
    (entry) => entry.path === 'atlas.json',
  );
  if (!artifact || !ROOT_PATTERN.test(String(artifact.content_root)))
    throw new Error(
      `baseline manifest does not enumerate a well-formed root for atlas.json: ${atlasRoot}`,
    );
  const atlasBytes = fs.readFileSync(path.join(baseline, 'atlas.json'));
  if (`sha256:${sha(atlasBytes)}` !== artifact.content_root)
    throw new Error(
      `baseline material differs from its tracked witness: ${atlasRoot}`,
    );
  const atlas = JSON.parse(atlasBytes.toString('utf8'));
  const { atlas_root: _atlasRoot, ...atlasPreimage } = atlas;
  if (atlas.atlas_root !== atlasRoot || xinfaRoot(atlasPreimage) !== atlasRoot)
    throw new Error(
      `baseline material fails canonical atlas_root recomputation: ${atlasRoot}`,
    );
  const roots = {
    contextPack: atlas.roots?.context_pack,
    cut: atlas.roots?.cut,
    semantic: atlas.roots?.semantic,
    source: atlas.roots?.source,
  };
  if (
    roots.contextPack !== manifest.context_pack_root ||
    Object.values(roots).some(
      (value) => !ROOT_PATTERN.test(String(value ?? '')),
    )
  )
    throw new Error(
      `baseline material contradicts its tracked witness: ${atlasRoot}`,
    );
  return roots;
}

export function legacyAtlasRoots(root = ROOT) {
  const promotions = path.join(root, '.xinfa', 'manifests', 'project-cuts');
  const entries = {};
  for (const file of fs.readdirSync(promotions).sort()) {
    if (!file.endsWith('.json')) continue;
    const promotion = JSON.parse(
      fs.readFileSync(path.join(promotions, file), 'utf8'),
    );
    if (promotion.schema !== 'project.cut.atlas-promotion/v1')
      throw new Error(`unexpected promotion schema in ${file}`);
    if (promotion.atlasRoots !== undefined) continue;
    const atlasRootHex = file.slice(0, -'.json'.length);
    if (promotion.atlasRoot !== `sha256:${atlasRootHex}`)
      throw new Error(`promotion path contradicts its atlasRoot: ${file}`);
    entries[promotion.atlasRoot] = verifiedLegacyRoots(
      root,
      atlasRootHex,
      promotion,
    );
  }
  return {
    schema: 'xinfa.legacy-atlas-roots/v1',
    description:
      'Body-derived semantic roots for settlement promotions that predate the sealed atlasRoots projection (ADR-0133), extracted once from verified local Atlas material. This set is closed; the KFD-1 witness builder pins its digest.',
    entries,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const expected = `${JSON.stringify(legacyAtlasRoots(), null, 2)}\n`;
  const digest = `sha256:${sha(expected)}`;
  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUTPUT, expected);
    process.stdout.write(
      `${path.relative(ROOT, OUTPUT)} updated (${digest})\n`,
    );
  } else if (process.argv.includes('--check')) {
    const actual = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
    if (actual !== expected) {
      process.stderr.write(
        'legacy Atlas roots backfill is stale; run with --write\n',
      );
      process.exit(1);
    }
    process.stdout.write(`legacy Atlas roots backfill current (${digest})\n`);
  } else {
    process.stdout.write(expected);
  }
}
