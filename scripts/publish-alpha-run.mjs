#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [runId, ...extraArgs] = process.argv.slice(2);
if (!/^\d+$/.test(runId || '') || extraArgs.length !== 0) {
  console.error('usage: node scripts/publish-alpha-run.mjs <candidate-run-id>');
  process.exit(2);
}

const repo = process.env.GH_REPO;
if (!repo) throw new Error('GH_REPO is required');

function gh(args, { allowFailure = false } = {}) {
  const result = spawnSync('gh', args, { encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `gh ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result;
}

function ghJson(args) {
  return JSON.parse(gh(args).stdout);
}

function filesUnder(root) {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

const workRoot = fs.mkdtempSync(
  path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'kungfu-alpha-release-'),
);
const downloadRoot = path.join(workRoot, 'downloads');
const assetsRoot = path.join(workRoot, 'assets');
fs.mkdirSync(downloadRoot, { recursive: true });
fs.mkdirSync(assetsRoot, { recursive: true });

try {
  const run = ghJson(['api', `repos/${repo}/actions/runs/${runId}`]);
  if (run.conclusion !== 'success') {
    throw new Error(`Build run ${runId} did not succeed`);
  }

  const passportRoot = path.join(downloadRoot, 'release-candidate');
  gh([
    'run',
    'download',
    runId,
    '--repo',
    repo,
    '--dir',
    passportRoot,
    '--pattern',
    'kungfu-release-candidate-*',
  ]);
  const passportPath = filesUnder(downloadRoot).find(
    (file) => path.basename(file) === 'release-candidate-passport.json',
  );
  if (!passportPath) {
    throw new Error(`Build run ${runId} has no release candidate passport`);
  }
  const passport = JSON.parse(fs.readFileSync(passportPath, 'utf8'));
  const version = passport.target.version;
  if (!/^\d+\.\d+\.\d+-alpha\.\d+$/u.test(version || '')) {
    throw new Error(`Build run ${runId} has no Alpha version`);
  }
  const tag = `v${version}`;

  if (!Array.isArray(passport.platformMatrix)) {
    throw new Error(`Build run ${runId} has no platform artifact matrix`);
  }
  for (const platform of passport.platformMatrix) {
    gh([
      'run',
      'download',
      runId,
      '--repo',
      repo,
      '--dir',
      path.join(downloadRoot, platform.artifactName),
      '--name',
      platform.artifactName,
    ]);
  }

  const artifactList = ghJson([
    'api',
    `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
  ]);
  const credentialArtifact = artifactList.artifacts.find((artifact) =>
    artifact.name.startsWith('kungfu-macos-credential-'),
  );
  if (credentialArtifact) {
    gh([
      'run',
      'download',
      runId,
      '--repo',
      repo,
      '--dir',
      path.join(downloadRoot, credentialArtifact.name),
      '--name',
      credentialArtifact.name,
    ]);
  }

  const downloadedFiles = filesUnder(downloadRoot);
  const retiredProductArtifact =
    /^(?:kungfu-episodes-cli-.*\.(?:tar\.gz|zip|qualification\.json)|Kungfu(?:[ -])Episodes.*\.(?:dmg|AppImage|exe))$/u;
  const retiredSource = downloadedFiles.find((sourcePath) =>
    retiredProductArtifact.test(path.basename(sourcePath)),
  );
  if (retiredSource) {
    throw new Error(
      `retired product artifact name is not publishable: ${path.basename(retiredSource)}`,
    );
  }

  const releaseAsset =
    /^(?:kungfu-cli-.*\.(?:tar\.gz|zip|qualification\.json)|Kungfu-\d+\.\d+\.\d+.*\.AppImage|Kungfu Setup \d+\.\d+\.\d+.*\.exe|Kungfu-\d+\.\d+\.\d+.*-macos-arm64\.(?:dmg|zip))$/u;
  const releaseFiles = downloadedFiles
    .filter((sourcePath) => releaseAsset.test(path.basename(sourcePath)))
    .sort((left, right) => {
      const credentialName = credentialArtifact?.name || '';
      return (
        Number(left.includes(credentialName)) -
        Number(right.includes(credentialName))
      );
    });
  for (const sourcePath of releaseFiles) {
    const sourceName = path.basename(sourcePath);
    const assetName = sourceName.replace('Kungfu Setup ', 'Kungfu.Setup.');
    fs.copyFileSync(sourcePath, path.join(assetsRoot, assetName));
  }

  const assets = filesUnder(assetsRoot);
  if (assets.length === 0) {
    throw new Error(`Build run ${runId} has no publishable release assets`);
  }

  const pullRequestNumber = passport.pullRequest?.number;
  if (!pullRequestNumber) {
    throw new Error(`Build run ${runId} has no pull request number`);
  }
  const pullRequest = ghJson([
    'api',
    `repos/${repo}/pulls/${pullRequestNumber}`,
  ]);
  if (!pullRequest.merge_commit_sha) {
    throw new Error(`Pull request ${pullRequestNumber} is not merged`);
  }
  const existingRelease = gh(['release', 'view', tag, '--repo', repo], {
    allowFailure: true,
  });
  if (existingRelease.status !== 0) {
    gh([
      'release',
      'create',
      tag,
      '--repo',
      repo,
      '--target',
      pullRequest.merge_commit_sha,
      '--title',
      tag,
      '--draft',
      '--prerelease=false',
      '--latest',
      '--notes',
      `Built and qualified by run ${runId}.`,
    ]);
  }

  gh(['release', 'upload', tag, ...assets, '--repo', repo, '--clobber']);
  gh([
    'release',
    'edit',
    tag,
    '--repo',
    repo,
    '--draft=false',
    '--prerelease=false',
    '--latest',
  ]);
  console.log(
    `Published https://github.com/${repo}/releases/tag/${tag} from Build run ${runId}`,
  );
} finally {
  fs.rmSync(workRoot, { recursive: true, force: true });
}
