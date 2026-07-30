// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { semanticRoot } from '../framework/project-cut/src/project-cut.mjs';

const DEFAULT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const require = createRequire(import.meta.url);

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function loadAjv2020() {
  try {
    return require('ajv/dist/2020.js').default;
  } catch {
    return null;
  }
}

export function computeProjectCutSettlementRoots(root = DEFAULT_ROOT) {
  const contractPath = 'framework/project-cut/settlement.contract.json';
  const contract = readJson(root, contractPath);
  const files = contract.schemaBundle.files.map((relative) => ({
    path: relative,
    root: semanticRoot(
      readJson(root, path.join('framework/project-cut', relative)),
    ),
  }));
  const schemaRoot = semanticRoot({
    schema: 'project.cut.settlement-schema-bundle/v1',
    files,
  });
  const { contractRoot: _contractRoot, ...preimage } = contract;
  return { contract, files, schemaRoot, contractRoot: semanticRoot(preimage) };
}

export function checkProjectCutSettlementContract(root = DEFAULT_ROOT) {
  const roots = computeProjectCutSettlementRoots(root);
  if (roots.contract.schemaBundle.schemaRoot !== roots.schemaRoot)
    throw new Error(
      `settlement schema root mismatch: expected ${roots.contract.schemaBundle.schemaRoot}, got ${roots.schemaRoot}`,
    );
  if (roots.contract.contractRoot !== roots.contractRoot)
    throw new Error(
      `settlement contract root mismatch: expected ${roots.contract.contractRoot}, got ${roots.contractRoot}`,
    );
  if (
    roots.contract.mutationBoundary.commitOwnedByCaller !== true ||
    roots.contract.mutationBoundary.pushOwnedByCaller !== true ||
    roots.contract.mutationBoundary.hookOwnsAuthority !== false
  )
    throw new Error('settlement mutation and hook authority boundary drifted');

  const Ajv2020 = loadAjv2020();
  if (Ajv2020) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    for (const relative of roots.contract.schemaBundle.files)
      ajv.compile(readJson(root, path.join('framework/project-cut', relative)));
  }
  return {
    schemaRoot: roots.schemaRoot,
    contractRoot: roots.contractRoot,
    schemaFiles: roots.files.length,
    schemaValidation: Ajv2020 ? 'compiled' : 'skipped',
  };
}
