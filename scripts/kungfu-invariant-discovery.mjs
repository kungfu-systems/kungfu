#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONTRACT_PATH =
  'framework/spec/invariant/kungfu-invariant-system.contract.json';
export const REGISTRY_PATH =
  'framework/spec/invariant/kungfu-invariant.registry.json';

export function buildInvariantDiscovery(registry) {
  return {
    schema: 'kungfu.invariant-discovery/v1',
    contract: CONTRACT_PATH,
    registry: REGISTRY_PATH,
    publicEntry: './shifu invariant:verify',
    invariants: registry.invariants.map((item) => ({
      id: item.id,
      domain: item.domain,
      label: item.label,
      owner: item.owner,
      source: item.source,
      stability: item.stability,
      maturity: item.maturity,
      checkers: item.checkerIds,
      release: item.release,
      residualRisk: item.residualRisk,
    })),
  };
}

function parseArgs(argv) {
  const values = argv.filter((arg) => arg !== '--');
  let json = false;
  let list = false;
  for (const arg of values) {
    if (arg === '--list') list = true;
    else if (arg === '--json') json = true;
    else throw new Error(`unknown argument '${arg}'`);
  }
  if (!list) throw new Error('the build-free route requires --list');
  return { json };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `invariant discovery: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(3);
  }
  const registry = JSON.parse(
    fs.readFileSync(path.join(ROOT, REGISTRY_PATH), 'utf8'),
  );
  const result = buildInvariantDiscovery(registry);
  if (options.json)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else
    for (const item of result.invariants)
      process.stdout.write(
        `${item.id}\t${item.domain}\t${item.owner}\t${item.maturity}\n`,
      );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
