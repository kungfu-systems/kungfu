#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
  throw new Error(message);
}

function walk(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

async function json(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) fail(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function remoteSha256(url) {
  const response = await fetch(url);
  if (!response.ok) fail(`${url} returned HTTP ${response.status}`);
  const hash = createHash('sha256');
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest('hex');
}

function platformKey(report) {
  return report.platform === 'portable'
    ? 'portable'
    : `${report.platform}-${report.architecture}`;
}

function readReports(root, basename) {
  return walk(root)
    .filter((file) => path.basename(file) === basename)
    .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
}

function qualification(report, id) {
  if (report.qualification?.id === id) return report.qualification;
  if (Array.isArray(report.qualifications))
    return report.qualifications.find((row) => row.id === id);
  return report.qualifications?.[id];
}

function requireSources(reports) {
  const commits = new Set(reports.map((report) => report.source?.commit));
  if (commits.size !== 1 || commits.has(undefined))
    fail('qualification reports do not share one source commit');
  if (reports.some((report) => report.source?.tree_dirty !== false))
    fail('qualification reports must come from clean source trees');
  return [...commits][0];
}

async function npmAsset(packageName, version) {
  const encoded = packageName.replace('/', '%2f');
  const metadata = await json(
    `https://registry.npmjs.org/${encoded}/${encodeURIComponent(version)}`,
  );
  const url = metadata.dist?.tarball;
  if (!url) fail(`${packageName}@${version} has no npm tarball`);
  return { digest: await remoteSha256(url), url };
}

function exactAsset(expected, assets, label) {
  const asset = assets.find((candidate) => candidate.digest === expected);
  if (!asset) fail(`${label} exact digest is absent from the public registry`);
  return asset;
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => args[args.indexOf(flag) + 1];
  const evidenceRoot = path.resolve(value('--evidence') || '');
  const repo = value('--repo');
  const tag = value('--tag');
  const version = value('--version');
  const reportPath = path.resolve(value('--report') || '');
  if (!evidenceRoot || !repo || !tag || !version || !reportPath)
    fail(
      'usage: verify-layer-publication.mjs --evidence DIR --repo OWNER/REPO --tag TAG --version VERSION --report FILE',
    );
  const formatReports = readReports(evidenceRoot, 'layer-format-report.json');
  const sdkReports = readReports(evidenceRoot, 'layer-sdk-report.json');
  const surfaceReports = readReports(evidenceRoot, 'layer-surface-report.json');
  if (
    formatReports.length !== 3 ||
    sdkReports.length !== 3 ||
    surfaceReports.length !== 3
  )
    fail(
      'expected one format, SDK, and surface report from each of three platforms',
    );
  const reports = [...formatReports, ...sdkReports, ...surfaceReports];
  const sourceCommit = requireSources(reports);
  const formatDigests = new Set(
    formatReports.map(
      (report) => qualification(report, 'format-spec').exact_artifact_sha256,
    ),
  );
  if (formatDigests.size !== 1)
    fail('portable format package differs across build platforms');

  const npm = {
    spec: await npmAsset('@kungfu-tech/spec', version),
    storage: await npmAsset('@kungfu-tech/storage', version),
  };
  for (const platform of ['darwin-arm64', 'linux-x64', 'win32-x64'])
    npm[platform] = await npmAsset(`@kungfu-tech/storage-${platform}`, version);
  const pythonVersion = version
    .replace(/-alpha\.(\d+)$/, 'a$1')
    .replace(/-beta\.(\d+)$/, 'b$1')
    .replace(/-rc\.(\d+)$/, 'rc$1');
  const pypi = await json(
    `https://pypi.org/pypi/kungfu-storage/${encodeURIComponent(pythonVersion)}/json`,
  );
  const pypiAssets = pypi.urls.map((entry) => ({
    digest: entry.digests.sha256,
    url: entry.url,
  }));
  const cargo = await json(
    `https://crates.io/api/v1/crates/kungfu-sdk/${encodeURIComponent(version)}`,
  );
  const cargoAsset = {
    digest: cargo.version.checksum,
    url: `https://crates.io${cargo.version.dl_path}`,
  };
  const githubHeaders = process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {};
  const release = await json(
    `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
    githubHeaders,
  );
  const githubAssets = release.assets.map((asset) => ({
    digest: String(asset.digest || '').replace(/^sha256:/, ''),
    url: asset.browser_download_url,
  }));
  if (githubAssets.some((asset) => !/^[a-f0-9]{64}$/.test(asset.digest)))
    fail('GitHub release assets lack server-side sha256 digests');

  const rows = {
    'format-spec': {
      status: 'passing',
      registry: 'npm',
      coordinate: '@kungfu-tech/spec',
      version,
      url: `https://www.npmjs.com/package/@kungfu-tech/spec/v/${version}`,
      assets: {},
    },
    'pypi-sdk': {
      status: 'passing',
      registry: 'pypi',
      coordinate: 'kungfu-storage',
      version,
      url: `https://pypi.org/project/kungfu-storage/${version}/`,
      assets: {},
    },
    'npm-sdk': {
      status: 'passing',
      registry: 'npm',
      coordinate: '@kungfu-tech/storage',
      version,
      url: `https://www.npmjs.com/package/@kungfu-tech/storage/v/${version}`,
      assets: {},
    },
    'cargo-sdk': {
      status: 'passing',
      registry: 'crates.io',
      coordinate: 'kungfu-sdk',
      version,
      url: `https://crates.io/crates/kungfu-sdk/${version}`,
      assets: {},
    },
    'cli-tui': {
      status: 'passing',
      registry: 'github-release',
      coordinate: `${repo}@${tag}`,
      version,
      url: release.html_url,
      assets: {},
    },
    gui: {
      status: 'passing',
      registry: 'github-release',
      coordinate: `${repo}@${tag}`,
      version,
      url: release.html_url,
      assets: {},
    },
    'assembled-distribution': {
      status: 'passing',
      registry: 'github-release',
      coordinate: `${repo}@${tag}`,
      version,
      url: release.html_url,
      assets: {},
    },
  };
  const portable = formatReports.find(
    (report) => report.platform === 'portable',
  );
  const formatQualification = qualification(portable, 'format-spec');
  rows['format-spec'].assets.portable = [
    exactAsset(
      formatQualification.exact_artifact_sha256,
      [npm.spec],
      'format-spec',
    ),
  ];
  for (const report of sdkReports) {
    const platform = platformKey(report);
    const py = qualification(report, 'pypi-sdk');
    const node = qualification(report, 'npm-sdk');
    const rust = qualification(report, 'cargo-sdk');
    rows['pypi-sdk'].assets[platform] = [
      exactAsset(py.exact_artifact_sha256, pypiAssets, `pypi-sdk/${platform}`),
    ];
    rows['npm-sdk'].assets[platform] = [
      exactAsset(
        node.exact_artifact_sha256,
        [npm.storage],
        `npm-sdk/${platform}`,
      ),
      exactAsset(
        node.platform_artifact_sha256,
        [npm[platform]],
        `npm-sdk/${platform} native`,
      ),
    ];
    rows['cargo-sdk'].assets[platform] = [
      exactAsset(
        rust.exact_artifact_sha256,
        [cargoAsset],
        `cargo-sdk/${platform}`,
      ),
    ];
  }
  for (const report of surfaceReports) {
    const platform = platformKey(report);
    for (const id of ['cli-tui', 'gui', 'assembled-distribution']) {
      const item = qualification(report, id);
      rows[id].assets[platform] = [
        exactAsset(
          item.exact_artifact_sha256,
          githubAssets,
          `${id}/${platform}`,
        ),
      ];
    }
  }
  const output = {
    schema: 'kungfu.layer-qualification.publication-report/v1',
    status: 'passing',
    source: { commit: sourceCommit },
    release: { version, tag, url: release.html_url },
    artifacts: rows,
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`[layer-publication] verified seven public rows for ${version}`);
}

main().catch((error) => {
  console.error(
    `[layer-publication] verify failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
