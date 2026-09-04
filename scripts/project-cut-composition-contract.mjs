// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { semanticRoot } from '../framework/work/project-cut/index.mjs';

const DEFAULT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const PROJECT_CUT_ROOT = 'framework/work/project-cut';
const require = createRequire(import.meta.url);

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

export function computeProjectCutCompositionRoots(root = DEFAULT_ROOT) {
  const contract = readJson(
    root,
    `${PROJECT_CUT_ROOT}/composition.contract.json`,
  );
  const files = contract.schemaBundle.files.map((relative) => ({
    path: relative,
    root: semanticRoot(readJson(root, path.join(PROJECT_CUT_ROOT, relative))),
  }));
  const schemaRoot = semanticRoot({
    schema: 'project.cut.composition-schema-bundle/v1',
    files,
  });
  const { contractRoot: _contractRoot, ...preimage } = contract;
  return { contract, files, schemaRoot, contractRoot: semanticRoot(preimage) };
}

export function checkProjectCutCompositionContract(root = DEFAULT_ROOT) {
  const roots = computeProjectCutCompositionRoots(root);
  if (roots.contract.schemaBundle.schemaRoot !== roots.schemaRoot)
    throw new Error(
      `composition schema root mismatch: expected ${roots.contract.schemaBundle.schemaRoot}, got ${roots.schemaRoot}`,
    );
  if (roots.contract.contractRoot !== roots.contractRoot)
    throw new Error(
      `composition contract root mismatch: expected ${roots.contract.contractRoot}, got ${roots.contractRoot}`,
    );
  if (
    roots.contract.cutCompatibility.rootPreimageUnchanged !== true ||
    roots.contract.cutCompatibility.gitObjectIdsExcludedFromCut !== true ||
    roots.contract.admission.globalDagAuditIsSeparate !== true
  )
    throw new Error('composition authority boundary drifted');
  try {
    const Ajv2020 = require('ajv/dist/2020.js').default;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    for (const relative of roots.contract.schemaBundle.files)
      ajv.compile(readJson(root, path.join(PROJECT_CUT_ROOT, relative)));
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
  }
  return {
    schemaRoot: roots.schemaRoot,
    contractRoot: roots.contractRoot,
    schemaFiles: roots.files.length,
  };
}
