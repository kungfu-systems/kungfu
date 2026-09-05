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

export function computeWorkDesignPolicyReplayRoots(root = DEFAULT_ROOT) {
  const contractPath =
    'framework/work/work-design-policy-replay/work-design-policy-replay.contract.json';
  const contract = readJson(root, contractPath);
  const files = contract.schemaBundle.files.map((relative) => ({
    path: relative,
    root: semanticRoot(
      readJson(
        root,
        path.join('framework/work/work-design-policy-replay', relative),
      ),
    ),
  }));
  const schemaRoot = semanticRoot({
    schema: 'kungfu.work-design.policy-replay-schema-bundle/v1',
    files,
  });
  const { contractRoot: _contractRoot, ...preimage } = contract;
  return { contract, files, schemaRoot, contractRoot: semanticRoot(preimage) };
}

export function checkWorkDesignPolicyReplayContract(root = DEFAULT_ROOT) {
  const roots = computeWorkDesignPolicyReplayRoots(root);
  if (roots.contract.schemaBundle.schemaRoot !== roots.schemaRoot)
    throw new Error(
      `policy replay schema root mismatch: expected ${roots.contract.schemaBundle.schemaRoot}, got ${roots.schemaRoot}`,
    );
  if (roots.contract.contractRoot !== roots.contractRoot)
    throw new Error(
      `policy replay contract root mismatch: expected ${roots.contract.contractRoot}, got ${roots.contractRoot}`,
    );
  if (
    roots.contract.schema !== 'kungfu.work-design.policy-replay-contract/v2' ||
    roots.contract.version !== 2 ||
    roots.contract.predecessorContractRoot !==
      'sha256:1dd69058c9a940e6596ea27877dd0fe55954911161b4b11b1522654d3f13b97c' ||
    roots.contract.mode !== 'offline-advisory' ||
    roots.contract.minimumDefaultPromotionSamples !== 30 ||
    roots.contract.activation !==
      'separately-authorized-native-decision-required' ||
    Object.values(roots.contract.authority).some((value) => value !== false)
  )
    throw new Error('policy replay authority or promotion floor drifted');
  const feedback = roots.contract.outcomeFeedback;
  if (
    feedback?.shadowThresholds?.observationOnlyMaximum !== 9 ||
    feedback?.shadowThresholds?.tentativeTrendMinimum !== 10 ||
    feedback?.shadowThresholds?.tentativeTrendMaximum !== 29 ||
    feedback?.shadowThresholds?.promotionEligibilityMinimum !== 30 ||
    feedback?.activation !== 'native-versioned-bounded-parameter-envelope' ||
    feedback?.outOfEnvelope !== 'human-decision-required' ||
    feedback?.concurrency !== 'expected-state-root-fenced' ||
    feedback?.rollback !== 'automatic-exact-previous-policy-root' ||
    feedback?.unknownEvidence !== 'remain-unknown-and-block-affected-cohort' ||
    feedback?.privacyBoundary !==
      'roots-enums-timestamps-and-sanitized-identifiers-only' ||
    feedback?.prospectiveAccounting?.activeSecondsConservedExactly !== true ||
    feedback?.prospectiveAccounting?.openingEstimateRootRequired !== true ||
    feedback?.prospectiveAccounting?.authority !== 'observation-and-advice-only'
  )
    throw new Error(
      'outcome feedback thresholds or activation boundary drifted',
    );
  const expectedDimensions = [
    'selection',
    'advice',
    'disposition',
    'outcome',
    'coverage',
  ];
  if (
    JSON.stringify(roots.contract.comparisonDimensions) !==
    JSON.stringify(expectedDimensions)
  )
    throw new Error('policy replay comparison dimensions drifted');

  const Ajv2020 = loadAjv2020();
  if (Ajv2020) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const schemas = roots.contract.schemaBundle.files.map((relative) =>
      readJson(
        root,
        path.join('framework/work/work-design-policy-replay', relative),
      ),
    );
    for (const schema of schemas) ajv.addSchema(schema);
    for (const schema of schemas) {
      if (!ajv.getSchema(schema.$id))
        throw new Error(`policy replay schema did not compile: ${schema.$id}`);
    }
  }
  return {
    schemaRoot: roots.schemaRoot,
    contractRoot: roots.contractRoot,
    schemaFiles: roots.files.length,
    schemaValidation: Ajv2020 ? 'compiled' : 'skipped',
  };
}
