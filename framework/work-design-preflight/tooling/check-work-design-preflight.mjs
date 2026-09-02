#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { semanticRoot } from '../../project-cut/index.mjs';
import {
  workDesignAuthorityBoundary,
  workDesignAutoAdoptionPolicy,
} from '../src/work-design-preflight.mjs';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const contract = JSON.parse(
  fs.readFileSync(
    path.join(
      root,
      'framework/work-design-preflight/work-design-preflight.contract.json',
    ),
    'utf8',
  ),
);
const { contractRoot, ...preimage } = contract;
const actualRoot = semanticRoot(preimage);
if (contractRoot !== actualRoot)
  throw new Error(
    `work-design contract root mismatch: expected ${contractRoot}, got ${actualRoot}`,
  );
const boundary = workDesignAuthorityBoundary();
if (
  JSON.stringify(boundary.authority) !== JSON.stringify(contract.authority) ||
  JSON.stringify(boundary.operation) !== JSON.stringify(contract.operation)
)
  throw new Error('work-design authority or operation boundary drifted');
if (
  JSON.stringify(workDesignAutoAdoptionPolicy()) !==
  JSON.stringify(contract.autoAdoption)
)
  throw new Error('work-design auto-adoption policy drifted');
if (
  contract.outcomeEstimate?.runsAfterSelector !== true ||
  contract.outcomeEstimate?.runsBeforeCapture !== true ||
  contract.outcomeEstimate?.preservesHumanWorkDefinition !== true ||
  contract.outcomeEstimate?.failure !==
    'explicit-manual-capture-without-silent-adoption' ||
  !contract.fallbackReasons.includes('outcome-history-unqualified')
)
  throw new Error('work-design outcome estimate boundary drifted');
console.log(`[work-design-preflight] contract=${actualRoot}`);
