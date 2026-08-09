// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredStates = new Set([
  'apply-now',
  'defer-until-idle',
  'compatible-handoff',
  'resume-required',
  'blocked-incompatible',
  'failed-rolled-back',
  'action-required',
]);
const requiredReasons = new Set([
  'active-work-compatible',
  'active-work-incompatible',
  'provider-resume-required',
  'irreversible-migration-needs-approval',
  'stale-generation',
  'readiness-failed',
  'unknown-image-reference',
]);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function assertUnique(values, label) {
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length !== new Set(values).size
  )
    throw new Error(`${label} must be a non-empty unique array`);
}

function assertContains(values, required, label) {
  const present = new Set(values);
  const missing = [...required].filter((value) => !present.has(value));
  if (missing.length)
    throw new Error(`${label} missing: ${missing.join(', ')}`);
}

function assertMessageRegistry(contract) {
  const registry = contract.messageRegistry;
  if (registry?.schema !== 'kungfu.product-upgrade-messages/v1')
    throw new Error('upgrade message registry schema is missing');
  const messages = registry.reasonMessages;
  if (!messages || typeof messages !== 'object')
    throw new Error('upgrade reason messages are missing');
  const requiredFields = [
    'title',
    'whatHappened',
    'activeWork',
    'activation',
    'userAction',
    'dataAndSessions',
    'documentationAnchor',
  ];
  for (const reason of [...contract.reasonCodes, registry.fallbackReason]) {
    const message = messages[reason];
    if (!message) throw new Error(`upgrade message missing: ${reason}`);
    for (const field of requiredFields) {
      if (typeof message[field] !== 'string' || !message[field])
        throw new Error(`upgrade message ${reason} has no ${field}`);
    }
    if (!/^#[a-z0-9-]+$/.test(message.documentationAnchor))
      throw new Error(`upgrade message ${reason} has an invalid docs anchor`);
  }
}

export function checkUpgradeContract(root = ROOT) {
  const contractPath = path.join(
    root,
    'framework',
    'upgrade',
    'kungfu-upgrade.contract.json',
  );
  const registryPath = path.join(
    root,
    'framework',
    'contract',
    'kungfu-contracts.registry.json',
  );
  const fixturePath = path.join(
    root,
    'tests',
    'fixtures',
    'runtime-upgrade-control-plane',
    'cases.json',
  );
  const contract = readJson(contractPath);
  const registry = readJson(registryPath);
  const fixtures = readJson(fixturePath);

  if (contract.schema !== 'kungfu.product-upgrade.contract/v1')
    throw new Error(`unexpected upgrade contract schema: ${contract.schema}`);
  if (
    contract.authority?.activation !== 'kungfu-core-runtime-upgrade-controller'
  )
    throw new Error('runtime upgrade activation authority drifted from Core');
  assertUnique(contract.states, 'upgrade states');
  assertUnique(contract.reasonCodes, 'upgrade reason codes');
  assertContains(contract.states, requiredStates, 'upgrade states');
  assertContains(contract.reasonCodes, requiredReasons, 'upgrade reason codes');
  assertMessageRegistry(contract);

  const entry = registry.contracts?.find(
    (candidate) => candidate.surface === 'upgrade',
  );
  if (!entry || entry.schema !== contract.schema)
    throw new Error(
      'upgrade contract is not welded into the contract registry',
    );
  if (entry.source !== 'framework/upgrade/kungfu-upgrade.contract.json')
    throw new Error('upgrade registry source path drifted');

  assertUnique(
    fixtures.cases?.map((fixture) => fixture.id),
    'upgrade fixture ids',
  );
  for (const fixture of fixtures.cases || []) {
    if (!contract.states.includes(fixture.expectedState))
      throw new Error(
        `fixture ${fixture.id} expects unknown state ${fixture.expectedState}`,
      );
  }

  const defs = contract.valueSchemaBundle?.$defs || {};
  for (const name of [
    'releaseManifest',
    'runtimeImage',
    'runtimeReference',
    'upgradePlan',
    'upgradeReceipt',
    'gcPlan',
  ]) {
    if (!defs[name]) throw new Error(`upgrade value schema missing ${name}`);
  }

  return {
    contract: path.relative(root, contractPath).split(path.sep).join('/'),
    states: contract.states.length,
    reasons: contract.reasonCodes.length,
    messages: Object.keys(contract.messageRegistry.reasonMessages).length,
    fixtures: fixtures.cases.length,
  };
}
