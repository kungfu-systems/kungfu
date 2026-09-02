#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../framework/project-cut/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(
  ROOT,
  '.buildchain',
  'kfd',
  'kfd-1',
  'documentation-pack.witness.json',
);

/** @param {Buffer|string} value */
function sha(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** @param {string} reference */
function read(reference) {
  return fs.readFileSync(path.join(ROOT, reference));
}

/** @param {object} value */
function xinfaRoot(value) {
  return `sha256:${sha(Buffer.from(`${canonicalJson(value)}\n`, 'utf8'))}`;
}

// Every consumer of baseline material must verify the bytes against the
// tracked witness before trusting them (KF-ADR-019f86da-4f90-7089-b9b1-e070edf7d540). The manifest and receipt
// are verified by semantic-root recomputation; each consumed body must match
// its enumerated content root.
function verifiedBaseline(relative, atlasRoot) {
  const manifest = JSON.parse(
    read(`${relative}/manifest.json`).toString('utf8'),
  );
  const { manifest_root: manifestRoot, ...manifestPreimage } = manifest;
  if (
    manifest.schema !== 'xinfa.atlas-manifest/v1' ||
    xinfaRoot(manifestPreimage) !== manifestRoot ||
    manifest.atlas_root !== atlasRoot
  )
    throw new Error(
      `baseline manifest fails witness verification: ${relative}`,
    );
  const receipt = JSON.parse(read(`${relative}/receipt.json`).toString('utf8'));
  const { receipt_root: receiptRoot, ...receiptPreimage } = receipt;
  if (
    receipt.schema !== 'xinfa.atlas-compile-receipt/v1' ||
    xinfaRoot(receiptPreimage) !== receiptRoot ||
    receipt.verdict !== 'pass' ||
    receipt.atlas_root !== atlasRoot ||
    receipt.manifest_root !== manifestRoot
  )
    throw new Error(`baseline receipt fails witness verification: ${relative}`);
  /** @param {string} artifactPath */
  const verifiedRead = (artifactPath) => {
    const artifact = (manifest.artifacts ?? []).find(
      (entry) => entry.path === artifactPath,
    );
    if (!artifact)
      throw new Error(`baseline manifest does not enumerate ${artifactPath}`);
    const bytes = read(`${relative}/${artifactPath}`);
    if (`sha256:${sha(bytes)}` !== artifact.content_root)
      throw new Error(
        `baseline material differs from its tracked witness: ${relative}/${artifactPath}`,
      );
    return bytes;
  };
  /** @param {string} artifactPath */
  const verifiedReadIfPresent = (artifactPath) => {
    if (!fs.existsSync(path.join(ROOT, `${relative}/${artifactPath}`)))
      return null;
    return verifiedRead(artifactPath);
  };
  /** @param {string} artifactPath */
  const artifactContentSha = (artifactPath) => {
    const artifact = (manifest.artifacts ?? []).find(
      (entry) => entry.path === artifactPath,
    );
    if (
      !artifact ||
      !/^sha256:[0-9a-f]{64}$/.test(String(artifact.content_root))
    )
      throw new Error(
        `baseline manifest does not enumerate a well-formed root for ${artifactPath}`,
      );
    return String(artifact.content_root).slice('sha256:'.length);
  };
  return {
    manifest,
    receipt,
    verifiedRead,
    verifiedReadIfPresent,
    artifactContentSha,
  };
}

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/;

// Digest of .xinfa/manifests/legacy-atlas-roots.json, the closed backfill of
// body-derived semantic roots for promotions that predate the sealed
// atlasRoots projection (KF-ADR-019f86da-4f90-7089-b9b1-e070edf7d540). Pinning the exact bytes here makes the
// legacy exception bounded and fail-closed: the backfill cannot grow or drift
// without changing reviewed code. Regenerate only via
// scripts/backfill-legacy-atlas-roots.mjs against verified local material.
export const LEGACY_ATLAS_ROOTS_PATH =
  '.xinfa/manifests/legacy-atlas-roots.json';
export const LEGACY_ATLAS_ROOTS_DIGEST =
  'sha256:aa1423056aae530196695f7030a507eef5c52c3f14f86dd38024b80389da9f2b';

// Body-derived semantic roots for a witness-only checkout (KF-ADR-019f86da-4f90-7089-b9b1-e070edf7d540). The
// authoritative source is the tracked settlement promotion, whose
// promotionRoot seals the atlasRoots projection into the Project Cut chain.
// The promotion must exist: its absence fails closed rather than falling
// back to any weaker source. Promotions written before the projection
// existed resolve through the digest-pinned legacy backfill, whose roots
// were extracted once from verified local material; the KFD-1 witness is
// never consulted for its own inputs.
export function witnessOnlyBodyRoots(
  atlasRoot,
  manifest,
  receipt,
  root = ROOT,
  legacyDigest = LEGACY_ATLAS_ROOTS_DIGEST,
) {
  const promotionPath = `.xinfa/manifests/project-cuts/${atlasRoot.slice('sha256:'.length)}.json`;
  if (!fs.existsSync(path.join(root, promotionPath)))
    throw new Error(
      `atlas-material-missing: Atlas material for ${atlasRoot} is absent and its tracked settlement promotion is missing: ${promotionPath}`,
    );
  const promotion = JSON.parse(
    fs.readFileSync(path.join(root, promotionPath), 'utf8'),
  );
  const { promotionRoot, ...preimage } = promotion;
  if (
    promotion.schema !== 'project.cut.atlas-promotion/v1' ||
    `sha256:${sha(Buffer.from(canonicalJson(preimage), 'utf8'))}` !==
      promotionRoot ||
    promotion.atlasRoot !== manifest.atlas_root ||
    promotion.manifestRoot !== manifest.manifest_root ||
    promotion.receiptRoot !== receipt.receipt_root
  )
    throw new Error(
      `baseline promotion fails witness verification: ${promotionPath}`,
    );
  const promoted = promotion.atlasRoots;
  if (promoted !== undefined) {
    if (
      [
        promoted?.contextPack,
        promoted?.cut,
        promoted?.semantic,
        promoted?.source,
      ].some((value) => !ROOT_PATTERN.test(String(value ?? ''))) ||
      promoted.contextPack !== manifest.context_pack_root
    )
      throw new Error(
        `baseline promotion fails witness verification: ${promotionPath}`,
      );
    return {
      packRoot: promoted.contextPack,
      cutRoot: promoted.cut,
      claimGraphRoot: promoted.semantic,
      xinfaSourceRoot: promoted.source,
    };
  }
  const legacyPath = path.join(root, LEGACY_ATLAS_ROOTS_PATH);
  const legacyBytes = fs.existsSync(legacyPath)
    ? fs.readFileSync(legacyPath)
    : null;
  if (legacyBytes === null || `sha256:${sha(legacyBytes)}` !== legacyDigest)
    throw new Error(
      `legacy Atlas roots backfill fails digest verification: ${LEGACY_ATLAS_ROOTS_PATH}`,
    );
  const legacy = JSON.parse(legacyBytes.toString('utf8')).entries?.[atlasRoot];
  if (legacy === undefined)
    throw new Error(
      `atlas-material-missing: Atlas material for ${atlasRoot} is absent and no authenticated source binds its semantic roots`,
    );
  if (
    [legacy?.contextPack, legacy?.cut, legacy?.semantic, legacy?.source].some(
      (value) => !ROOT_PATTERN.test(String(value ?? '')),
    ) ||
    legacy.contextPack !== manifest.context_pack_root
  )
    throw new Error(
      `legacy Atlas roots backfill contradicts the tracked witness for ${atlasRoot}`,
    );
  return {
    packRoot: legacy.contextPack,
    cutRoot: legacy.cut,
    claimGraphRoot: legacy.semantic,
    xinfaSourceRoot: legacy.source,
  };
}

export function documentationWitness() {
  const selectorPath = '.xinfa/product-documentation-pack.json';
  const selector = JSON.parse(read(selectorPath).toString('utf8'));
  const relative = `.xinfa/baselines/sha256/${selector.atlasRoot.slice('sha256:'.length)}`;
  const atlasPath = `${relative}/atlas.json`;
  const manifestPath = `${relative}/manifest.json`;
  const receiptPath = `${relative}/receipt.json`;
  const packPath = `${relative}/compatibility/context-pack-v1/pack.json`;
  const { manifest, receipt, verifiedReadIfPresent, artifactContentSha } =
    verifiedBaseline(relative, selector.atlasRoot);
  const atlasBytes = verifiedReadIfPresent('atlas.json');
  verifiedReadIfPresent('compatibility/context-pack-v1/pack.json');
  // Body-derived semantic roots come from the verified atlas body when the
  // local material is present. In a witness-only checkout (KF-ADR-019f86da-4f90-7089-b9b1-e070edf7d540) they
  // come from an authenticated tracked source: the sealed settlement
  // promotion, or the digest-pinned legacy backfill for older promotions.
  let bodyRoots;
  if (atlasBytes) {
    const atlas = JSON.parse(atlasBytes.toString('utf8'));
    if (
      atlas.atlas_root !== manifest.atlas_root ||
      atlas.roots.context_pack !== manifest.context_pack_root
    )
      throw new Error(
        `baseline material contradicts its tracked witness: ${atlasPath}`,
      );
    bodyRoots = {
      packRoot: atlas.roots.context_pack,
      cutRoot: atlas.roots.cut,
      claimGraphRoot: atlas.roots.semantic,
      xinfaSourceRoot: atlas.roots.source,
    };
  } else {
    bodyRoots = witnessOnlyBodyRoots(selector.atlasRoot, manifest, receipt);
  }
  const qualificationPath =
    'docs/qualification/documentation-control-plane.receipt.json';
  const qualification = JSON.parse(read(qualificationPath).toString('utf8'));
  const surface = (
    name,
    description,
    sourcePath,
    artifactPath,
    sourceSha256 = sha(read(sourcePath)),
  ) => ({
    name,
    class: 'cross-time',
    classes: ['integration-time', 'cross-time'],
    description,
    weldRationale:
      'Buildchain attests exact bytes while Xinfa remains the documentation compiler authority.',
    sourcePath,
    artifactPath,
    sourceSha256,
    expectedSha256: sourceSha256,
    byteForByte: true,
    impactProjection: {
      breaking:
        'root mismatch or missing packaged bytes rejects the old passport',
      additive: 'successor Atlas requires a successor witness and passport',
      none: 'byte-identical artifact retains the declared root',
      unclassifiable: 'fail closed pending a new Xinfa qualification',
    },
  });
  return {
    schemaVersion: 1,
    contract: 'kfd-1-witness',
    id: 'kungfu-documentation-pack',
    standard: 'kfd-1',
    contractWorld: {
      schemaId:
        'https://kfd.libkungfu.dev/schemas/kfd-1/contract-world.schema.json',
      digest:
        'sha256:4c266a6475362f8a95d65102954e0bc7fb5dd8e08b3ff25610ec2c85bcccf7d3',
    },
    compatibilityImpactClasses: [
      'breaking',
      'additive',
      'none',
      'unclassifiable',
    ],
    sourceBinding: {
      mode: 'release-passport-target-sha',
      immutableFullShaRequired: true,
      mutableRefAllowed: false,
      xinfaSourceRoot: bodyRoots.xinfaSourceRoot,
    },
    documentationRoots: {
      atlasRoot: manifest.atlas_root,
      packRoot: bodyRoots.packRoot,
      cutRoot: bodyRoots.cutRoot,
      claimGraphRoot: bodyRoots.claimGraphRoot,
      manifestRoot: manifest.manifest_root,
      compileReceiptRoot: receipt.receipt_root,
      qualificationRoot: qualification.proofRoot,
    },
    responsibility: {
      compiler: 'xinfa',
      orchestration: 'shifu',
      attestation: 'buildchain-release-passport',
      runtime: 'kungfu-read-only',
    },
    replayPolicy: {
      bindTargetSha: true,
      bindArtifactDigest: true,
      requireCurrentQualification: true,
      staleWitness: 'reject',
    },
    surfaces: [
      surface(
        'documentation-atlas',
        'Canonical public Xinfa Documentation Atlas',
        atlasPath,
        'agent/documentation/atlas.json',
        artifactContentSha('atlas.json'),
      ),
      surface(
        'documentation-context-pack',
        'Compatibility Context Pack embedded by the canonical Atlas',
        packPath,
        'agent/documentation/compatibility/context-pack-v1/pack.json',
        artifactContentSha('compatibility/context-pack-v1/pack.json'),
      ),
      surface(
        'documentation-atlas-manifest',
        'Manifest binding every packaged Atlas artifact byte',
        manifestPath,
        'agent/documentation/manifest.json',
      ),
      surface(
        'documentation-pack-selector',
        'Product-owned immutable selector for the shipped Atlas root',
        selectorPath,
        'agent/documentation-selector.json',
      ),
    ],
    evidence: [
      { kind: 'xinfa-atlas-receipt', path: receiptPath },
      { kind: 'product-pack-selector', path: selectorPath },
      {
        kind: 'runtime-verifier',
        path: 'framework/core/src/python/kungfu/agent/documentation.py',
      },
      {
        kind: 'qualification-matrix',
        path: 'docs/qualification/documentation-control-plane.json',
      },
      { kind: 'qualification-receipt', path: qualificationPath },
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const expected = `${JSON.stringify(documentationWitness(), null, 2)}\n`;
  if (process.argv.includes('--write')) {
    fs.writeFileSync(OUTPUT, expected);
    process.stdout.write(`${path.relative(ROOT, OUTPUT)} updated\n`);
  } else if (process.argv.includes('--check')) {
    const actual = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
    if (actual !== expected) {
      process.stderr.write(
        'documentation KFD-1 witness is stale; run with --write\n',
      );
      process.exit(1);
    }
    process.stdout.write('documentation KFD-1 witness current\n');
  } else {
    process.stdout.write(expected);
  }
}
