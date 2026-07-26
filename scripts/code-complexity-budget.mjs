#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_PATH = 'framework/maintainability/code-complexity-policy.json';

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
    .update(JSON.stringify(ordered(value)))
    .digest('hex')}`;
}

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
}

function git(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: options.binary ? null : 'utf8',
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
    .map((item) => item.trim())
    .filter(Boolean);
}

function lineCount(bytes) {
  if (!bytes.length) return 0;
  let lines = 1;
  for (const byte of bytes) if (byte === 10) lines += 1;
  if (bytes[bytes.length - 1] === 10) lines -= 1;
  return lines;
}

function language(pathname) {
  const extension = path.posix.extname(pathname).toLowerCase();
  if (
    ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'].includes(
      extension,
    )
  )
    return 'c-cpp';
  if (extension === '.py') return 'python';
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx'].includes(extension))
    return 'javascript-typescript';
  if (extension === '.rs') return 'rust';
  if (['.sh', '.cmd', '.ps1'].includes(extension) || pathname === 'shifu')
    return 'shell';
  if (
    ['.cmake', '.gyp', '.gypi'].includes(extension) ||
    path.posix.basename(pathname) === 'CMakeLists.txt'
  )
    return 'build-declaration';
  return 'declarative';
}

function isEligible(pathname, policy) {
  return (
    policy.specialEligibleNames.includes(path.posix.basename(pathname)) ||
    policy.eligibleExtensions.includes(
      path.posix.extname(pathname).toLowerCase(),
    )
  );
}

function matchesAny(pathname, patterns) {
  return patterns.some((pattern) => pathname.includes(pattern));
}

function generatedMarker(bytes) {
  return bytes
    .subarray(0, 2048)
    .toString('utf8')
    .split('\n')
    .slice(0, 24)
    .find((line) =>
      /^\s*(?:\/\/|#|\/\*|\*)\s*(?:@generated|generated file|auto-generated|automatically generated|do not edit)\b/iu.test(
        line,
      ),
    );
}

function classify(pathname, bytes) {
  const basename = path.posix.basename(pathname);
  const extension = path.posix.extname(pathname).toLowerCase();
  if (
    pathname.startsWith('.kungfu/') ||
    matchesAny(pathname, [
      'docs/qualification/evidence/',
      '/evidence/',
      '/qualification/reports/',
      '/retained/',
    ])
  )
    return 'retained-evidence';
  if (
    matchesAny(pathname, [
      'framework/core/.deps/',
      '/node_modules/',
      '/third_party/',
      '/third-party/',
      '/vendor/',
      '/vendored/',
    ])
  )
    return 'vendored-source';
  if (
    /(?:^|[/_.-])generated(?:[/_.-]|$)/u.test(pathname) ||
    generatedMarker(bytes)
  )
    return 'generated-projection';
  if (
    /(?:^|\/)(?:test|tests|fixtures?|__tests__)(?:\/|$)/u.test(pathname) ||
    /(?:^|[._-])test(?:[._-]|$)/u.test(basename) ||
    /(?:^|[._-])spec(?:[._-]|$)/u.test(basename) ||
    /^test_/u.test(basename)
  )
    return 'test-or-fixture';
  if (
    [
      '.fbs',
      '.gyp',
      '.gypi',
      '.json',
      '.jsonc',
      '.lock',
      '.proto',
      '.toml',
      '.yaml',
      '.yml',
    ].includes(extension) ||
    extension === '.cmake' ||
    basename === 'CMakeLists.txt'
  )
    return 'declarative-schema-or-table';
  if (
    (/\/include\//u.test(pathname) &&
      ['.h', '.hh', '.hpp', '.hxx'].includes(extension)) ||
    /(?:^|\/)(?:main|index|__init__)\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|js|mjs|cjs|ts|tsx|py|rs)$/u.test(
      pathname,
    ) ||
    pathname === 'shifu' ||
    pathname === 'shifu.cmd'
  )
    return 'public-header-or-entrypoint';
  if (
    [
      '.c',
      '.cc',
      '.cjs',
      '.cmd',
      '.cpp',
      '.cxx',
      '.h',
      '.hh',
      '.hpp',
      '.hxx',
      '.js',
      '.mjs',
      '.ps1',
      '.py',
      '.rs',
      '.sh',
      '.ts',
      '.tsx',
    ].includes(extension)
  )
    return 'first-party-handwritten-implementation';
  return '';
}

function hasGeneratedProvenance(pathname, bytes) {
  const marker = generatedMarker(bytes);
  return Boolean(
    marker &&
      /(?:generated by|generator|source(?:_path)?)[\s:=]+[^\s]+/iu.test(marker),
  );
}

function owns(rule, file) {
  const included =
    (rule.include_files || []).includes(file) ||
    (rule.include_prefixes || []).some((prefix) => file.startsWith(prefix));
  return (
    included &&
    !(rule.exclude_files || []).includes(file) &&
    !(rule.exclude_prefixes || []).some((prefix) => file.startsWith(prefix))
  );
}

function ownerFor(pathname, layers) {
  if (pathname.startsWith('framework/core/')) {
    const relative = pathname.slice('framework/core/'.length);
    const owners = layers.components.filter((component) =>
      owns(component, relative),
    );
    if (owners.length === 1) return owners[0].owner;
    if (pathname.startsWith('framework/core/architecture/'))
      return 'core/architecture';
    if (pathname.startsWith('framework/core/tests/'))
      return 'core/qualification';
    if (
      pathname.startsWith('framework/core/.gyp/') ||
      pathname === 'framework/core/conanfile.py' ||
      pathname === 'framework/core/CMakeLists.txt'
    )
      return 'core/build';
    if (pathname.startsWith('framework/core/lib/')) return 'core/bindings';
    return owners.length > 1 ? '' : 'core/package';
  }
  const segments = pathname.split('/');
  const top = segments[0];
  if (top === 'framework' && segments[1]) return `framework/${segments[1]}`;
  if (top === 'extensions' && segments[1])
    return `extension/${segments.slice(1, Math.min(3, segments.length - 1)).join('/') || segments[1]}`;
  if (top === 'crates' && segments[1]) return `crate/${segments[1]}`;
  if (top === 'developer' && segments[1]) return `developer/${segments[1]}`;
  if (top === 'product') return 'product/assembly';
  if (top === 'scripts' || pathname === 'shifu' || pathname === 'shifu.cmd')
    return 'shifu/source-tooling';
  if (top === 'docs') return 'kungfu/docs';
  if (top === '.github') return 'kungfu/release-workflow';
  if (top === 'config') return 'kungfu/config';
  if (top === 'tests') return 'kungfu/qualification';
  if (top === 'examples') return 'kungfu/examples';
  if (top === 'types') return 'kungfu/public-types';
  if (top === '.kungfu') return 'kungfu/retained-native-evidence';
  if (
    [
      '.buildchain',
      '.xinfa',
      'package.json',
      'pnpm-lock.yaml',
      'Cargo.lock',
      'Cargo.toml',
    ].includes(top)
  )
    return 'kungfu/repository-contract';
  if (!pathname.includes('/')) return 'kungfu/repository-contract';
  return '';
}

function baselineBytes(ref, pathname, changed) {
  const absolute = path.join(ROOT, pathname);
  if (!changed.has(pathname) && fs.existsSync(absolute))
    return fs.readFileSync(absolute);
  return Buffer.from(git(['show', `${ref}:${pathname}`], { binary: true }));
}

function measureBaseline(policy, layers) {
  const ref = policy.baselineRef;
  const paths = gitLines(['ls-tree', '-r', '--name-only', ref]);
  const changed = new Set(
    gitLines(['diff', '--name-only', ref, '--']).concat(
      gitLines(['ls-files', '--others', '--exclude-standard']),
    ),
  );
  return paths
    .filter((pathname) => isEligible(pathname, policy))
    .map((pathname) => {
      const bytes = baselineBytes(ref, pathname, changed);
      return {
        path: pathname,
        class: classify(pathname, bytes),
        generatedProvenance: hasGeneratedProvenance(pathname, bytes),
        language: language(pathname),
        owner: ownerFor(pathname, layers),
        lines: lineCount(bytes),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function measureCurrent(policy, layers) {
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
        owner: ownerFor(pathname, layers),
        lines: lineCount(bytes),
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

function buildBaseline(policy, layers) {
  const files = measureBaseline(policy, layers);
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
  return {
    schema: 'kungfu.code-complexity-budget-baseline/v1',
    policyRoot: digest(policy),
    baselineRef: policy.baselineRef,
    classification: 'ordered-policy-and-content-marker/v1',
    calibration: policy.calibration,
    summary: summarize(files),
    groups,
    grandfathered,
    files,
    issues,
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

function waiverIssues(record, policy) {
  const issues = [];
  const waiver = record.value;
  for (const field of policy.waiver.requiredFields)
    if (
      waiver[field] === undefined ||
      waiver[field] === null ||
      waiver[field] === ''
    )
      issues.push({
        code: 'invalid-waiver',
        path: record.file,
        message: `missing ${field}`,
      });
  if (waiver.schema !== policy.waiver.schema)
    issues.push({
      code: 'invalid-waiver',
      path: record.file,
      message: 'schema mismatch',
    });
  if (waiver.requested_by && waiver.approved_by === waiver.requested_by)
    issues.push({
      code: 'self-approved-waiver',
      path: record.file,
      message: 'requester and approver must be independent',
    });
  const expiry = Date.parse(waiver.expires_at_or_review_by || '');
  if (!Number.isFinite(expiry) || expiry <= Date.now())
    issues.push({
      code: 'expired-waiver',
      path: record.file,
      message: 'expiry or review-by cut is missing, invalid, or expired',
    });
  if (
    !Array.isArray(waiver.paths_or_scope) ||
    waiver.paths_or_scope.length === 0
  )
    issues.push({
      code: 'invalid-waiver',
      path: record.file,
      message: 'paths_or_scope must be a non-empty exact path list',
    });
  return issues;
}

function validWaiverFor(issue, current, waivers, policy) {
  for (const record of waivers) {
    if (waiverIssues(record, policy).length) continue;
    const waiver = record.value;
    if (
      issue.path === current.path &&
      waiver.paths_or_scope.includes(issue.path) &&
      waiver.file_class === current.class &&
      waiver.owner === current.owner &&
      waiver.requested_measurement === current.lines &&
      waiver.allowed_delta >= current.lines - waiver.baseline_measurement
    )
      return record.file;
  }
  return '';
}

function regressionIssues(files, baseline, policy = {}) {
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
    const previous = baselineByPath.get(current.path);
    if (
      !previous &&
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
        baselineLines: previous.lines,
        currentLines: current.lines,
        hardBudget: budget.hard,
        message: `file crossed hard budget ${budget.hard}: ${previous.lines} -> ${current.lines}`,
      });
  }
  const newHandwrittenByOwner = new Map();
  const baselinePaths = new Set(baseline.files.map((file) => file.path));
  for (const current of files) {
    if (baselinePaths.has(current.path)) continue;
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
      paths,
      message: `${owner} adds ${paths.length} handwritten files; limit is ${helperLimit}`,
    });
  }
  return issues;
}

function checkCurrent(policy, layers, baseline) {
  const files = measureCurrent(policy, layers);
  const issues = validateMeasured(files);
  if (baseline.policyRoot !== digest(policy))
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
  issues.push(...regressionIssues(files, baseline, policy));
  const waivers = loadWaivers(policy);
  for (const waiver of waivers) issues.push(...waiverIssues(waiver, policy));
  const waived = [];
  const blocking = [];
  for (const issue of issues) {
    const current = files.find((file) => file.path === issue.path);
    const waiver =
      current && issue.code !== 'invalid-waiver'
        ? validWaiverFor(issue, current, waivers, policy)
        : '';
    if (waiver) waived.push({ ...issue, waiver });
    else blocking.push(issue);
  }
  return {
    schema: 'kungfu.code-complexity-budget-report/v1',
    policyRoot: digest(policy),
    baselineRef: baseline.baselineRef,
    sourceCommit: String(git(['rev-parse', 'HEAD'])).trim(),
    mode: 'p1-regression-ratchet',
    verdict: blocking.length ? 'fail' : 'pass',
    summary: summarize(files),
    groupBudgets: baseline.groups,
    blocking,
    waived,
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
  if (options.calibrate) {
    const baseline = buildBaseline(policy, layers);
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
  const report = checkCurrent(policy, layers, baseline);
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
  buildBaseline,
  checkCurrent,
  classify,
  hasGeneratedProvenance,
  language,
  ownerFor,
  percentile,
  regressionIssues,
  validWaiverFor,
  validateMeasured,
  waiverIssues,
};
