// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';

export const BUILDCHAIN_KFD1_CONTRACT_WORLD_WITNESS_PATH =
  '.buildchain/kfd/kfd-1/contract-world.witness.json';
export const BUILDCHAIN_KFD1_RELEASE_GATE_PATH =
  '.buildchain/kfd/kfd-1/release-gate.json';
export const BUILDCHAIN_KFD1_VERIFY_RESULT_PATH =
  '.buildchain/kfd/kfd-1/verify-result.json';
export const BUILDCHAIN_KFD2_DIR = '.buildchain/kfd/kfd-2';
export const BUILDCHAIN_KFD2_REGISTRY_PATH =
  '.buildchain/kfd/kfd-2/registry.json';
export const BUILDCHAIN_KFD3_DIR = '.buildchain/kfd/kfd-3';
export const KFD3_DEFAULT_REGISTRY_PATH = '.buildchain/kfd/kfd-3/surfaces.json';

export async function loadBuildchainKfdRuntime() {
  try {
    const [{ kfd1, kfd2, kfd3 }, productGates] = await Promise.all([
      import('@kungfu-tech/buildchain-alpha/kfd'),
      import('@kungfu-tech/buildchain-alpha/kfd-product-gates'),
    ]);
    return { kfd1, kfd2, kfd3, productGates };
  } catch (error) {
    if (
      error &&
      error.code === 'ERR_MODULE_NOT_FOUND' &&
      String(error.message).includes('@kungfu-tech/buildchain-alpha')
    )
      return null;
    throw error;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function assertPair(root, source, projection) {
  const sourceFile = path.join(root, source);
  const projectionFile = path.join(root, projection);
  if (!fs.existsSync(sourceFile) || !fs.existsSync(projectionFile))
    throw new Error(
      `cold KFD projection is missing: ${source} -> ${projection}`,
    );
  if (!fs.readFileSync(sourceFile).equals(fs.readFileSync(projectionFile)))
    throw new Error(`cold KFD projection differs: ${source} -> ${projection}`);
}

export function checkColdBuildchainKfd(root) {
  const pairs = [
    [
      BUILDCHAIN_KFD1_CONTRACT_WORLD_WITNESS_PATH,
      'developer/sdk/kfd/kfd-1/contract-world.witness.json',
    ],
    [
      BUILDCHAIN_KFD1_RELEASE_GATE_PATH,
      'developer/sdk/kfd/kfd-1/release-gate.json',
    ],
    [
      BUILDCHAIN_KFD1_VERIFY_RESULT_PATH,
      'developer/sdk/kfd/kfd-1/verify-result.json',
    ],
    [KFD3_DEFAULT_REGISTRY_PATH, 'developer/sdk/kfd/kfd-3-surfaces.json'],
    [
      '.buildchain/kfd/kfd-2/release-claims.json',
      'developer/sdk/kfd/kfd-2/release-claims.json',
    ],
    [
      '.buildchain/kfd/support-matrix.json',
      'developer/sdk/kfd/support-matrix.json',
    ],
  ];
  const claimsDir = path.join(root, BUILDCHAIN_KFD2_DIR, 'claims');
  for (const name of fs
    .readdirSync(claimsDir)
    .filter((value) => value.endsWith('.json'))
    .sort())
    pairs.push([
      `${BUILDCHAIN_KFD2_DIR}/claims/${name}`,
      `developer/sdk/kfd/kfd-2/claims/${name}`,
    ]);
  for (const pair of pairs) assertPair(root, ...pair);
  for (const base of [BUILDCHAIN_KFD2_DIR, 'developer/sdk/kfd/kfd-2']) {
    const args = fs
      .readFileSync(path.join(root, base, 'buildchain-claim-args.txt'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.replace(`--kfd-2-claim-json ${base}/claims/`, ''))
      .sort();
    const claims = fs
      .readdirSync(path.join(root, base, 'claims'))
      .filter((name) => name.endsWith('.json'))
      .sort();
    if (JSON.stringify(args) !== JSON.stringify(claims))
      throw new Error(`cold KFD-2 claim arguments differ from ${base}/claims`);
  }

  const verify = readJson(path.join(root, BUILDCHAIN_KFD1_VERIFY_RESULT_PATH));
  if (
    verify.contract !== 'kungfu-buildchain-kfd-1-verify-result' ||
    verify.ok !== true ||
    !Array.isArray(verify.issues) ||
    verify.issues.length !== 0
  )
    throw new Error('cold KFD-1 verify result is not qualifying');
  const registry = readJson(path.join(root, KFD3_DEFAULT_REGISTRY_PATH));
  if (
    registry.contract !== 'kungfu-buildchain-kfd-3-surface-registry' ||
    !Array.isArray(registry.surfaces) ||
    registry.surfaces.length === 0
  )
    throw new Error('cold KFD-3 registry is not a closed non-empty projection');
  const aggregate = readJson(
    path.join(root, 'developer/sdk/kfd/upstream-aggregate.json'),
  );
  if (
    aggregate.contract !== 'kungfu-upstream-kfd-aggregate' ||
    !Array.isArray(aggregate.upstreams)
  )
    throw new Error('cold KFD upstream aggregate is invalid');
  const lockPath = path.join(root, '.buildchain/alpha-contract-lock.json');
  const lock = readJson(lockPath);
  if (
    lock?.buildchain?.ref !== 'v3-alpha' ||
    !/^[0-9a-f]{40}$/.test(lock?.buildchain?.resolvedSha || '') ||
    !/^sha256:[0-9a-f]{64}$/.test(lock?.buildchain?.contractDigest || '')
  )
    throw new Error('cold KFD check is not bound to the Buildchain alpha lock');
  return {
    ok: true,
    mode: 'cold-source-check',
    buildchainRuntime: 'not-installed',
    contractLock: relative(root, lockPath),
    projectionPairs: pairs.length,
    kfd3Surfaces: registry.surfaces.length,
  };
}
