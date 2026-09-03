#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  ROOT,
  activeProjection,
  checkProjections,
  deriveProjection,
  readAuthority,
  validateAuthority,
} from './version-line-authority.mjs';

const NARROW_PATTERNS = [
  /(?:dev|alpha|release)\/v\d+\/v\d+\.\d+/gu,
  /buildchain\/candidate-ledger\/v\d+\/v\d+\.\d+/gu,
  /publish-gate\/major\/v\d+\/v\d+\.\d+/gu,
  /kungfu-(?:build-)?v\d+(?:-[a-z0-9-]+)?/gu,
  /(?:alpha|stable|major)-v\d+\b(?!-(?:contract|runtime))/gu,
];

function posix(relative) {
  return relative.split(path.sep).join('/');
}

function walk(root, relative = '') {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    const normalized = posix(child);
    if (
      entry.isDirectory() &&
      ['.git', 'node_modules', 'build', 'dist'].includes(entry.name)
    ) {
      continue;
    }
    if (entry.isDirectory()) files.push(...walk(root, child));
    else if (entry.isFile()) files.push(normalized);
  }
  return files;
}

function sourceFiles(root) {
  const repository = spawnSync(
    'git',
    ['-C', root, 'rev-parse', '--show-toplevel'],
    { encoding: 'utf8' },
  );
  if (
    repository.status === 0 &&
    fs.realpathSync(repository.stdout.trim()) === fs.realpathSync(root)
  ) {
    const tracked = spawnSync('git', ['-C', root, 'ls-files', '-z'], {
      encoding: 'buffer',
    });
    if (tracked.status !== 0) {
      throw new Error(
        `cannot enumerate tracked version-line sources: ${tracked.stderr.toString('utf8').trim()}`,
      );
    }
    return tracked.stdout
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map(posix)
      .sort();
  }
  return walk(root).sort();
}

function isFixtureOrTest(file) {
  return (
    /(?:^|\/)(?:tests?|fixtures?)(?:\/|$)/u.test(file) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)
  );
}

function isImmutableEvidence(file, prefixes) {
  return prefixes.some((prefix) => file.startsWith(prefix));
}

function isNarrative(file) {
  return /\.(?:md|mdx)$/u.test(file) && !file.startsWith('.github/workflows/');
}

export function narrowMatches(text) {
  return NARROW_PATTERNS.flatMap((pattern) => [...text.matchAll(pattern)]).map(
    (match) => match[0],
  );
}

