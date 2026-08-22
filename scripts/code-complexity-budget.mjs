#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  baselineIntegrityIssues,
  baselineMeasurementRoot,
  digest,
  digestBytes,
  enrichIssue,
  measurementPolicyRoot,
  protectedBaselineIssues,
  validWaiverFor,
  waiverIssues,
} from '../framework/maintainability/complexity-governance.mjs';
import {
  baselineBytes,
  baselineChangedPaths,
  classify,
  git,
  gitLines,
  gitResult,
  hasGeneratedProvenance,
  isEligible,
  language,
  lineCount,
  ownerFor,
} from '../framework/maintainability/source-analysis-kernel.mjs';
import { devMergeBaseCandidates } from './candidate-timeline-events.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_PATH = 'framework/maintainability/code-complexity-policy.json';
const RETIRED_COMPLEXITY_SIGNING_MARKERS = [
  ['ed25519-6688', '12bf28659460'],
  ['ed25519-9ff2', '1f6e6f64c985'],
  ['kungfu-origin-complexity-', 'transition-review'],
  ['kungfu-origin-complexity-', 'transition-review-v2'],
  ['requiresIndependent', 'SignedReceipt'],
  ['trusted', 'Authorities'],
  ['approvalReceipt', 'Schema'],
  ['kungfu.code-complexity-budget-', 'approval-receipt/v1'],
  ['baselineTransition', 'Authorization'],
  ['signedWaiver', 'Fixture'],
  ['invalid-approval-', 'signature'],
].map((parts) => parts.join(''));
const RETIRED_COMPLEXITY_SIGNING_FIELDS = [
  ['approval', '_receipt'],
  ['authority', '_id'],
  ['key', '_id'],
  ['public', '_key_pem'],
  ['authorization', '_root'],
].map((parts) => parts.join(''));
const COMPLEXITY_GOVERNANCE_PATHS = [
  'framework/maintainability/baseline-transitions/',
  'framework/maintainability/code-complexity-policy.json',
  'framework/maintainability/complexity-governance.mjs',
  'framework/maintainability/waivers/',
  'scripts/code-complexity-budget.mjs',
  'scripts/code-complexity-budget.test.mjs',
];

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
}

function readJsonAt(ref, relative) {
  return JSON.parse(String(git(['show', `${ref}:${relative}`])));
}

export function protectedBaselineCandidates(
  policy,
  env = process.env,
  options = {},
) {
  const configured =
    env[policy.baselineGovernance.protectedRefEnv] ||
    policy.baselineGovernance.protectedRef;
  if (configured !== 'origin/HEAD') return [configured];
  return devMergeBaseCandidates({
    env,
    symbolicRemoteHead: options.symbolicRemoteHead,
  });
}

export function complexitySigningResidueAudit(entries) {
  const findings = [];
  for (const entry of entries) {
    const scoped = COMPLEXITY_GOVERNANCE_PATHS.some(
      (candidate) =>
        entry.path === candidate || entry.path.startsWith(candidate),
    );
    const markers = scoped
      ? [
          ...RETIRED_COMPLEXITY_SIGNING_MARKERS,
          ...RETIRED_COMPLEXITY_SIGNING_FIELDS,
        ]
      : RETIRED_COMPLEXITY_SIGNING_MARKERS;
    for (const marker of markers)
      if (entry.bytes.includes(Buffer.from(marker)))
        findings.push({ path: entry.path, marker });
  }
  return {
    schema: 'kungfu.code-complexity-signing-residue-audit/v1',
    verdict: findings.length ? 'fail' : 'pass',
    markerCount:
      RETIRED_COMPLEXITY_SIGNING_MARKERS.length +
      RETIRED_COMPLEXITY_SIGNING_FIELDS.length,
    globalMarkers: RETIRED_COMPLEXITY_SIGNING_MARKERS,
    scopedFields: RETIRED_COMPLEXITY_SIGNING_FIELDS,
    findings,
  };
}

function trackedComplexitySigningResidueAudit() {
  const entries = String(git(['ls-files', '-z']))
    .split('\0')
    .filter(Boolean)
    .map((pathname) => ({
      path: pathname,
      bytes: fs.readFileSync(path.join(ROOT, pathname)),
    }));
  return complexitySigningResidueAudit(entries);
}

