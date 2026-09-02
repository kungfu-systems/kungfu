// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { semanticRoot } from '../framework/project-cut/index.mjs';

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

export function computeProjectCutHistoryRoots(root = DEFAULT_ROOT) {
  const contractPath = 'framework/project-cut/history.contract.json';
  const contract = readJson(root, contractPath);
  const files = contract.schemaBundle.files.map((relative) => ({
    path: relative,
    root: semanticRoot(
      readJson(root, path.join('framework/project-cut', relative)),
    ),
  }));
  const schemaRoot = semanticRoot({
    schema: 'project.cut.history-schema-bundle/v1',
    files,
  });
  const { contractRoot: _contractRoot, ...preimage } = contract;
  return { contract, files, schemaRoot, contractRoot: semanticRoot(preimage) };
}

export function checkProjectCutHistoryContract(root = DEFAULT_ROOT) {
  const roots = computeProjectCutHistoryRoots(root);
  if (roots.contract.schemaBundle.schemaRoot !== roots.schemaRoot)
    throw new Error(
      `history schema root mismatch: expected ${roots.contract.schemaBundle.schemaRoot}, got ${roots.schemaRoot}`,
    );
  if (roots.contract.contractRoot !== roots.contractRoot)
    throw new Error(
      `history contract root mismatch: expected ${roots.contract.contractRoot}, got ${roots.contractRoot}`,
    );
  if (
    roots.contract.cutCompatibility.rootPreimageUnchanged !== true ||
    roots.contract.cutCompatibility.gitObjectIdsExcluded !== true ||
    roots.contract.coordination.globalLock !== false ||
    roots.contract.coordination.ancestryIsCausalAuthority !== false
  )
    throw new Error('Project Cut or Git authority boundary drifted');

  const Ajv2020 = loadAjv2020();
  if (Ajv2020) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const schemas = roots.contract.schemaBundle.files.map((relative) =>
      readJson(root, path.join('framework/project-cut', relative)),
    );
    for (const schema of schemas) ajv.addSchema(schema);
    for (const schema of schemas) ajv.getSchema(schema.$id);
  }
  return {
    schemaRoot: roots.schemaRoot,
    contractRoot: roots.contractRoot,
    schemaFiles: roots.files.length,
    schemaValidation: Ajv2020 ? 'compiled' : 'skipped',
  };
}
