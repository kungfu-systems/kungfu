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
  const expectedWorkspaceCount =
    registry.releaseInventory?.expectedWorkspacePackageCount;
  const expectedGeneratedPlatformCount =
    registry.releaseInventory?.expectedGeneratedPlatformPackageCount;
  if (
    workspaceEntries.length !== expectedWorkspaceCount ||
    generatedEntries.length !== expectedGeneratedPlatformCount
  )
    issues.push(
      issue(
        'composition',
        `expected ${expectedWorkspaceCount} workspace and ${expectedGeneratedPlatformCount} generated packages, found ${workspaceEntries.length} and ${generatedEntries.length}`,
      ),
    );
  for (const entry of workspaceEntries) {
    const packagePath = path.join(root, entry.source);
    if (!fs.existsSync(packagePath)) {
      issues.push(issue('source-missing', `${entry.name} source is missing`));
      continue;
    }
    const source = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (source.name !== entry.name)
      issues.push(
        issue('source-drift', `${entry.name} does not match its public source`),
      );
    if (Object.hasOwn(source, 'private'))
      issues.push(
        issue('source-private', `${entry.name} must remove the private field`),
      );
    if (
      source.publishConfig?.registry !== 'https://registry.npmjs.org/' ||
      source.publishConfig?.access !== 'public'
    )
      issues.push(
        issue(
          'source-publication',
          `${entry.name} must target the public npm registry`,
        ),
      );
    if (entry.source.startsWith('extensions/')) {
      const manifestPath = path.join(
        path.dirname(packagePath),
        'kungfu.kfx.json',
      );
      if (!fs.existsSync(manifestPath)) {
        issues.push(
          issue(
            'kfx-manifest-missing',
            `${entry.name} KFX manifest is missing`,
          ),
        );
        continue;
      }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.name !== source.name || manifest.version !== source.version)
        issues.push(
          issue(
            'kfx-identity-drift',
            `${entry.name} package and KFX manifest identities must match`,
          ),
        );
      const profile = manifest.kungfuConfig?.suite?.profile;
      if (profile) {
        const profilePath = path.join(path.dirname(manifestPath), profile);
        if (!fs.existsSync(profilePath))
          issues.push(
            issue(
              'kfx-profile-missing',
              `${entry.name} Suite profile is missing`,
            ),
          );
        else if (
          JSON.parse(fs.readFileSync(profilePath, 'utf8')).version !==
          source.version
        )
          issues.push(
            issue(
              'kfx-profile-version-drift',
              `${entry.name} Suite profile version must match its package`,
            ),
          );
      }
    }
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
    exactArtifacts.length !== names.length ||
    JSON.stringify([...exactArtifacts].sort()) !==
      JSON.stringify([...names].sort())
  )
    issues.push(
      issue(
        'exact-artifacts',
        `trusted exact-artifact set must contain all ${names.length} registered packages`,
      ),
    );
  const dedicatedPackages = registry.workspacePacking?.dedicatedPackages || [];
  const bulkWorkspaceCount = workspaceEntries.filter(
    (entry) => !dedicatedPackages.includes(entry.name),
  ).length;
  if (
    registry.workspacePacking?.portableOwner !== 'linux' ||
    bulkWorkspaceCount !== registry.workspacePacking?.bulkPackageCount
  )
    issues.push(
      issue(
        'workspace-packing',
        `portable workspace packing must bind exactly ${registry.workspacePacking?.bulkPackageCount} packages to linux`,
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
    'npm-release-inventory.mjs --dist-tag',
    '--tag "$npm_dist_tag"',
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

function readText(root, relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function readJson(root, relative) {
  return JSON.parse(readText(root, relative));
}

export function loadComponentDistributionInputs(root = ROOT) {
  return {
    contract: readJson(
      root,
      'framework/release/component-distribution.contract.json',
    ),
    npmRegistry: readJson(root, 'framework/release/npm-package-registry.json'),
    corePackage: readJson(root, 'framework/core/package.json'),
    shifuCargo: readText(root, 'crates/shifu/Cargo.toml'),
    shifuSource: readText(root, 'crates/shifu/src/main.rs'),
    xinfaCargo: readText(root, 'crates/xinfa/Cargo.toml'),
    trunkCargo: readText(root, 'crates/trunk/Cargo.toml'),
    trunkSource: readText(root, 'crates/trunk/src/main.rs'),
    workflow: readText(root, '.github/workflows/release-shifu.yml'),
  };
}

function cargoVersion(source) {
  return source.match(/^version = "([^"]+)"$/mu)?.[1] || '';
}

export function validateComponentDistribution(inputs) {
  const issues = [];
  const { contract } = inputs;
  if (contract.schema !== 'kungfu.component-distribution-contract/v1')
    issues.push('unexpected component distribution schema');
  if (contract.productBoundary?.npmExecutable !== 'kungfu')
    issues.push('Kungfu must remain the only npm executable');
  if (
    contract.productBoundary?.npmPackageInventory !==
    inputs.npmRegistry.releaseInventory?.expectedPackageCount
  )
    issues.push('component contract must match the npm Release inventory');
  if (contract.productBoundary?.coreCarriesStandalonePayloads !== false)
    issues.push('Core must not carry standalone Shifu or Xinfa payloads');

  const bins = Object.keys(inputs.corePackage.bin || {});
  if (bins.length !== 1 || bins[0] !== 'kungfu')
    issues.push('@kungfu-tech/core must expose exactly the kungfu bin');
  const packages = inputs.npmRegistry.packages || [];
  if (
    packages.length !==
    inputs.npmRegistry.releaseInventory?.expectedPackageCount
  )
    issues.push(
      `npm Release registry must contain exactly ${inputs.npmRegistry.releaseInventory?.expectedPackageCount} packages`,
    );
  if (packages.some((row) => /(?:shifu|xinfa)/iu.test(row.name || '')))
    issues.push('Shifu and Xinfa must not enter the npm Release registry');

  const components = new Map(
    (contract.components || []).map((component) => [component.id, component]),
  );
  const productVersion = inputs.corePackage.version;
  for (const [id, cargo] of [
    ['shifu', inputs.shifuCargo],
    ['xinfa', inputs.xinfaCargo],
  ]) {
    const component = components.get(id);
    if (!component) {
      issues.push(`missing ${id} component contract`);
      continue;
    }
    const componentVersion = cargoVersion(cargo);
    if (!componentVersion || component.releaseTag !== `${id}-v{version}`)
      issues.push(`${id} version or release-tag authority drifted`);
    if (
      component.versionPolicy !== 'lockstep-with-kungfu' ||
      componentVersion !== productVersion
    )
      issues.push(
        `${id} user-visible version must match Kungfu ${productVersion}`,
      );
    for (const asset of component.assets || [])
      if (!inputs.workflow.includes(`asset: ${asset}`))
        issues.push(`${id} release workflow lacks ${asset}`);
  }

  for (const dependency of ['shifu', 'xinfa'])
    if (
      !new RegExp(
        `^${dependency} = \\{ path = "\\.\\./${dependency}" \\}$`,
        'mu',
      ).test(inputs.trunkCargo)
    )
      issues.push(`kungfu-trunk must link ${dependency} by workspace path`);
  for (const command of ['Shifu', 'Xinfa'])
    if (!inputs.trunkSource.includes(`NativeCommand::${command}`))
      issues.push(`trunk native routing lacks ${command}`);
  if (!inputs.shifuSource.includes('pub fn main_and_exit('))
    issues.push('Shifu must expose one reusable library entrypoint');
  if (!inputs.shifuSource.includes('InvocationMode::EmbeddedKungfu'))
    issues.push('Shifu embedded invocation mode is not observable');
  if (!inputs.shifuSource.includes('use `kungfu update`'))
    issues.push('embedded Shifu self-update must fail toward Kungfu update');

  for (const marker of [
    '"shifu-v*"',
    '"xinfa-v*"',
    'cargo build --locked --release',
    'actions/attest-build-provenance@0f67c3f4856b2e3261c31976d6725780e5e4c373',
    'component-release-bom.json',
    'SHA256SUMS',
    'adr0049-production-publication',
  ])
    if (!inputs.workflow.includes(marker))
      issues.push(`component release workflow lacks ${marker}`);

  const size = contract.sizePolicyMiB || {};
  if (
    size.optimizationTarget !== 70 ||
    size.normalCeiling !== 85 ||
    size.hardCeiling !== 100
  )
    issues.push('Core size policy must retain the 70/85/100 MiB thresholds');
  return issues;
}

function main() {
  if (process.argv.includes('--component-distribution')) {
    const componentIssues = validateComponentDistribution(
      loadComponentDistributionInputs(),
    );
    if (componentIssues.length > 0) {
      for (const message of componentIssues)
        console.error(`[component-distribution] ${message}`);
      process.exit(1);
    }
    console.log(
      '[component-distribution] contract, embedded routes, npm boundary, and protected releases passed',
    );
    return;
  }
  const issues = collectNpmRegistryIssues();
  if (issues.length > 0) {
    for (const entry of issues)
      console.error(`[npm-registry] ${entry.code}: ${entry.message}`);
    process.exit(1);
  }
  console.log(
    `[npm-registry] ${JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')).releaseInventory?.expectedPackageCount}-package Release inventory is coherent`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
