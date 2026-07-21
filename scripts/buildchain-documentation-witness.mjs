#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../framework/project-cut/src/project-cut.mjs';

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
// tracked witness before trusting them (ADR-0130). The manifest and receipt
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
    if (!artifact)
      throw new Error(`baseline manifest does not enumerate ${artifactPath}`);
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
  // local material is present. In a witness-only checkout (ADR-0130) they
  // fall back to the tracked witness, whose atlas_root binding proves those
  // roots were extracted from the exact body bytes the manifest enumerates.
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
    const tracked = fs.existsSync(OUTPUT)
      ? JSON.parse(fs.readFileSync(OUTPUT, 'utf8'))
      : null;
    const roots = tracked?.documentationRoots ?? {};
    if (
      roots.atlasRoot !== manifest.atlas_root ||
      roots.packRoot !== manifest.context_pack_root ||
      roots.manifestRoot !== manifest.manifest_root ||
      roots.compileReceiptRoot !== receipt.receipt_root ||
      typeof roots.cutRoot !== 'string' ||
      typeof roots.claimGraphRoot !== 'string' ||
      typeof tracked?.sourceBinding?.xinfaSourceRoot !== 'string'
    )
      throw new Error(
        `atlas-material-missing: ${atlasPath} is absent and the tracked witness does not bind this baseline`,
      );
    bodyRoots = {
      packRoot: roots.packRoot,
      cutRoot: roots.cutRoot,
      claimGraphRoot: roots.claimGraphRoot,
      xinfaSourceRoot: tracked.sourceBinding.xinfaSourceRoot,
    };
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
