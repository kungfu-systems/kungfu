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

  gh([
    'run',
    'download',
    runId,
    '--repo',
    repo,
    '--dir',
    downloadRoot,
    '--pattern',
    'kungfu-release-candidate-*',
  ]);
  const passportPath = filesUnder(downloadRoot).find(
    (file) => path.basename(file) === 'release-candidate-passport.json',
  );
  const passport = JSON.parse(fs.readFileSync(passportPath, 'utf8'));
  const version = passport.target.version;
  const tag = `v${version}`;

  for (const platform of passport.platformMatrix) {
    gh([
      'run',
      'download',
      runId,
      '--repo',
      repo,
      '--dir',
      downloadRoot,
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
      downloadRoot,
      '--name',
      credentialArtifact.name,
    ]);
  }

  const releaseAsset =
    /^(?:kungfu-episodes-cli-.*\.(?:tar\.gz|zip|qualification\.json)|Kungfu Episodes-.*\.AppImage|Kungfu Episodes Setup .*\.exe|Kungfu-Episodes-.*-macos-arm64\.(?:dmg|zip))$/u;
  for (const sourcePath of filesUnder(downloadRoot)) {
    const sourceName = path.basename(sourcePath);
    if (!releaseAsset.test(sourceName)) continue;
    const assetName = sourceName
      .replace('Kungfu Episodes Setup ', 'Kungfu.Episodes.Setup.')
      .replace('Kungfu Episodes-', 'Kungfu.Episodes-');
    fs.copyFileSync(sourcePath, path.join(assetsRoot, assetName));
  }

  const pullRequest = ghJson([
    'api',
    `repos/${repo}/pulls/${passport.pullRequest.number}`,
  ]);
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
      '--prerelease',
      '--notes',
      `Built and qualified by run ${runId}.`,
    ]);
  }

  const assets = filesUnder(assetsRoot);
  gh(['release', 'upload', tag, ...assets, '--repo', repo, '--clobber']);
  gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--prerelease']);
  console.log(
    `Published https://github.com/${repo}/releases/tag/${tag} from Build run ${runId}`,
  );
} finally {
  fs.rmSync(workRoot, { recursive: true, force: true });
}
