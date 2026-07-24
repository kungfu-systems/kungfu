// SPDX-License-Identifier: Apache-2.0
// @ts-check

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const packageRoot = __dirname;
const siteRoot = path.join(packageRoot, 'dist', 'site');
const bundlePath = path.join(siteRoot, 'site-bundle.json');
const agentIndexPath = path.join(siteRoot, 'agent-index.json');
const adrMapPath = path.join(siteRoot, 'adr-map.json');
const schemaPath = path.join(packageRoot, 'schema', 'site-bundle.schema.json');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadBundle() {
  return readJson(bundlePath);
}

function verifyBundle() {
  const bundle = loadBundle();
  const { contentRoot: _contentRoot, ...copy } = structuredClone(bundle);
  const contentRoot = sha256(JSON.stringify(canonical(copy)));
  if (contentRoot !== bundle.contentRoot) {
    throw new Error('Kungfu site bundle content root mismatch');
  }
  const adrMapRoot = sha256(fs.readFileSync(adrMapPath));
  if (adrMapRoot !== bundle.adrMap?.contentRoot) {
    throw new Error('Kungfu ADR map content root mismatch');
  }
  const agentIndex = readJson(agentIndexPath);
  if (
    agentIndex.bundleContentRoot !== bundle.contentRoot ||
    agentIndex.sourceRoot !== bundle.sourceRoot
  ) {
    throw new Error('Kungfu agent index is not bound to the site bundle');
  }
  return {
    status: 'passing',
    package: bundle.package,
    sourceRevision: bundle.source.revision,
    sourceRoot: bundle.sourceRoot,
    contentRoot: bundle.contentRoot,
    surfaces: bundle.surfaces.length,
    sources: bundle.sources.length,
  };
}

module.exports = {
  adrMapPath,
  agentIndexPath,
  bundlePath,
  loadBundle,
  schemaPath,
  siteRoot,
  verifyBundle,
};
