#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildGatePlan,
  validateGateRegistryBytes,
} from './shifu-gate-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');

async function loadAjv2020() {
  try {
    return (await import('ajv/dist/2020.js')).default;
  } catch (error) {
    if (error && error.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  }
}

export async function checkShifuGateContract(root = ROOT) {
  const contractPath = path.join(root, 'docs', 'shifu', 'gate-contract.json');
  const contract = readJson(contractPath);
  assert.equal(contract.schema, 'shifu.gate-contract/v1');
  assert.equal(contract.owner, 'shifu');
  const registrySchemaPath = path.join(root, contract.authority.registrySchema);
  const planSchemaPath = path.join(root, contract.authority.planSchema);
  const receiptSchemaPath = path.join(root, contract.authority.receiptSchema);
  const decisionPath = path.join(root, contract.decision);
  for (const source of [
    registrySchemaPath,
    planSchemaPath,
    receiptSchemaPath,
    decisionPath,
  ])
    assert.ok(
      fs.existsSync(source),
      `contract source is missing: ${rel(root, source)}`,
    );
  const registrySchema = readJson(registrySchemaPath);
  const planSchema = readJson(planSchemaPath);
  const receiptSchema = readJson(receiptSchemaPath);
  assert.equal(registrySchema.$id, contract.schemaIds.registry);
  assert.equal(planSchema.$id, contract.schemaIds.plan);
  assert.equal(receiptSchema.$id, contract.schemaIds.receipt);

  const dispatchMarkers = [
    ['shifu.cmd', 'if /i "%~1"=="gate"   goto delegate'],
    ['shifu.mjs', "if (cmd === 'gate')"],
  ];
  for (const [source, marker] of dispatchMarkers)
    assert.ok(
      fs.readFileSync(path.join(root, source), 'utf8').includes(marker),
      `${source} does not route the gate command`,
    );
  const shellLauncher = fs.readFileSync(path.join(root, 'shifu'), 'utf8');
  const richCase = shellLauncher.match(
    /case "\$\{1:-\}" in\s+(?<commands>[^)]+)\)\s+if command -v fnm/,
  );
  assert.ok(
    richCase?.groups?.commands
      .split('|')
      .map((command) => command.trim())
      .includes('gate'),
    'shifu does not route the gate command',
  );
  const nativeLauncher = fs.readFileSync(
    path.join(root, 'crates/shifu/src/main.rs'),
    'utf8',
  );
  const nativeSubcommands = nativeLauncher.match(
    /const L2_SUBCOMMANDS:[^=]+=\s*&\[(?<commands>[\s\S]*?)\];/,
  );
  assert.ok(
    nativeSubcommands?.groups?.commands.includes('"gate"'),
    'crates/shifu/src/main.rs does not route the gate command',
  );

  const exampleRoot = path.join(root, 'docs', 'shifu', 'examples', 'gates');
  const validPath = path.join(exampleRoot, 'minimal.gate-registry.json');
  const validRaw = fs.readFileSync(validPath);
  const valid = validateGateRegistryBytes(validRaw);
  assert.deepEqual(valid.issues, []);
  for (const gate of valid.registry.gates)
    assert.ok(
      fs.existsSync(path.join(root, gate.documentation)),
      `gate documentation is missing: ${gate.documentation}`,
    );

  const expectedInvalid = {
    'bad-schema.gate-registry.json': 'schema-version',
    'duplicate-id.gate-registry.json': 'duplicate-gate',
    'unknown-dependency.gate-registry.json': 'unknown-dependency',
    'cycle.gate-registry.json': 'dependency-cycle',
    'profile-gap.gate-registry.json': 'profile-gap',
  };
  for (const [name, code] of Object.entries(expectedInvalid)) {
    const result = validateGateRegistryBytes(
      fs.readFileSync(path.join(exampleRoot, 'invalid', name)),
    );
    assert.ok(
      result.issues.some((item) => item.code === code),
      `${name} did not fail with ${code}: ${JSON.stringify(result.issues)}`,
    );
  }

  const plan = buildGatePlan(valid.registry, 'development', {
    ref: rel(root, validPath),
    digest: valid.digest,
    platform: 'linux',
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.groups.map((group) => group.gates.map((gate) => gate.id)),
    [['source.format'], ['source.contract']],
  );

  let schemaValidation = 'skipped';
  const Ajv2020 = await loadAjv2020();
  if (Ajv2020) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validateRegistry = ajv.compile(registrySchema);
    const validatePlan = ajv.compile(planSchema);
    ajv.compile(receiptSchema);
    assert.equal(
      validateRegistry(valid.registry),
      true,
      JSON.stringify(validateRegistry.errors),
    );
    assert.equal(validatePlan(plan), true, JSON.stringify(validatePlan.errors));
    schemaValidation = 'passed';
  } else {
    console.warn(
      '[shifu-gate] ajv not installed; runtime semantic fixtures still ran. ' +
        'Run `./shifu sync` to enable JSON Schema conformance locally; CI enforces it.',
    );
  }

  const engine = [
    'scripts/shifu-gate-runtime.mjs',
    'scripts/shifu-gate-cli.mjs',
    'scripts/shifu-gate-executor.mjs',
  ]
    .map((source) => fs.readFileSync(path.join(root, source), 'utf8'))
    .join('\n');
  assert.doesNotMatch(
    engine,
    /\b(?:dev-pr|alpha-pr|release-pr|membrane-spike)\b/,
  );

  return {
    contract: rel(root, contractPath),
    registrySchema: rel(root, registrySchemaPath),
    planSchema: rel(root, planSchemaPath),
    receiptSchema: rel(root, receiptSchemaPath),
    validFixtures: 1,
    rejectedFixtures: Object.keys(expectedInvalid).length,
    schemaValidation,
  };
}

async function main() {
  const result = await checkShifuGateContract();
  console.log(
    `[shifu-gate] contract=${result.contract} valid=${result.validFixtures} rejected=${result.rejectedFixtures} schema=${result.schemaValidation}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