export function scanNarrowBindings(
  root = ROOT,
  sourceBoundaries = {},
  allowedActiveMatches = new Set(),
) {
  const activeProjections = new Set(
    sourceBoundaries.activeProjectionPaths || [],
  );
  const historicalEvidence = new Set(
    sourceBoundaries.historicalEvidencePaths || [],
  );
  const immutablePrefixes = sourceBoundaries.immutableEvidencePrefixes || [];
  const violations = [];
  const admitted = [];
  for (const file of sourceFiles(root)) {
    if (
      isFixtureOrTest(file) ||
      isImmutableEvidence(file, immutablePrefixes) ||
      isNarrative(file)
    ) {
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    const matches = [...new Set(narrowMatches(text))];
    if (!matches.length) continue;
    if (historicalEvidence.has(file)) {
      admitted.push({ file, matches });
    } else if (activeProjections.has(file)) {
      const allowed = matches.filter((match) =>
        allowedActiveMatches.has(match),
      );
      const disallowed = matches.filter(
        (match) => !allowedActiveMatches.has(match),
      );
      if (allowed.length) admitted.push({ file, matches: allowed });
      if (disallowed.length) violations.push({ file, matches: disallowed });
    } else {
      violations.push({ file, matches });
    }
  }
  return { admitted, violations };
}

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function requireContains(text, fragment, label) {
  if (!text.includes(fragment)) throw new Error(`${label} drift`);
}

function validateWorkflowProjections(root, projection) {
  const nativeMatrix = projection.runnerRouting.matrices.native;
  const native = JSON.stringify(nativeMatrix);
  const devPatrol = JSON.stringify(
    nativeMatrix.filter(({ id }) => id !== 'linux-arm64'),
  );
  const line = projection.lines.find(({ id }) => id === projection.activeLine);
  if (!line) throw new Error('active line projection is missing');
  const nativePreset = `kungfu-v${line.major}-native`;
  const build = fs.readFileSync(
    path.join(root, '.github/workflows/build.yml'),
    'utf8',
  );
  const release = fs.readFileSync(
    path.join(root, '.github/workflows/release-new-version.yml'),
    'utf8',
  );
  const patrol = fs.readFileSync(
    path.join(root, '.github/workflows/dev-verify-patrol.yml'),
    'utf8',
  );
  requireContains(
    build,
    `inputs.platforms-json || '${native}'`,
    'build matrix',
  );
  requireContains(build, 'runner-preset: custom', 'build runner preset');
  requireContains(
    release,
    `runner-preset: ${nativePreset}`,
    'release runner preset',
  );
  requireContains(patrol, devPatrol, 'dev patrol matrix');
  requireContains(patrol, 'runner-preset: custom', 'dev patrol runner preset');
  const stable = fs.readFileSync(
    path.join(root, '.github/workflows/stable-candidate-patrol.yml'),
    'utf8',
  );
  for (const output of ['stable-branch', 'candidate-ledger']) {
    requireContains(
      stable,
      `needs.resolve-version-line.outputs.${output}`,
      `stable patrol ${output}`,
    );
  }
}

function validateStaticProjections(root, authority, line, projection) {
  const policy = fs.readFileSync(
    path.join(root, '.buildchain/buildchain.toml'),
    'utf8',
  );
  requireContains(
    policy,
    `ledger_ref = "${line.candidateLedger}"`,
    'Buildchain stable ledger',
  );
  const actionlint = fs.readFileSync(
    path.join(root, '.github/actionlint.yaml'),
    'utf8',
  );
  const admittedLabels = new Set(
    authority.runnerRouting.compatibilityAliases.flatMap(({ labels }) =>
      labels.filter((value) => value.startsWith('kungfu-build-')),
    ),
  );
  const configuredLabels = actionlint.match(/kungfu-build-[a-z0-9-]+/gu) || [];
  if (
    configuredLabels.length === 0 ||
    configuredLabels.some((label) => !admittedLabels.has(label))
  ) {
    throw new Error('actionlint runner compatibility label drift');
  }
  const baseline = readJson(
    root,
    'framework/core/architecture/dev-gate-latency-baseline.json',
  );
  if (
    baseline.authorityClassification !== 'historical-measurement' ||
    baseline.versionLineAuthorityRoot !== authority.authorityRoot ||
    baseline.branch !== line.branches.dev
  ) {
    throw new Error(
      'dev latency baseline is not root-bound historical evidence',
    );
  }
  const continuation = readJson(
    root,
    'docs/qualification/stable-release-continuation.contract.json',
  );
  if (
    continuation.authorityClassification !== 'immutable-qualified-rehearsal' ||
    continuation.versionLineAuthorityRoot !== authority.authorityRoot
  ) {
    throw new Error('stable continuation is not classified immutable evidence');
  }
  const targets = Object.fromEntries(
    registry.rulesetContracts.map(({ channel, target }) => [channel, target]),
  );
  if (
    targets.alpha !== `refs/heads/${line.branches.alpha}` ||
    targets.stable !== `refs/heads/${line.branches.stable}` ||
    targets.major !== `refs/heads/${line.branches.majorPublicationGate}`
  ) {
    throw new Error('publication ruleset target drift');
  }
  validateWorkflowProjections(root, projection);
}

export function checkVersionLineAuthority(root = ROOT) {
  const authorityPath = path.join(
    root,
    'framework/version-line/version-line-authority.json',
  );
  const authority = validateAuthority(
    JSON.parse(fs.readFileSync(authorityPath, 'utf8')),
  );
  const projection = deriveProjection(authority);
  if (root === ROOT) checkProjections(authority);
  else {
    const checked = readJson(
      root,
      'framework/version-line/version-line-projections.json',
    );
    if (JSON.stringify(checked) !== JSON.stringify(projection)) {
      throw new Error('version-line projection drift');
    }
  }
  const line = projection.lines.find(({ id }) => id === projection.activeLine);
  if (!line) throw new Error('active line projection is missing');
  validateStaticProjections(root, authority, line, projection);
  const allowedActiveMatches = new Set(
    narrowMatches(
      JSON.stringify({
        lines: projection.lines,
        runnerPresets: [`kungfu-v${line.major}-native`],
        runnerCompatibilityAliases:
          authority.runnerRouting.compatibilityAliases,
      }),
    ),
  );
  const scan = scanNarrowBindings(
    root,
    authority.sourceBoundaries,
    allowedActiveMatches,
  );
  if (scan.violations.length) {
    throw new Error(
      `unclassified narrow operational settings: ${scan.violations
        .map(({ file, matches }) => `${file} [${matches.join(', ')}]`)
        .join('; ')}`,
    );
  }
  return { authorityRoot: authority.authorityRoot, line, scan };
}

function main() {
  const result = checkVersionLineAuthority();
  console.log(
    `version-line authority passed: ${result.line.id}; admitted exact projections=${result.scan.admitted.length}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `[version-line-authority] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
