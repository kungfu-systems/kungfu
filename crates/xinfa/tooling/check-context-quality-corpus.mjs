#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = path.join(
  ROOT,
  'fixtures',
  'golden',
  'context-quality-corpus-v1.json',
);
const REQUIRED_SCENARIOS = new Set([
  'implementation',
  'review',
  'incident-diagnosis',
  'documentation-update',
  'cross-domain-impact',
  'continuation',
]);

function main() {
  const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
  if (corpus.schema !== 'xinfa.context-quality-corpus/v1')
    throw new Error('context quality corpus schema drift');
  const ids = new Set();
  const routes = new Set();
  const scenarios = new Set();
  for (const item of corpus.cases) {
    if (!item.id || ids.has(item.id))
      throw new Error(`duplicate or missing case id: ${item.id}`);
    ids.add(item.id);
    routes.add(item.expected_route);
    scenarios.add(item.scenario);
    if (
      item.expected_route === 'kungfu-agent-surfaces' ||
      item.expected_route === 'kungfu-human-surfaces'
    )
      throw new Error(`${item.id} relies on the all-surfaces fallback`);
    if (
      !Array.isArray(item.critical_sources) ||
      item.critical_sources.length < 1
    )
      throw new Error(`${item.id} has no critical-source oracle`);
    const sources = [...item.critical_sources, ...item.optional_sources];
    if (new Set(sources).size !== sources.length)
      throw new Error(`${item.id} has duplicate gold sources`);
    if (!(item.budget > 0) || !(item.max_expansion_hops >= 0))
      throw new Error(`${item.id} has an invalid budget or hop bound`);
  }
  for (const scenario of REQUIRED_SCENARIOS)
    if (!scenarios.has(scenario))
      throw new Error(`missing adversarial scenario family: ${scenario}`);
  const thresholds = corpus.thresholds;
  const fixed = {
    cases: 31,
    route_families: 11,
    scenario_families: 6,
    critical_source_recall: 1,
    required_omission_rate: 0,
    route_ambiguity_rate: 0,
    degraded_rate: 0,
    stale_detection_rate: 1,
    human_correction_rate: 0,
    fallback_rate: 0,
    max_expansion_hops: 2,
  };
  for (const [key, value] of Object.entries(fixed))
    if (thresholds[key] !== value)
      throw new Error(`ratchet threshold ${key} drifted from ${value}`);
  if (thresholds.irrelevant_context_ratio_max > 0.35)
    throw new Error('irrelevant context ratio ratchet was weakened');
  if (corpus.cases.length < thresholds.cases)
    throw new Error('context quality corpus fell below its case ratchet');
  if (routes.size < thresholds.route_families)
    throw new Error('context quality corpus fell below its route ratchet');
  process.stdout.write(
    `[xinfa-quality] cases=${corpus.cases.length} routes=${routes.size} scenarios=${scenarios.size} ratchets=current\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