function measureBaseline(policy, layers, ownership = []) {
  const ref = policy.baselineRef;
  const paths = gitLines(['ls-tree', '-r', '--name-only', ref]);
  // The budget needs a path inventory, not similarity scores. Disabling rename
  // detection keeps partial merge-group history from hydrating deleted,
  // ineligible blobs while still exposing both sides of every rename.
  const changed = baselineChangedPaths(ref);
  return paths
    .filter((pathname) => isEligible(pathname, policy))
    .map((pathname) => {
      const bytes = baselineBytes(ref, pathname, changed);
      return {
        path: pathname,
        class: classify(pathname, bytes),
        generatedProvenance: hasGeneratedProvenance(pathname, bytes),
        language: language(pathname),
        owner: ownerFor(pathname, layers, ownership),
        lines: lineCount(bytes),
        contentRoot: digestBytes(bytes),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function measureCurrent(policy, layers, ownership = []) {
  return [
    ...new Set(
      gitLines(['ls-files']).concat(
        gitLines(['ls-files', '--others', '--exclude-standard']),
      ),
    ),
  ]
    .filter(
      (pathname) =>
        isEligible(pathname, policy) &&
        fs.existsSync(path.join(ROOT, pathname)) &&
        fs.statSync(path.join(ROOT, pathname)).isFile(),
    )
    .map((pathname) => {
      const bytes = fs.readFileSync(path.join(ROOT, pathname));
      return {
        path: pathname,
        class: classify(pathname, bytes),
        generatedProvenance: hasGeneratedProvenance(pathname, bytes),
        language: language(pathname),
        owner: ownerFor(pathname, layers, ownership),
        lines: lineCount(bytes),
        contentRoot: digestBytes(bytes),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] || 0;
}

function groupKey(file) {
  return `${file.class}:${file.language}`;
}

function calibrate(files, policy) {
  const grouped = new Map();
  for (const file of files) {
    const key = groupKey(file);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(file);
  }
  return Object.fromEntries(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entries]) => {
        const values = entries.map((entry) => entry.lines);
        const small =
          entries.length < policy.calibration.minimumGroupSizeForPercentiles;
        return [
          key,
          {
            class: entries[0].class,
            language: entries[0].language,
            population: entries.length,
            soft: small
              ? Math.max(...values)
              : percentile(values, policy.calibration.softPercentile),
            hard: small
              ? Math.max(...values)
              : percentile(values, policy.calibration.hardPercentile),
            calibration: small
              ? policy.calibration.smallGroupPolicy
              : `p${policy.calibration.softPercentile * 100}/p${policy.calibration.hardPercentile * 100}`,
          },
        ];
      }),
  );
}

function summarize(files) {
  const summary = {};
  for (const file of files) {
    summary[file.class] ||= { files: 0, lines: 0 };
    const item = summary[file.class];
    item.files += 1;
    item.lines += file.lines;
  }
  return Object.fromEntries(
    Object.entries(summary).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function validateMeasured(files) {
  const issues = [];
  for (const file of files) {
    if (!file.class)
      issues.push({
        code: 'unknown-classification',
        path: file.path,
        message: 'eligible file has no declared class',
      });
    if (!file.owner)
      issues.push({
        code: 'unknown-owner',
        path: file.path,
        message: 'eligible file has no measurement owner route',
      });
  }
  return issues;
}

function buildBaseline(policy, layers, ownership = []) {
  const files = measureBaseline(policy, layers, ownership);
  const issues = validateMeasured(files);
  const groups = calibrate(files, policy);
  const grandfathered = files
    .filter(
      (file) =>
        file.lines > (groups[groupKey(file)]?.hard ?? Number.POSITIVE_INFINITY),
    )
    .map((file) => ({
      path: file.path,
      class: file.class,
      language: file.language,
      owner: file.owner,
      baselineLines: file.lines,
      hardBudget: groups[groupKey(file)].hard,
    }));
  const baseline = {
    schema: 'kungfu.code-complexity-budget-baseline/v1',
    policyRoot: measurementPolicyRoot(policy),
    baselineRef: policy.baselineRef,
    classification: 'ordered-policy-and-content-marker/v1',
    calibration: policy.calibration,
    summary: summarize(files),
    groups,
    grandfathered,
    files,
    issues,
  };
  return {
    ...baseline,
    measurementRoot: baselineMeasurementRoot(baseline),
  };
}

function loadWaivers(policy) {
  const directory = path.join(ROOT, policy.waiverDirectory);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      file: `${policy.waiverDirectory}/${name}`,
      value: JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')),
    }));
}

function regressionIssues(
  files,
  baseline,
  policy = {},
  renamedFrom = new Map(),
  candidateAddedPaths = null,
) {
  const issues = [];
  const baselineByPath = new Map(
    baseline.files.map((file) => [file.path, file]),
  );
  for (const current of files) {
    if (!current.class || !current.owner) continue;
    const budget = baseline.groups[groupKey(current)];
    if (!budget) {
      issues.push({
        code: 'invalid-baseline',
        path: current.path,
        message: `missing calibrated group ${groupKey(current)}`,
      });
      continue;
    }
    const previousPath = renamedFrom.get(current.path) || current.path;
    const previous = baselineByPath.get(previousPath);
    const measurementPaths =
      previousPath === current.path
        ? [current.path]
        : [previousPath, current.path];
    const ownerRenameAllowed =
      previousPath !== current.path &&
      policy.antiGaming?.allowedOwnerRenamePrefixes?.some(
        (route) =>
          typeof route?.from === 'string' &&
          typeof route?.to === 'string' &&
          (previous?.owner === route.from ||
            previous?.owner?.startsWith(`${route.from}/`)) &&
          current.owner ===
            `${route.to}${previous.owner.slice(route.from.length)}`,
      );
    if (
      previous &&
      (previous.class !== current.class ||
        previous.language !== current.language ||
        (previous.owner !== current.owner && !ownerRenameAllowed))
    )
      issues.push({
        code: 'classification-or-owner-relabeled',
        path: current.path,
        paths: measurementPaths,
        previousClass: previous.class,
        currentClass: current.class,
        previousLanguage: previous.language,
        currentLanguage: current.language,
        previousOwner: previous.owner,
        currentOwner: current.owner,
        message:
          'existing source changed class, language, or owner instead of retiring responsibility',
      });
    if (
      !previous &&
      (candidateAddedPaths === null || candidateAddedPaths.has(current.path)) &&
      current.class === 'first-party-handwritten-implementation' &&
      current.lines > budget.hard
    )
      issues.push({
        code: 'new-handwritten-file-over-hard-budget',
        path: current.path,
        baselineLines: 0,
        currentLines: current.lines,
        hardBudget: budget.hard,
        message: `new handwritten file has ${current.lines} lines; hard budget is ${budget.hard}`,
      });
    else if (
      previous &&
      previous.lines > budget.hard &&
      current.lines > previous.lines
    )
      issues.push({
        code: 'grandfathered-file-grew',
        path: current.path,
        paths: measurementPaths,
        baselineLines: previous.lines,
        currentLines: current.lines,
        hardBudget: budget.hard,
        message: `grandfathered file grew from ${previous.lines} to ${current.lines} lines`,
      });
    else if (
      previous &&
      previous.lines <= budget.hard &&
      current.lines > budget.hard
    )
      issues.push({
        code: 'existing-file-crossed-hard-budget',
        path: current.path,
        paths: measurementPaths,
        baselineLines: previous.lines,
        currentLines: current.lines,
        hardBudget: budget.hard,
        message: `file crossed hard budget ${budget.hard}: ${previous.lines} -> ${current.lines}`,
      });
  }
  const newHandwrittenByOwner = new Map();
  const baselinePaths = new Set(baseline.files.map((file) => file.path));
  for (const current of files) {
    if (baselinePaths.has(current.path) || renamedFrom.has(current.path))
      continue;
    if (candidateAddedPaths !== null && !candidateAddedPaths.has(current.path))
      continue;
    if (current.class === 'first-party-handwritten-implementation') {
      if (!newHandwrittenByOwner.has(current.owner))
        newHandwrittenByOwner.set(current.owner, []);
      newHandwrittenByOwner.get(current.owner).push(current.path);
    }
    if (
      current.class === 'generated-projection' &&
      policy.antiGaming?.newGeneratedProjectionRequiresProvenance &&
      !current.generatedProvenance
    )
      issues.push({
        code: 'unproven-generated-projection',
        path: current.path,
        message:
          'new generated projection lacks a path-bound generator/source marker',
      });
  }
  const helperLimit =
    policy.antiGaming?.maxNewHandwrittenFilesPerOwner ??
    Number.POSITIVE_INFINITY;
  for (const [owner, paths] of newHandwrittenByOwner) {
    if (paths.length <= helperLimit) continue;
    issues.push({
      code: 'new-helper-proliferation',
      path: paths[0],
      owner,
      paths: [...paths].sort(),
      message: `${owner} adds ${paths.length} handwritten files; limit is ${helperLimit}`,
    });
  }
  const currentByPath = new Map(files.map((file) => [file.path, file]));
  const renamedSources = new Set(renamedFrom.values());
  const added = files.filter(
    (file) =>
      !baselinePaths.has(file.path) &&
      (candidateAddedPaths === null || candidateAddedPaths.has(file.path)),
  );
  const deleted = baseline.files.filter(
    (file) => !currentByPath.has(file.path) && !renamedSources.has(file.path),
  );
  for (const previous of deleted) {
    if (previous.class !== 'first-party-handwritten-implementation') continue;
    const sameOwner = added.filter(
      (file) =>
        file.owner === previous.owner &&
        !['test-or-fixture', 'retained-evidence'].includes(file.class),
    );
    const generated = sameOwner.filter(
      (file) =>
        file.class === 'generated-projection' ||
        file.class === 'vendored-source',
    );
    if (
      generated.reduce((total, file) => total + file.lines, 0) >=
      Math.max(40, previous.lines * 0.5)
    )
      issues.push({
        code: 'generated-or-vendor-laundering',
        path: previous.path,
        paths: [previous.path, ...generated.map((file) => file.path)].sort(),
        owner: previous.owner,
        message:
          'deleted handwritten responsibility reappears under a generated or vendor classification',
      });
    const handwritten = sameOwner.filter(
      (file) => file.class === 'first-party-handwritten-implementation',
    );
    if (
      handwritten.length > 1 &&
      handwritten.reduce((total, file) => total + file.lines, 0) >=
        Math.max(80, previous.lines * 0.8)
    )
      issues.push({
        code: 'responsibility-preserving-split',
        path: previous.path,
        paths: [previous.path, ...handwritten.map((file) => file.path)].sort(),
        owner: previous.owner,
        message:
          'deleted hotspot responsibility is preserved across multiple new helpers',
      });
  }
  return issues;
}

function softBudgetWarnings(files, baseline, renamedFrom = new Map()) {
  const baselineByPath = new Map(
    baseline.files.map((file) => [file.path, file]),
  );
  const warnings = [];
  for (const current of files) {
    const previousPath = renamedFrom.get(current.path) || current.path;
    const previous = baselineByPath.get(previousPath);
    const budget = baseline.groups[groupKey(current)];
    if (
      !budget ||
      current.class !== 'first-party-handwritten-implementation' ||
      current.lines <= budget.soft ||
      (previous && previous.lines > budget.soft)
    )
      continue;
    warnings.push({
      code: 'soft-budget-crossed',
      path: current.path,
      paths:
        previousPath === current.path
          ? [current.path]
          : [previousPath, current.path],
      owner: current.owner,
      softBudget: budget.soft,
      hardBudget: budget.hard,
      baselineLines: previous?.lines || 0,
      currentLines: current.lines,
      message: `file crossed soft budget ${budget.soft}: ${previous?.lines || 0} -> ${current.lines}`,
    });
  }
  return warnings;
}

export function dispositionSoftWarnings(warnings, files, policy) {
  const currentByPath = new Map(files.map((file) => [file.path, file]));
  const declared = policy.advisoryDispositions || {};
  const active = warnings.map((warning) => {
    const declaration = declared[warning.path] || null;
    return {
      ...warning,
      thresholdClass: 'advisory',
      protectedMainlineBudget: warning.hardBudget,
      protectedMainlineState:
        warning.currentLines <= warning.hardBudget
          ? 'within-budget'
          : 'exception-required',
      disposition: declaration?.action || 'retained-under-mainline-budget',
      extractedPaths: declaration?.extractedPaths || [],
      residualResponsibility:
        declaration?.residualResponsibility ||
        'Retained source responsibility requires exact-head cohesion review.',
      independentExactHeadReviewRequired: true,
    };
  });
  const activePaths = new Set(active.map(({ path: pathname }) => pathname));
  const resolved = Object.entries(declared)
    .filter(([pathname]) => !activePaths.has(pathname))
    .map(([pathname, declaration]) => {
      const current = currentByPath.get(pathname);
      return {
        path: pathname,
        disposition: declaration.action,
        extractedPaths: declaration.extractedPaths || [],
        residualResponsibility: declaration.residualResponsibility,
        currentLines: current?.lines ?? null,
        state: current ? 'below-advisory-or-no-new-crossing' : 'missing',
      };
    });
  return { active, resolved };
}

export function renameEvidenceBase(policy) {
  const baselineRef = String(policy?.baselineRef || '').trim();
  if (!/^[0-9a-f]{40}$/u.test(baselineRef)) {
    throw new Error(
      'complexity rename evidence requires an exact baseline ref',
    );
  }
  return baselineRef;
}

export function composeRenameEvidence(statusLines) {
  const renamedFrom = new Map();
  for (const line of String(statusLines || '').split('\n')) {
    const [status, previous, current] = line.split('\t');
    if (/^R\d{3}$/u.test(status || '') && previous && current) {
      const baselinePath = renamedFrom.get(previous) || previous;
      renamedFrom.delete(previous);
      renamedFrom.set(current, baselinePath);
      continue;
    }
    if (/^[AD]$/u.test(status || '') && previous) renamedFrom.delete(previous);
  }
  return renamedFrom;
}

function currentRenameMap(policy) {
  const result = gitResult(
    [
      'log',
      '--reverse',
      '--topo-order',
      '--format=',
      '--name-status',
      '--find-renames=50%',
      `${renameEvidenceBase(policy)}..HEAD`,
      '--',
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) return new Map();
  return composeRenameEvidence(result.stdout);
}

function checkCurrent(policy, layers, baseline, ownership = []) {
  const files = measureCurrent(policy, layers, ownership);
  const renamedFrom = currentRenameMap(policy);
  const protectedCandidates = policy.baselineGovernance
    ? protectedBaselineCandidates(policy)
    : [];
  const protectedRef =
    protectedCandidates.find((candidate) => {
      const result = gitResult([
        'rev-parse',
        '--verify',
        '--quiet',
        `${candidate}^{commit}`,
      ]);
      return result.status === 0;
    }) || protectedCandidates[0];
  const protectedPaths = protectedRef
    ? new Set(gitLines(['ls-tree', '-r', '--name-only', protectedRef]))
    : null;
  const candidateAddedPaths = protectedPaths
    ? new Set(
        files
          .map((file) => file.path)
          .filter((pathname) => !protectedPaths.has(pathname)),
      )
    : null;
  const issues = validateMeasured(files);
  const residueAudit = trackedComplexitySigningResidueAudit();
  issues.push(
    ...residueAudit.findings.map((finding) => ({
      code: 'retired-complexity-signing-residue',
      path: finding.path,
      message: `retired complexity signing marker remains: ${finding.marker}`,
    })),
  );
  const recomputedBaseline = buildBaseline(policy, layers, ownership);
  issues.push(
    ...baselineIntegrityIssues(
      baseline,
      recomputedBaseline,
      policy.baselinePath,
    ),
  );
  if (baseline.policyRoot !== measurementPolicyRoot(policy))
    issues.push({
      code: 'invalid-baseline',
      path: policy.baselinePath,
      message: 'baseline policy root does not match current policy',
    });
  if (baseline.baselineRef !== policy.baselineRef)
    issues.push({
      code: 'invalid-baseline',
      path: policy.baselinePath,
      message: 'baseline ref does not match current policy',
    });
  issues.push(
    ...regressionIssues(
      files,
      baseline,
      policy,
      renamedFrom,
      candidateAddedPaths,
    ),
  );
  const requester = String(git(['show', '-s', '--format=%ae', 'HEAD'])).trim();
  const evaluationTime = new Date();
  const waivers = loadWaivers(policy);
  for (const waiver of waivers)
    issues.push(
      ...waiverIssues(waiver, policy, {
        evaluationTime,
        requester,
      }),
    );
  const scopedIssues = issues.map((issue) =>
    enrichIssue(issue, baseline.files, files),
  );
  const rawSoftWarnings = softBudgetWarnings(files, baseline, renamedFrom).map(
    (issue) => enrichIssue(issue, baseline.files, files),
  );
  const advisory = dispositionSoftWarnings(rawSoftWarnings, files, policy);
  const waived = [];
  const blocking = [];
  if (policy.baselineGovernance) {
    try {
      const protectedPolicy = readJsonAt(protectedRef, POLICY_PATH);
      const protectedBaseline = readJsonAt(
        protectedRef,
        protectedPolicy.baselinePath,
      );
      const transitionDirectory = policy.baselineGovernance.transitionDirectory;
      const transitions = fs.existsSync(path.join(ROOT, transitionDirectory))
        ? fs
            .readdirSync(path.join(ROOT, transitionDirectory))
            .filter((name) => name.endsWith('.json'))
            .sort()
            .map((name) => ({
              file: `${transitionDirectory}/${name}`,
              value: readJson(`${transitionDirectory}/${name}`),
            }))
        : [];
      scopedIssues.push(
        ...protectedBaselineIssues({
          protectedPolicy,
          protectedBaseline,
          candidatePolicy: policy,
          candidateBaseline: baseline,
          transitions,
          evaluationTime,
          requester,
        }).map((issue) => enrichIssue(issue, baseline.files, files)),
      );
    } catch (error) {
      scopedIssues.push(
        enrichIssue(
          {
            code: 'protected-baseline-unavailable',
            path: POLICY_PATH,
            paths: [POLICY_PATH],
            message: `cannot read protected baseline '${protectedRef}': ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          baseline.files,
          files,
        ),
      );
    }
  }
  for (const issue of scopedIssues) {
    const current =
      files.find((file) => file.path === issue.path) ||
      issue.currentMeasurement
        .map((item) => files.find((file) => file.path === item.path))
        .find(Boolean);
    const waiver =
      current && issue.code !== 'invalid-waiver'
        ? validWaiverFor(issue, current, waivers, policy, {
            evaluationTime,
            requester,
          })
        : '';
    if (waiver) waived.push({ ...issue, waiver });
    else blocking.push(issue);
  }
  return {
    schema: 'kungfu.code-complexity-budget-report/v1',
    policyRoot: digest(policy),
    baselineRef: baseline.baselineRef,
    sourceCommit: String(git(['rev-parse', 'HEAD'])).trim(),
    mode: 'protected-mainline-budget-ratchet',
    verdict: blocking.length ? 'fail' : 'pass',
    evaluationTime: evaluationTime.toISOString(),
    requester,
    summary: summarize(files),
    groupBudgets: baseline.groups,
    thresholdSemantics: policy.thresholdSemantics,
    baselineMeasurementRoot: baseline.measurementRoot || '',
    blocking,
    waived,
    softWarnings: advisory.active,
    resolvedAdvisories: advisory.resolved,
    residueAudit,
    files,
  };
}

function parseArgs(argv) {
  const options = { calibrate: false, write: false, json: false };
  for (const arg of argv.filter((item) => item !== '--')) {
    if (arg === '--calibrate') options.calibrate = true;
    else if (arg === '--write') options.write = true;
    else if (arg === '--json') options.json = true;
    else throw new Error(`unknown argument '${arg}'`);
  }
  if (options.write && !options.calibrate)
    throw new Error('--write is valid only with --calibrate');
  return options;
}

function print(value, json) {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else {
    process.stdout.write(
      `${value.verdict || (value.issues.length ? 'fail' : 'pass')}: ${value.schema}\n`,
    );
    for (const issue of value.blocking || value.issues || [])
      process.stdout.write(`${issue.code}: ${issue.path}: ${issue.message}\n`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const policy = readJson(POLICY_PATH);
  const layers = readJson('framework/core/architecture/layers.json');
  const ownership = readJson(
    'framework/maintainability/abstraction-integrity.manifest.json',
  ).ownership;
  if (options.calibrate) {
    const baseline = buildBaseline(policy, layers, ownership);
    if (options.write) {
      const target = path.join(ROOT, policy.baselinePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(baseline, null, 2)}\n`);
    }
    print(
      {
        ...baseline,
        written: Boolean(options.write),
        verdict: baseline.issues.length ? 'fail' : 'pass',
      },
      options.json,
    );
    if (baseline.issues.length) process.exitCode = 1;
    return;
  }
  const baseline = readJson(policy.baselinePath);
  const report = checkCurrent(policy, layers, baseline, ownership);
  print(report, options.json);
  if (report.blocking.length) process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `code complexity budget: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

export {
  baselineChangedPaths,
  buildBaseline,
  checkCurrent,
  classify,
  git,
  hasGeneratedProvenance,
  isEligible,
  language,
  ownerFor,
  percentile,
  regressionIssues,
  validWaiverFor,
  validateMeasured,
  waiverIssues,
};
