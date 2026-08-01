#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { semanticRoot } from '../../project-cut/src/project-cut.mjs';
import {
  openCardAuthorityBoundary,
  openCardAutoAdoptionPolicy,
} from '../src/work-design-open-card.mjs';

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
      'framework/work-design-open-card/work-design-open-card.contract.json',
    ),
    'utf8',
  ),
);
const { contractRoot, ...preimage } = contract;
const actualRoot = semanticRoot(preimage);
if (contractRoot !== actualRoot)
  throw new Error(
    `open-card contract root mismatch: expected ${contractRoot}, got ${actualRoot}`,
  );
const boundary = openCardAuthorityBoundary();
if (
  JSON.stringify(boundary.authority) !== JSON.stringify(contract.authority) ||
  JSON.stringify(boundary.cardState) !== JSON.stringify(contract.cardState)
)
  throw new Error('open-card authority or card-state boundary drifted');
if (
  JSON.stringify(openCardAutoAdoptionPolicy()) !==
  JSON.stringify(contract.autoAdoption)
)
  throw new Error('open-card auto-adoption policy drifted');
if (
  contract.outcomeEstimate?.runsAfterSelector !== true ||
  contract.outcomeEstimate?.runsBeforeCapture !== true ||
  contract.outcomeEstimate?.preservesHumanWorkDefinition !== true ||
  contract.outcomeEstimate?.failure !==
    'explicit-manual-capture-without-silent-adoption' ||
  !contract.fallbackReasons.includes('outcome-history-unqualified')
)
  throw new Error('open-card outcome estimate boundary drifted');
console.log(`[work-design-open-card] contract=${actualRoot}`);
