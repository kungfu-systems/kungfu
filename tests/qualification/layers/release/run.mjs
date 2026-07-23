#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeShifuGateEvidence } from '../../../../scripts/shifu-gate-evidence.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY = path.join(HERE, 'policy.json');

function fail(message) {
  throw new Error(message);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(
      `cannot read ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseArgs(argv) {
  const options = {
    formatReports: [],
    sdkReports: [],
    surfaceReports: [],
    evidenceRoot: '',
    publicationReport: '',
    report: '',
  };
  const repeated = {
    '--format-report': 'formatReports',
    '--sdk-report': 'sdkReports',
    '--surface-report': 'surfaceReports',
  };
  const singular = {
    '--evidence-root': 'evidenceRoot',
    '--publication-report': 'publicationReport',
    '--report': 'report',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: ./shifu layers:qualify:release -- [--evidence-root DIR | --format-report PATH --sdk-report PATH... --surface-report PATH...] --publication-report PATH [--report PATH]',
      );
      process.exit(0);
    }
    const key = repeated[arg] || singular[arg];
    if (!key) fail(`unknown argument '${arg}'`);
    index += 1;
    if (index >= argv.length) fail(`${arg} requires a path`);
    const value = path.resolve(argv[index]);
    if (Array.isArray(options[key])) options[key].push(value);
    else options[key] = value;
  }
  if (!options.publicationReport)
    fail('--publication-report is required for a release verdict');
  if (
    options.evidenceRoot &&
    (options.formatReports.length ||
      options.sdkReports.length ||
      options.surfaceReports.length)
  )
    fail('--evidence-root cannot be mixed with explicit qualification reports');
  return options;
}

function discoverEvidenceReports(root) {
  const result = { formatReports: [], sdkReports: [], surfaceReports: [] };
  const byName = {
    'layer-format-report.json': 'formatReports',
    'layer-sdk-report.json': 'sdkReports',
    'layer-surface-report.json': 'surfaceReports',
  };
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && byName[entry.name])
        result[byName[entry.name]].push(file);
    }
  };
  if (!fs.statSync(root).isDirectory())
    fail('--evidence-root must be a directory');
  visit(root);
  for (const files of Object.values(result)) files.sort();
  if (
    result.formatReports.length !== 3 ||
    result.sdkReports.length !== 3 ||
    result.surfaceReports.length !== 3
  )
    fail(
      'evidence root requires one format, SDK, and surface report from each of three platforms',
    );

  const portable = result.formatReports.map((file) =>
    readJson(file, 'format report'),
  );
  if (
    portable.some(
      (report) =>
        report.schema !== 'kungfu.layer-qualification.format-report/v1' ||
        report.status !== 'passing' ||
        report.platform !== 'portable' ||
        report.source?.tree_dirty !== false,
    )
  )
    fail('portable format reports are not clean passing evidence');
  const portableIdentities = new Set(
    portable.map(
      (report) =>
        `${report.source?.commit}:${report.qualification?.exact_artifact_sha256}`,
    ),
  );
  if (portableIdentities.size !== 1)
    fail('portable format reports diverge across platform evidence');
  result.formatReports = [result.formatReports[0]];
  return result;
}

function platformKey(report) {
  if (report.platform === 'portable') return 'portable';
  return `${report.platform}-${report.architecture}`;
}

function requireBoundSource(report, source, label) {
  const reportSource = report.source || {};
  if (reportSource.commit !== source.commit)
    fail(`${label} source commit does not match publication source`);
  if (reportSource.tree_dirty !== false)
    fail(`${label} must come from a clean source tree`);
}

function requireBudgets(measurements, dimensions, label) {
  for (const dimension of dimensions) {
    const raw = measurements?.[dimension];
    const value =
      raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      fail(`${label} lacks exact numeric ${dimension}`);
  }
}

function requireUniquePlatformReports(reports, schema, label) {
  const result = new Map();
  for (const report of reports) {
    if (report.schema !== schema) fail(`${label} has unexpected schema`);
    if (report.status !== 'passing') fail(`${label} is not passing`);
    const platform = platformKey(report);
    if (result.has(platform)) fail(`${label} duplicates platform ${platform}`);
    result.set(platform, report);
  }
  return result;
}

function qualificationFor(report, artifactId, reportKind) {
  if (reportKind === 'sdk')
    return report.qualifications?.find((row) => row.id === artifactId);
  if (reportKind === 'surface') return report.qualifications?.[artifactId];
  return report.qualification?.id === artifactId
    ? report.qualification
    : undefined;
}

function requirePublicationCoordinate(row, id) {
  if (!row.coordinate || !row.version || !row.url)
    fail(`${id} publication evidence is incomplete`);
  let url;
  try {
    url = new URL(row.url);
  } catch {
    fail(`${id} publication URL is invalid`);
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.invalid')
  )
    fail(`${id} publication URL must be an external HTTPS coordinate`);
}

function requirePublishedPlatformArtifacts(row, platform, qualification, id) {
  const assets = row.assets?.[platform];
  if (!Array.isArray(assets) || assets.length === 0)
    fail(`${id} lacks published assets for ${platform}`);
  const publishedDigests = new Set();
  for (const asset of assets) {
    if (!/^[a-f0-9]{64}$/.test(asset?.digest || ''))
      fail(`${id}/${platform} publication digest must be sha256`);
    let url;
    try {
      url = new URL(asset.url);
    } catch {
      fail(`${id}/${platform} publication asset URL is invalid`);
    }
    if (url.protocol !== 'https:' || url.hostname === 'localhost')
      fail(`${id}/${platform} publication asset URL must be external HTTPS`);
    publishedDigests.add(asset.digest);
  }
  const requiredDigests = [
    qualification.exact_artifact_sha256,
    qualification.platform_artifact_sha256,
  ].filter(Boolean);
  for (const digest of requiredDigests) {
    if (!publishedDigests.has(digest))
      fail(`${id}/${platform} exact qualified artifact is not published`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.evidenceRoot)
    Object.assign(options, discoverEvidenceReports(options.evidenceRoot));
  const policy = readJson(POLICY, 'release policy');
  if (policy.schema !== 'kungfu.layer-qualification.release-policy/v1')
    fail('unexpected release policy schema');
  const publication = readJson(options.publicationReport, 'publication report');
  if (publication.schema !== 'kungfu.layer-qualification.publication-report/v1')
    fail('unexpected publication report schema');
  if (publication.status !== 'passing')
    fail('publication report is not passing');
  if (!publication.source?.commit || !publication.release?.version)
    fail('publication report lacks source commit or release version');

  const reportSets = {
    format: requireUniquePlatformReports(
      options.formatReports.map((file) => readJson(file, 'format report')),
      'kungfu.layer-qualification.format-report/v1',
      'format report',
    ),
    sdk: requireUniquePlatformReports(
      options.sdkReports.map((file) => readJson(file, 'SDK report')),
      'kungfu.layer-qualification.sdk-report/v1',
      'SDK report',
    ),
    surface: requireUniquePlatformReports(
      options.surfaceReports.map((file) => readJson(file, 'surface report')),
      'kungfu.surface-qualification.report/v1',
      'surface report',
    ),
  };

  const artifacts = [];
  for (const [id, requirement] of Object.entries(policy.artifacts)) {
    const publicationRow = publication.artifacts?.[id];
    if (!publicationRow || publicationRow.status !== 'passing')
      fail(`${id} lacks passing publication evidence`);
    if (publicationRow.registry !== requirement.publication)
      fail(`${id} publication registry does not match policy`);
    requirePublicationCoordinate(publicationRow, id);
    if (publicationRow.version !== publication.release.version)
      fail(`${id} publication version does not match release version`);

    const platforms = [];
    for (const platform of requirement.platforms) {
      const sourceReport = reportSets[requirement.report].get(platform);
      if (!sourceReport)
        fail(`${id} lacks ${platform} ${requirement.report} report`);
      requireBoundSource(sourceReport, publication.source, `${id}/${platform}`);
      const qualification = qualificationFor(
        sourceReport,
        id,
        requirement.report,
      );
      if (!qualification || qualification.status !== 'passing')
        fail(`${id}/${platform} qualification is not passing`);
      requireBudgets(
        qualification.measurements,
        policy.budget_dimensions,
        `${id}/${platform}`,
      );
      if (
        requirement.report === 'surface' &&
        qualification.installer_uninstall?.status !== 'passing'
      )
        fail(`${id}/${platform} lacks installer-uninstall evidence`);
      requirePublishedPlatformArtifacts(
        publicationRow,
        platform,
        qualification,
        id,
      );
      platforms.push({
        platform,
        artifact_sha256: qualification.exact_artifact_sha256,
        measurements: qualification.measurements,
      });
    }
    artifacts.push({
      id,
      effective_status: 'passing',
      platforms,
      publication: publicationRow,
    });
  }

  const report = {
    schema: 'kungfu.layer-qualification.release-report/v1',
    status: 'passing',
    source: publication.source,
    release: publication.release,
    policy: path.relative(process.cwd(), POLICY),
    artifacts,
    artifact_status_counts: { passing: artifacts.length },
    boundary:
      'passing is computed from clean-source exact artifacts, every required platform, all six numeric budgets, installer-uninstall evidence for product surfaces, and immutable publication coordinates.',
  };
  if (options.report) {
    fs.mkdirSync(path.dirname(options.report), { recursive: true });
    fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
    writeShifuGateEvidence({
      schema: 'kungfu.layer-qualification.release-gate-evidence/v1',
      pointers: [
        { id: 'layer-release-report', file: options.report },
        {
          id: 'layer-publication-report',
          file: options.publicationReport,
        },
      ],
    });
  }
  console.log(
    `[layers:qualify:release] passing; artifacts=${artifacts.length}; source=${report.source.commit}; version=${report.release.version}`,
  );
}

try {
  main();
} catch (error) {
  console.error(
    `[layers:qualify:release] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
