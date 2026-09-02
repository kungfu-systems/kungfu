// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { semanticRoot } from '../../project-cut/index.mjs';

const DEFAULT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
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

export function computeWorkDesignAdvisorRoots(root = DEFAULT_ROOT) {
  const contractPath =
    'framework/work-design-advisor/work-design-advisor.contract.json';
  const contract = readJson(root, contractPath);
  const files = contract.schemaBundle.files.map((relative) => ({
    path: relative,
    root: semanticRoot(
      readJson(root, path.join('framework/work-design-advisor', relative)),
    ),
  }));
  const schemaRoot = semanticRoot({
    schema: 'kungfu.work-design.advisor-schema-bundle/v1',
    files,
  });
  const { contractRoot: _contractRoot, ...preimage } = contract;
  return { contract, files, schemaRoot, contractRoot: semanticRoot(preimage) };
}

export function checkWorkDesignAdvisorContract(root = DEFAULT_ROOT) {
  const roots = computeWorkDesignAdvisorRoots(root);
  if (roots.contract.schemaBundle.schemaRoot !== roots.schemaRoot)
    throw new Error(
      `advisor schema root mismatch: expected ${roots.contract.schemaBundle.schemaRoot}, got ${roots.schemaRoot}`,
    );
  if (roots.contract.contractRoot !== roots.contractRoot)
    throw new Error(
      `advisor contract root mismatch: expected ${roots.contract.contractRoot}, got ${roots.contractRoot}`,
    );
  if (
    roots.contract.authority.mode !== 'advisory-only' ||
    Object.entries(roots.contract.authority)
      .filter(([key]) => key !== 'mode')
      .some(([, value]) => value !== false) ||
    roots.contract.historyPolicy.advisoryImplementationMinimumSamples !== 0 ||
    roots.contract.historyPolicy.defaultPolicyPromotion !== 'out-of-scope'
  )
    throw new Error(
      'work-design advisory authority or sample boundary drifted',
    );
  const estimation = roots.contract.outcomeEstimation;
  if (
    estimation?.thresholds?.observationOnlyMaximum !== 9 ||
    estimation?.thresholds?.tentativeTrendMinimum !== 10 ||
    estimation?.thresholds?.tentativeTrendMaximum !== 29 ||
    estimation?.thresholds?.existingReplayGatesRequiredMinimum !== 30 ||
    estimation?.defaultPolicyInfluence !== false ||
    estimation?.finalWorkDefinitionAuthority !== 'human'
  )
    throw new Error(
      'outcome-informed estimate thresholds or authority drifted',
    );
  const requiredDispositions = [
    'accepted',
    'adapted',
    'insufficient-history',
    'overridden',
  ];
  if (
    JSON.stringify([...roots.contract.dispositions].sort()) !==
    JSON.stringify(requiredDispositions)
  )
    throw new Error('work-design disposition coverage drifted');

  const Ajv2020 = loadAjv2020();
  if (Ajv2020) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const schemas = roots.contract.schemaBundle.files.map((relative) =>
      readJson(root, path.join('framework/work-design-advisor', relative)),
    );
    for (const schema of schemas) ajv.addSchema(schema);
    for (const schema of schemas) {
      if (!ajv.getSchema(schema.$id))
        throw new Error(`work-design schema did not compile: ${schema.$id}`);
    }
  }
  return {
    schemaRoot: roots.schemaRoot,
    contractRoot: roots.contractRoot,
    schemaFiles: roots.files.length,
    schemaValidation: Ajv2020 ? 'compiled' : 'skipped',
  };
}
