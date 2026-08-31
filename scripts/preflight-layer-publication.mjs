#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateStagedNpmArtifacts } from './npm-release-inventory.mjs';

function fail(message) {
  throw new Error(message);
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export async function requireAbsent(label, url, headers = {}) {
  const response = await fetch(url, { headers });
  if (response.status === 404)
    return { label, status: 'absent', coordinate: url };
  if (response.ok) fail(`${label} already exists at ${url}`);
  fail(`${label} preflight returned HTTP ${response.status} at ${url}`);
}

export async function requireAbsentOrExactCrate(
  label,
  url,
  expectedDigest,
  headers = {},
) {
  const response = await fetch(url, { headers });
  if (response.status === 404)
    return { label, status: 'absent', coordinate: url };
  if (!response.ok)
    fail(`${label} preflight returned HTTP ${response.status} at ${url}`);
  const metadata = await response.json();
  const actualDigest = metadata.version?.checksum;
  if (actualDigest !== expectedDigest)
    fail(
      `${label} already exists with digest ${actualDigest || 'missing'}, expected ${expectedDigest}`,
    );
  return {
    label,
    status: 'present-exact',
    coordinate: url,
    digest: actualDigest,
  };
}

export function pythonVersion(version) {
  return version
    .replace(/-alpha\.(\d+)$/, 'a$1')
    .replace(/-beta\.(\d+)$/, 'b$1')
    .replace(/-rc\.(\d+)$/, 'rc$1');
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => args[args.indexOf(flag) + 1];
  const manifestPath = path.resolve(value('--manifest') || '');
  const version = value('--version');
  const repo = value('--repo');
  const tag = value('--tag');
  const reportPath = path.resolve(value('--report') || '');
  const npmRegistryPath = path.resolve(value('--npm-registry') || '');
  if (
    !manifestPath ||
    !version ||
    !repo ||
    !tag ||
    !reportPath ||
    !npmRegistryPath
  )
    fail(
      'usage: preflight-layer-publication.mjs --manifest FILE --npm-registry FILE --version VERSION --repo OWNER/REPO --tag TAG --report FILE',
    );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const npmRegistry = JSON.parse(fs.readFileSync(npmRegistryPath, 'utf8'));
  const expectedNpmCount = npmRegistry.releaseInventory?.expectedPackageCount;
  const expectedArtifactCount = expectedNpmCount + 10;
  if (
    manifest.schema !== 'kungfu.layer-publication.staging-manifest/v1' ||
    manifest.artifacts?.length !== expectedArtifactCount
  )
    fail(
      `publication manifest is not the complete ${expectedArtifactCount}-artifact set`,
    );
  if (
    npmRegistry.schema !== 'kungfu.npm-release-package-registry/v1' ||
    npmRegistry.packages?.length !== expectedNpmCount
  )
    fail(
      `npm package registry is not the exact ${expectedNpmCount}-package Release inventory`,
    );
  validateStagedNpmArtifacts(manifest, npmRegistry, version);
  const checks = [];
  for (const { name: packageName } of npmRegistry.packages) {
    checks.push(
      await requireAbsent(
        `npm ${packageName}@${version}`,
        `https://registry.npmjs.org/${packageName.replace('/', '%2f')}/${encodeURIComponent(version)}`,
      ),
    );
  }
  checks.push(
    await requireAbsent(
      `PyPI kungfu-storage==${pythonVersion(version)}`,
      `https://pypi.org/pypi/kungfu-storage/${encodeURIComponent(pythonVersion(version))}/json`,
    ),
  );
  const cargoArtifacts = manifest.artifacts.filter(
    (artifact) => artifact.kind === 'cargo',
  );
  if (
    cargoArtifacts.length !== 1 ||
    !/^[a-f0-9]{64}$/.test(cargoArtifacts[0].digest)
  )
    fail('publication manifest must contain one digest-bound Cargo artifact');
  checks.push(
    await requireAbsentOrExactCrate(
      `crates.io kungfu-sdk@${version}`,
      `https://crates.io/api/v1/crates/kungfu-sdk/${encodeURIComponent(version)}`,
      cargoArtifacts[0].digest,
      { 'User-Agent': 'kungfu-adr0049-publication-preflight' },
    ),
  );
  const githubHeaders = {
    Accept: 'application/vnd.github+json',
    ...(process.env.GITHUB_TOKEN
      ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
      : {}),
  };
  const releaseResponse = await fetch(
    `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
    { headers: githubHeaders },
  );
  if (releaseResponse.status === 404) {
    checks.push({
      label: `GitHub release ${repo}@${tag}`,
      status: 'absent',
      coordinate: `https://github.com/${repo}/releases/tag/${tag}`,
    });
  } else if (releaseResponse.ok) {
    const release = await releaseResponse.json();
    const plannedNames = new Set(
      manifest.artifacts
        .filter((artifact) => artifact.kind === 'github')
        .map((artifact) => artifact.name),
    );
    const collisions = release.assets
      .map((asset) => asset.name)
      .filter((name) => plannedNames.has(name));
    if (collisions.length > 0)
      fail(
        `GitHub release already has planned assets: ${collisions.join(', ')}`,
      );
    checks.push({
      label: `GitHub release ${repo}@${tag}`,
      status: 'present-without-collisions',
      coordinate: release.html_url,
    });
  } else {
    fail(`GitHub release preflight returned HTTP ${releaseResponse.status}`);
  }
  const report = {
    schema: 'kungfu.layer-publication.preflight-report/v1',
    status: 'passing',
    version,
    release_tag: tag,
    staging_manifest_sha256: sha256(manifestPath),
    checks,
    boundary: `Preflight proves the exact ${expectedArtifactCount}-artifact set, including all ${expectedNpmCount} npm packages, and requires target versions to be absent, except an immutable crates.io version may already exist only with the exact staged digest. It does not publish, reserve, overwrite, or delete any coordinate.`,
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[layer-publication] preflight passing; checks=${checks.length}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      `[layer-publication] preflight failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
