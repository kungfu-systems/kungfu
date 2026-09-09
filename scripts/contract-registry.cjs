// SPDX-License-Identifier: Apache-2.0
// @ts-check

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_SOURCE = path.join(
  ROOT,
  'framework',
  'spec',
  'contract',
  'kungfu-contracts.registry.json',
);
const REGISTRY_ARTIFACT = path.join('config', 'kungfu-contracts.registry.json');

function loadContractRegistry() {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_SOURCE, 'utf8'));
  if (registry?.schema !== 'kungfu.contract-registry/v1') {
    throw new Error(
      `Kungfu contract registry schema mismatch: ${String(registry?.schema)}`,
    );
  }
  if (!Array.isArray(registry.contracts)) {
    throw new Error('Kungfu contract registry must contain a contracts array');
  }
  return registry;
}

function contractArtifacts() {
  const rows = [
    {
      label: 'contract registry',
      source: path.relative(ROOT, REGISTRY_SOURCE),
      artifact: REGISTRY_ARTIFACT,
    },
  ];
  const registry = loadContractRegistry();
  if (registry.canonicalPolicy) {
    rows.push({
      label: 'agent-first canonical policy',
      source: registry.canonicalPolicy.source,
      artifact: registry.canonicalPolicy.artifact,
    });
  }
  for (const contract of registry.contracts) {
    rows.push({
      label: `${contract.surface} contract`,
      surface: contract.surface,
      source: contract.source,
      artifact: contract.artifact,
    });
    for (const artifact of contract.extraArtifacts ?? []) {
      rows.push({
        label: artifact.label || `${contract.surface} contract artifact`,
        surface: contract.surface,
        source: artifact.source,
        artifact: artifact.artifact,
      });
    }
  }
  return rows;
}

function copyContractArtifacts(distKfc) {
  for (const artifact of contractArtifacts()) {
    const source = path.join(ROOT, artifact.source);
    const dest = path.join(distKfc, artifact.artifact);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
  }
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

module.exports = {
  REGISTRY_ARTIFACT,
  REGISTRY_SOURCE,
  contractArtifacts,
  copyContractArtifacts,
  loadContractRegistry,
  sha256File,
};
