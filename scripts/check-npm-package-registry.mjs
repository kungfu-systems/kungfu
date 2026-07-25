#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = path.join(
  ROOT,
  'framework',
  'release',
  'npm-package-registry.json',
);

function issue(code, message) {
  return { code, message };
}

export function collectNpmRegistryIssues({
  root = ROOT,
  registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')),
} = {}) {
  const issues = [];
  const packages = registry.packages || [];
  const names = packages.map((entry) => entry.name);
  if (registry.schema !== 'kungfu.npm-release-package-registry/v1')
    issues.push(issue('schema', 'unexpected npm package registry schema'));
  if (packages.length !== registry.releaseInventory?.expectedPackageCount)
    issues.push(
      issue(
        'count',
        `expected ${registry.releaseInventory?.expectedPackageCount} packages, found ${packages.length}`,
      ),
    );
  if (new Set(names).size !== names.length)
    issues.push(issue('duplicate', 'npm package registry has duplicate names'));
  if (names.some((name) => !name.startsWith('@kungfu-tech/')))
    issues.push(issue('scope', 'release inventory must stay in @kungfu-tech'));

  const workspaceEntries = packages.filter(
    (entry) => entry.kind === 'workspace',
  );
  const generatedEntries = packages.filter(
    (entry) => entry.kind === 'generated-platform',
  );
  if (workspaceEntries.length !== 22 || generatedEntries.length !== 6)
    issues.push(
      issue(
        'composition',
        `expected 22 workspace and 6 generated packages, found ${workspaceEntries.length} and ${generatedEntries.length}`,
      ),
    );
  for (const entry of workspaceEntries) {
    const packagePath = path.join(root, entry.source);
    if (!fs.existsSync(packagePath)) {
      issues.push(issue('source-missing', `${entry.name} source is missing`));
      continue;
    }
    const source = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (source.name !== entry.name || source.private === true)
      issues.push(
        issue('source-drift', `${entry.name} does not match its public source`),
      );
  }

  const coreContract = JSON.parse(
    fs.readFileSync(
      path.join(root, 'framework/core/core-platform-package.contract.json'),
      'utf8',
    ),
  );
  const coreNames = coreContract.platformPackages.map((entry) => entry.name);
  const registeredCoreNames = generatedEntries
    .map((entry) => entry.name)
    .filter((name) => name.startsWith('@kungfu-tech/core-'));
  if (
    JSON.stringify(coreNames.sort()) !==
    JSON.stringify(registeredCoreNames.sort())
  )
    issues.push(
      issue('core-platforms', 'Core platform package registry drift'),
    );

  const exactArtifacts =
    registry.trustedPublishing?.exactArtifactPackages || [];
  if (
    exactArtifacts.length !== 9 ||
    exactArtifacts.some((name) => !names.includes(name))
  )
    issues.push(
      issue(
        'exact-artifacts',
        'trusted exact-artifact set must contain 9 registered packages',
      ),
    );
  const workflowPath = path.join(
    root,
    registry.trustedPublishing?.workflow || '',
  );
  const workflow = fs.existsSync(workflowPath)
    ? fs.readFileSync(workflowPath, 'utf8')
    : '';
  for (const required of [
    'id-token: write',
    'environment: adr0049-production-publication',
    'npm publish --provenance --access public',
  ]) {
    if (!workflow.includes(required))
      issues.push(issue('trusted-publish', `publisher lacks ${required}`));
  }
  if (/NODE_AUTH_TOKEN|NPM_TOKEN/u.test(workflow))
    issues.push(
      issue(
        'long-lived-token',
        'npm publisher must not use a long-lived token',
      ),
    );

  const rollback = registry.rollback || {};
  if (
    rollback.publishedVersionsAreImmutable !== true ||
    rollback.unpublishAllowed !== false ||
    rollback.recovery !== 'deprecate-bad-version-and-publish-a-new-version'
  )
    issues.push(issue('rollback', 'npm rollback policy is incomplete'));
  return issues;
}

function main() {
  const issues = collectNpmRegistryIssues();
  if (issues.length > 0) {
    for (const entry of issues)
      console.error(`[npm-registry] ${entry.code}: ${entry.message}`);
    process.exit(1);
  }
  console.log('[npm-registry] 28-package Release inventory is coherent');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
