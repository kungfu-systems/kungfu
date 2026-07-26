#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { ownerFor } from '../../scripts/code-complexity-budget.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const MANIFEST_PATH =
  'framework/maintainability/semantic-amplification.manifest.json';
const ALLOWED_STATES = new Set([
  'proved',
  'partial',
  'missing',
  'invalidated',
  'retained-dependency',
]);

function git(args, binary = false) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: binary ? null : 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `git ${args.join(' ')} failed: ${String(result.stderr || '').trim()}`,
    );
  return result.stdout;
}

function gitLines(args) {
  return String(git(args))
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
}

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  return value;
}

function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(
      Buffer.isBuffer(value)
        ? value
        : Buffer.from(JSON.stringify(ordered(value))),
    )
    .digest('hex')}`;
}

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
}

function lines(bytes) {
  if (!bytes.length) return 0;
  let count = 1;
  for (const byte of bytes) if (byte === 10) count += 1;
  return bytes[bytes.length - 1] === 10 ? count - 1 : count;
}

function baselineBytes(ref, relative) {
  return Buffer.from(git(['show', `${ref}:${relative}`], true));
}

function currentBytes(relative) {
  return fs.readFileSync(path.join(ROOT, relative));
}

function changedPaths(ref) {
  return new Set([
    ...gitLines(['diff', '--name-only', ref, '--']),
    ...gitLines(['ls-files', '--others', '--exclude-standard']),
  ]);
}

function allFamilyPaths(family) {
  return [
    ...family.authority.sources,
    ...family.surfaces.map((surface) => surface.path),
  ];
}

function measurePath(relative, baselineRef, changed) {
  const current = currentBytes(relative);
  let baseline = null;
  try {
    baseline = baselineBytes(baselineRef, relative);
  } catch {
    baseline = null;
  }
  return {
    path: relative,
    currentLines: lines(current),
    baselineLines: baseline ? lines(baseline) : null,
    currentRoot: digest(current),
    baselineRoot: baseline ? digest(baseline) : null,
    changedSinceBaseline: changed.has(relative),
  };
}

function issue(code, family, target, message) {
  return { code, family, target, message };
}

function validateManifest(manifest, layers, changed) {
  const issues = [];
  const allowedRoles = new Set(manifest.rolePolicy.allowedProjectionRoles);
  const ids = new Set();
  for (const family of manifest.families || []) {
    if (!family.id || ids.has(family.id))
      issues.push(
        issue(
          'invalid-family-id',
          family.id || '',
          MANIFEST_PATH,
          'family ids must be present and unique',
        ),
      );
    ids.add(family.id);
    if (
      !family.authority ||
      !family.authority.id ||
      !Array.isArray(family.authority.sources) ||
      family.authority.sources.length === 0
    )
      issues.push(
        issue(
          'missing-authority',
          family.id,
          MANIFEST_PATH,
          'family must bind exactly one authority route with source files',
        ),
      );
    const seen = new Set();
    for (const relative of family.authority?.sources || []) {
      if (seen.has(relative))
        issues.push(
          issue(
            'duplicate-surface',
            family.id,
            relative,
            'path appears more than once in the family',
          ),
        );
      seen.add(relative);
      if (!fs.existsSync(path.join(ROOT, relative)))
        issues.push(
          issue(
            'missing-surface',
            family.id,
            relative,
            'authority source is missing',
          ),
        );
    }
    for (const surface of family.surfaces || []) {
      if (!allowedRoles.has(surface.role))
        issues.push(
          issue(
            'unknown-role',
            family.id,
            surface.path,
            `unknown projection role '${surface.role}'`,
          ),
        );
      if (seen.has(surface.path))
        issues.push(
          issue(
            'duplicate-surface',
            family.id,
            surface.path,
            'path cannot be both authority and projection',
          ),
        );
      seen.add(surface.path);
      if (!fs.existsSync(path.join(ROOT, surface.path)))
        issues.push(
          issue(
            'missing-surface',
            family.id,
            surface.path,
            'projection is missing',
          ),
        );
      if (
        surface.role === 'generated-projection' &&
        surface.generator &&
        !fs.existsSync(path.join(ROOT, surface.generator))
      )
        issues.push(
          issue(
            'missing-generator',
            family.id,
            surface.path,
            `declared generator is missing: ${surface.generator}`,
          ),
        );
    }
    for (const relative of seen) {
      if (!fs.existsSync(path.join(ROOT, relative))) continue;
      const owner = ownerFor(relative, layers);
      if (!owner)
        issues.push(
          issue(
            'unknown-owner',
            family.id,
            relative,
            'surface has no repository measurement owner',
          ),
        );
    }
    const mapped = new Set(seen);
    for (const relative of changed) {
      if (
        mapped.has(relative) ||
        !(family.discoveryRoots || []).some((root) =>
          relative.startsWith(root),
        ) ||
        !fs.existsSync(path.join(ROOT, relative))
      )
        continue;
      const stat = fs.statSync(path.join(ROOT, relative));
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue;
      const text = fs.readFileSync(path.join(ROOT, relative), 'utf8');
      if ((family.identityTokens || []).some((token) => text.includes(token)))
        issues.push(
          issue(
            'unmapped-semantic-surface',
            family.id,
            relative,
            'changed file references this semantic identity but has no declared authority/projection role',
          ),
        );
    }
  }
  for (const boundary of manifest.productionBoundaries || []) {
    if (!ALLOWED_STATES.has(boundary.state))
      issues.push(
        issue(
          'unknown-production-state',
          '',
          boundary.id || MANIFEST_PATH,
          `unknown production boundary state '${boundary.state}'`,
        ),
      );
    for (const relative of boundary.evidence || [])
      if (!fs.existsSync(path.join(ROOT, relative)))
        issues.push(
          issue(
            'missing-boundary-evidence',
            '',
            relative,
            `production boundary ${boundary.id} references missing evidence`,
          ),
        );
  }
  for (const record of manifest.decompositions || []) {
    for (const relative of [
      ...(record.original || []),
      record.target,
      ...(record.tests || []),
    ].filter(Boolean))
      if (!fs.existsSync(path.join(ROOT, relative)))
        issues.push(
          issue(
            'missing-decomposition-surface',
            '',
            relative,
            `decomposition ${record.id} references a missing path`,
          ),
        );
  }
  return issues;
}

function buildReport(manifest, layers) {
  const changed = changedPaths(manifest.baselineRef);
  const issues = validateManifest(manifest, layers, changed);
  const families = manifest.families.map((family) => {
    const measurements = allFamilyPaths(family).map((relative) =>
      measurePath(relative, manifest.baselineRef, changed),
    );
    const roles = {
      authority: family.authority.sources.length,
    };
    for (const surface of family.surfaces)
      roles[surface.role] = (roles[surface.role] || 0) + 1;
    return {
      id: family.id,
      owner: family.owner,
      authority: family.authority,
      authorityCount: 1,
      roles,
      amplification: {
        mappedSurfaces: measurements.length,
        nonAuthoritySurfaces:
          measurements.length - family.authority.sources.length,
        changedSurfaces: measurements.filter(
          (measurement) => measurement.changedSinceBaseline,
        ).length,
        changedPaths: measurements
          .filter((measurement) => measurement.changedSinceBaseline)
          .map((measurement) => measurement.path),
      },
      surfaces: family.surfaces,
      measurements,
      knownLimits: family.knownLimits,
      recovery: family.recovery,
    };
  });
  const mappedRoots = Object.fromEntries(
    families.map((family) => [
      family.id,
      digest(
        family.measurements.map((measurement) => ({
          path: measurement.path,
          root: measurement.currentRoot,
        })),
      ),
    ]),
  );
  return {
    schema: 'kungfu.semantic-amplification-report/v1',
    verdict: issues.length ? 'fail' : 'pass',
    authoritySemantics: 'navigation-only-projection-over-existing-authorities',
    manifestPath: MANIFEST_PATH,
    manifestRoot: digest(manifest),
    baselineRef: manifest.baselineRef,
    sourceRoot: digest(mappedRoots),
    roles: manifest.rolePolicy,
    summary: {
      families: families.length,
      authorities: families.length,
      mappedSurfaces: families.reduce(
        (total, family) => total + family.amplification.mappedSurfaces,
        0,
      ),
      changedMappedSurfaces: families.reduce(
        (total, family) => total + family.amplification.changedSurfaces,
        0,
      ),
      blockingIssues: issues.length,
    },
    families,
    productionBoundaries: manifest.productionBoundaries,
    decompositions: manifest.decompositions,
    issues,
  };
}

function findFamilies(report, manifest, query) {
  const lower = query.toLowerCase();
  const direct = new Set();
  for (const family of manifest.families) {
    if (
      family.id.toLowerCase().includes(lower) ||
      family.identityTokens.some((token) =>
        token.toLowerCase().includes(lower),
      ) ||
      allFamilyPaths(family).some(
        (relative) =>
          relative === query ||
          relative.startsWith(`${query}/`) ||
          query.startsWith(`${relative}/`),
      )
    )
      direct.add(family.id);
  }
  if (direct.size) return [...direct];
  for (const family of manifest.families) {
    for (const relative of allFamilyPaths(family)) {
      const absolute = path.join(ROOT, relative);
      if (
        fs.statSync(absolute).size <= 4 * 1024 * 1024 &&
        fs.readFileSync(absolute, 'utf8').toLowerCase().includes(lower)
      ) {
        direct.add(family.id);
        break;
      }
    }
  }
  return [...direct];
}

function queryTaskGraph(report, manifest, query, layers) {
  const ids = findFamilies(report, manifest, query);
  const families = report.families.filter((family) => ids.includes(family.id));
  const pathOwner = fs.existsSync(path.join(ROOT, query))
    ? ownerFor(query, layers)
    : '';
  return {
    schema: 'kungfu.maintainability-task-graph/v1',
    verdict: families.length || pathOwner ? 'pass' : 'unresolved',
    query,
    authoritySemantics: report.authoritySemantics,
    owner: pathOwner || [...new Set(families.map((family) => family.owner))],
    families: families.map((family) => ({
      id: family.id,
      authority: family.authority,
      projections: family.surfaces.filter((surface) =>
        ['generated-projection', 'thin-binding'].includes(surface.role),
      ),
      compatibilityReaders: family.surfaces.filter(
        (surface) => surface.role === 'compatibility-reader',
      ),
      likelyWriteSet: [
        ...family.authority.sources,
        ...family.surfaces
          .filter((surface) =>
            ['generated-projection', 'thin-binding'].includes(surface.role),
          )
          .map((surface) => surface.path),
      ],
      affectedTests: family.surfaces.filter((surface) =>
        ['test', 'conformance-oracle'].includes(surface.role),
      ),
      qualification: family.surfaces.filter(
        (surface) => surface.role === 'package-release',
      ),
      documentation: family.surfaces.filter(
        (surface) => surface.role === 'documentation',
      ),
      knownLimits: family.knownLimits,
      recovery: family.recovery,
    })),
    productionBoundaries: report.productionBoundaries,
    nextActions: families.length
      ? [
          'edit the existing authority route, not this navigation projection',
          'regenerate or validate every declared projection',
          'run affected tests, qualification, documentation, and known-limit checks independently',
        ]
      : [
          'query a repository path, semantic family id, schema id, symbol, capability, or exact error token',
        ],
  };
}

function parseArgs(argv) {
  const options = { write: false, check: false, json: false, query: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--write') options.write = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--query') options.query = argv[++index] || '';
    else throw new Error(`unknown argument '${arg}'`);
  }
  if (options.write && options.check)
    throw new Error('--write and --check are mutually exclusive');
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = readJson(MANIFEST_PATH);
  const layers = readJson('framework/core/architecture/layers.json');
  const report = buildReport(manifest, layers);
  if (options.query) {
    const taskGraph = queryTaskGraph(report, manifest, options.query, layers);
    process.stdout.write(`${JSON.stringify(taskGraph, null, 2)}\n`);
    if (taskGraph.verdict === 'unresolved') process.exitCode = 3;
    return;
  }
  const target = path.join(ROOT, manifest.reportPath);
  if (options.write) {
    if (report.issues.length)
      throw new Error('refusing to write a report with blocking issues');
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  } else if (options.check) {
    if (!fs.existsSync(target))
      throw new Error(`missing generated report ${manifest.reportPath}`);
    const expected = `${JSON.stringify(report, null, 2)}\n`;
    if (fs.readFileSync(target, 'utf8') !== expected)
      throw new Error(
        `stale generated report ${manifest.reportPath}; run maintainability:amplification --write in an isolated worktree`,
      );
  }
  if (options.json)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else
    process.stdout.write(
      `${report.verdict}: ${report.schema}; families=${report.summary.families}; surfaces=${report.summary.mappedSurfaces}; issues=${report.summary.blockingIssues}\n`,
    );
  if (report.issues.length) process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `semantic amplification: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

export { buildReport, findFamilies, queryTaskGraph, validateManifest };
