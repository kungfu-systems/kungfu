#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { prepareGateMeasurementHistory } from './prepare-gate-measurement-history.mjs';
import {
  lifecycleEnvironment,
  runShifuWithCache,
  runShifuWithCacheAsync,
} from './run-shifu-lifecycle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXECUTION_PROFILES = path.join(
  ROOT,
  'docs',
  'qualification',
  'gates',
  'execution-profiles.json',
);
const SUMMARY = path.join(
  ROOT,
  'product',
  'release',
  'qualification',
  'layer-qualification-summary.json',
);
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TREE_PATTERN = /^[0-9a-f]{40}$/u;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

function digest(value) {
  const content = Buffer.isBuffer(value)
    ? value
    : Buffer.from(JSON.stringify(canonical(value)));
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function fileDigest(file) {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes = 0;
    do {
      bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes > 0) hash.update(buffer.subarray(0, bytes));
    } while (bytes > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function loadExecutionProfile(name, file = EXECUTION_PROFILES) {
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (document.schema !== 'kungfu.qualification-execution-profiles/v1')
    throw new Error(`unsupported execution profile schema in ${file}`);
  const parameters = document.profiles?.[name];
  if (!parameters) throw new Error(`unknown execution profile: ${name}`);
  for (const field of [
    'budgetSeconds',
    'upstreamBudgetSeconds',
    'reserveSeconds',
    'fuzzSecondsPerTarget',
    'episodeTimeoutSeconds',
  ]) {
    if (!Number.isInteger(parameters[field]) || parameters[field] <= 0)
      throw new Error(`${name}.${field} must be a positive integer`);
  }
  if (
    parameters.reserveSeconds + parameters.upstreamBudgetSeconds >=
    parameters.budgetSeconds
  )
    throw new Error(
      `${name}.reserveSeconds plus upstreamBudgetSeconds must be below budgetSeconds`,
    );
  if (!/^[a-z0-9][a-z0-9-]*$/.test(parameters.episodeProfile))
    throw new Error(`${name}.episodeProfile is invalid`);
  const episodePath = path.join(
    ROOT,
    'framework',
    'core',
    'tests',
    'qualification',
    'episode',
    'profiles',
    `${parameters.episodeProfile}.json`,
  );
  if (!fs.existsSync(episodePath))
    throw new Error(`${name}.episodeProfile does not exist`);
  return {
    name,
    parameters: structuredClone(parameters),
    policyDigest: digest(document),
    policyRef: path.relative(ROOT, file).split(path.sep).join('/'),
    reusePolicy: structuredClone(document.reusePolicy),
  };
}

export function parseExecutionProfile(argv) {
  return parseReleaseQualificationOptions(argv).executionProfile;
}

export function parseReleaseQualificationOptions(argv) {
  let name = '';
  let nativeUpgradePolicy = 'required';
  let nativeUpgradePolicySeen = false;
  let artifactScope = 'product';
  let artifactScopeSeen = false;
  const sourceOnlyEvidence = {
    receiptRoot: '',
    sourceTree: '',
    policyRoot: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      ![
        '--execution-profile',
        '--native-upgrade-policy',
        '--artifact-scope',
        '--source-only-receipt-root',
        '--source-only-source-tree',
        '--source-only-policy-root',
      ].includes(arg)
    )
      throw new Error(`unknown release qualification option: ${arg}`);
    index += 1;
    if (index >= argv.length) throw new Error(`${arg} requires a value`);
    if (arg === '--execution-profile') {
      if (name) throw new Error('--execution-profile may be specified once');
      name = argv[index];
      continue;
    }
    if (arg === '--native-upgrade-policy') {
      if (nativeUpgradePolicySeen)
        throw new Error('--native-upgrade-policy may be specified once');
      nativeUpgradePolicySeen = true;
      nativeUpgradePolicy = argv[index];
      continue;
    }
    if (arg === '--artifact-scope') {
      if (artifactScopeSeen)
        throw new Error('--artifact-scope may be specified once');
      artifactScopeSeen = true;
      artifactScope = argv[index];
      continue;
    }
    const sourceField = {
      '--source-only-receipt-root': 'receiptRoot',
      '--source-only-source-tree': 'sourceTree',
      '--source-only-policy-root': 'policyRoot',
    }[arg];
    if (sourceOnlyEvidence[sourceField])
      throw new Error(`${arg} may be specified once`);
    sourceOnlyEvidence[sourceField] = argv[index];
  }
  if (!name)
    throw new Error(
      '--execution-profile is required (alpha, release-candidate, or full-patrol)',
    );
  if (!['required', 'skip'].includes(nativeUpgradePolicy))
    throw new Error('--native-upgrade-policy must be required or skip');
  if (!['product', 'hub-cli'].includes(artifactScope))
    throw new Error('--artifact-scope must be product or hub-cli');
  if (artifactScope === 'hub-cli' && nativeUpgradePolicy !== 'skip')
    throw new Error(
      '--artifact-scope hub-cli requires --native-upgrade-policy skip',
    );
  const evidenceFields = Object.values(sourceOnlyEvidence).filter(Boolean);
  if (evidenceFields.length !== 0 && evidenceFields.length !== 3)
    throw new Error(
      'source-only reuse requires receipt root, source tree, and policy root',
    );
  if (
    evidenceFields.length === 3 &&
    (!ROOT_PATTERN.test(sourceOnlyEvidence.receiptRoot) ||
      !TREE_PATTERN.test(sourceOnlyEvidence.sourceTree) ||
      !ROOT_PATTERN.test(sourceOnlyEvidence.policyRoot))
  )
    throw new Error('source-only evidence identity is invalid');
  return {
    executionProfile: name,
    nativeUpgradePolicy,
    artifactScope,
    sourceOnlyEvidence: evidenceFields.length === 3 ? sourceOnlyEvidence : null,
  };
}

export function releaseQualificationEnvironment(
  root = ROOT,
  inherited = process.env,
  fuzzSecondsPerTarget = 90,
) {
  const temporary = path.join(root, '.buildchain', 'tmp');
  const platformTarget = `${process.platform}-${process.arch}`;
  const platformNodePaths = [
    path.join(
      root,
      '.buildchain',
      'libnode-platform',
      platformTarget,
      'node_modules',
    ),
    path.join(
      root,
      '.buildchain',
      'rollup-platform',
      platformTarget,
      'node_modules',
    ),
    ...['sdk', 'tui', 'gui'].map((slot) =>
      path.join(
        root,
        '.buildchain',
        'esbuild-platform',
        slot,
        platformTarget,
        'node_modules',
      ),
    ),
  ];
  const hostTemporary = qualificationHostTemporary(inherited);
  fs.mkdirSync(temporary, { recursive: true });
  return lifecycleEnvironment(
    {
      ...inherited,
      TMPDIR: temporary,
      TEMP: temporary,
      TMP: temporary,
      KUNGFU_QUALIFICATION_HOST_TEMP: hostTemporary,
      KUNGFU_BUILDCHAIN_NO_OPTIONAL: '1',
      KUNGFU_BUILDCHAIN_SOURCE_BUILD: '1',
      SHIFU_NATIVE: '1',
      SHIFU_REQUIRE_MSVC: '1',
      KUNGFU_FUZZ_SECONDS: String(fuzzSecondsPerTarget),
      // Product distribution seeds exact native optional packages in these
      // repository-scoped roots. Later qualification suites are separate Node
      // processes, so carry the roots explicitly instead of assuming pnpm's
      // --no-optional install can resolve them from the workspace.
      NODE_PATH: [...platformNodePaths, inherited.NODE_PATH]
        .filter(Boolean)
        .join(path.delimiter),
    },
    'dist',
  );
}

export function qualificationHostTemporary(
  inherited = process.env,
  platform = process.platform,
) {
  if (inherited.RUNNER_TEMP) return inherited.RUNNER_TEMP;
  if (platform !== 'win32') return '/tmp';
  return inherited.TEMP || inherited.TMP || inherited.TMPDIR || os.tmpdir();
}

export function releaseQualificationStages(
  platform = process.platform,
  execution = loadExecutionProfile('full-patrol'),
  nativeUpgradePolicy = 'required',
  artifactScope = 'product',
  arch = 'x64',
) {
  if (!['required', 'skip'].includes(nativeUpgradePolicy))
    throw new Error(`unknown native upgrade policy: ${nativeUpgradePolicy}`);
  if (!['product', 'hub-cli'].includes(artifactScope))
    throw new Error(`unknown artifact scope: ${artifactScope}`);
  if (artifactScope === 'hub-cli' && nativeUpgradePolicy !== 'skip')
    throw new Error('hub-cli qualification cannot require native upgrade');
  if (platform === 'linux' && arch === 'arm64' && artifactScope === 'product')
    return [['release:qualify:core-platform']];
  const stages = [
    ['release:probe:platform'],
    ['verify', '--fuzz'],
    [
      'live-peer:qualify',
      '--',
      '--retain',
      'product/release/qualification/live-peer-continuity',
    ],
    [
      'runtime:qualify',
      '--',
      '--mode',
      'execute',
      '--with-product',
      '--retain',
      'product/release/qualification/runtime-activation',
    ],
    ['test:upgrade-qualification'],
  ];
  if (artifactScope === 'product')
    stages.push([
      'zero-burden:qualify',
      '--',
      '--retain',
      'product/release/qualification/zero-burden-desktop',
    ]);
  if (platform === 'linux') {
    stages.push([
      'episode:qualify:release',
      '--',
      '--profile',
      execution.parameters.episodeProfile,
      '--output',
      'product/release/qualification/episode-release-evidence.json',
    ]);
    stages.push([
      'adr:release:gate',
      '--',
      '--github-event',
      '--allow-non-pr',
      '--report',
      'product/release/qualification/adr-release-admissibility.json',
    ]);
  }
  const artifactLayers =
    artifactScope === 'hub-cli'
      ? ['layers.format']
      : ['layers.format', 'layers.sdk', 'layers.surfaces'];
  stages.push([
    'gate',
    'run',
    ...artifactLayers,
    '--capability',
    'node',
    '--capability',
    'native-toolchain',
    '--capability',
    'product-artifacts',
    '--capability',
    'rust',
    '--receipt',
    'product/release/qualification/layer-artifact-gate-receipt.json',
    '--overwrite',
    '--execution-context',
    JSON.stringify({
      executionProfile: execution.name,
      effectiveParameters: execution.parameters,
      policyDigest: execution.policyDigest,
      policyRef: execution.policyRef,
    }),
  ]);
  if (nativeUpgradePolicy === 'required')
    stages.push(['upgrade:qualify:native']);
  stages.push([
    'invariant:verify',
    '--',
    '--level',
    'source,native,runtime',
    '--profile',
    execution.name,
    '--evidence-dir',
    `product/release/qualification/invariants/${process.platform}-${process.arch}`,
    '--run-report',
    'product/release/qualification/invariant-run.json',
    '--json',
  ]);
  return stages;
}

export function prepareReleaseQualificationHistory(
  root = ROOT,
  platform = process.platform,
  prepare = prepareGateMeasurementHistory,
  arch = 'x64',
  artifactScope = 'product',
) {
  if (platform !== 'linux' || (arch === 'arm64' && artifactScope === 'product'))
    return 'not-required';
  return prepare(root);
}

export function prepareReleaseQualificationOutput(root = ROOT) {
  const output = path.join(root, 'product', 'release', 'qualification');
  fs.rmSync(output, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 50,
  });
  fs.mkdirSync(output, { recursive: true });
  return output;
}

function gitRevision() {
  return spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).stdout.trim();
}

function gitTreeRevision() {
  return spawnSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).stdout.trim();
}

export function verifySourceOnlyEvidence(
  evidence,
  { sourceTree = gitTreeRevision() } = {},
) {
  if (!evidence) return null;
  if (
    !ROOT_PATTERN.test(evidence.receiptRoot) ||
    !ROOT_PATTERN.test(evidence.policyRoot) ||
    !TREE_PATTERN.test(evidence.sourceTree)
  )
    throw new Error('source-only evidence identity is invalid');
  if (evidence.sourceTree !== sourceTree)
    throw new Error(
      `source-only evidence tree mismatch: expected ${sourceTree}, got ${evidence.sourceTree}`,
    );
  return structuredClone(evidence);
}

export function releaseQualificationExecutionGroups(
  stages,
  cacheActive = process.env.SHIFU_CACHE_ACTIVE === '1',
) {
  const nativeUpgradeRequired = stages.some(
    ([stage]) => stage === 'upgrade:qualify:native',
  );
  if (nativeUpgradeRequired || !cacheActive)
    return stages.map((stage) => [stage]);
  const groups = [];
  for (let index = 0; index < stages.length; index += 1) {
    if (
      stages[index][0] === 'gate' &&
      stages[index + 1]?.[0] === 'invariant:verify'
    ) {
      groups.push([stages[index], stages[index + 1]]);
      index += 1;
      continue;
    }
    groups.push([stages[index]]);
  }
  return groups;
}

function rootedTiming(row) {
  return { ...row, evidenceRoot: digest(row) };
}

async function runQualificationStage(
  args,
  {
    env,
    sourceOnlyEvidence,
    groupId,
    parallel = false,
    syncRunner = runShifuWithCache,
    asyncRunner = runShifuWithCacheAsync,
  },
) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let status = 0;
  let executionMode = 'platform-native';
  if (args[0] === 'test:upgrade-qualification' && sourceOnlyEvidence) {
    executionMode = 'exact-source-reuse';
  } else {
    try {
      status = parallel
        ? await asyncRunner(args, { env })
        : syncRunner(args, { env });
    } catch (error) {
      status = 1;
      console.error(
        `[release-qualification] ${args[0]} launch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const completedAt = new Date().toISOString();
  return rootedTiming({
    stage: args[0],
    startedAt,
    completedAt,
    durationSeconds: (Date.now() - started) / 1000,
    status,
    conclusion: status === 0 ? 'passed' : 'failed',
    executionMode,
    concurrencyGroup: groupId,
    ...(executionMode === 'exact-source-reuse'
      ? {
          sourceOnlyReceiptRoot: sourceOnlyEvidence.receiptRoot,
          sourceOnlyPolicyRoot: sourceOnlyEvidence.policyRoot,
        }
      : {}),
  });
}

export async function executeReleaseQualificationStages(stages, options = {}) {
  const timings = [];
  let finalStatus = 0;
  const groups = releaseQualificationExecutionGroups(
    stages,
    options.env?.SHIFU_CACHE_ACTIVE === '1',
  );
  for (const [groupIndex, group] of groups.entries()) {
    const groupId =
      group.length > 1
        ? `parallel-${groupIndex + 1}-${group.map(([stage]) => stage).join('+')}`
        : `serial-${groupIndex + 1}-${group[0][0]}`;
    const settled = await Promise.all(
      group.map((args) =>
        runQualificationStage(args, {
          ...options,
          groupId,
          parallel: group.length > 1,
        }),
      ),
    );
    timings.push(...settled);
    const failure = settled.find((row) => row.status !== 0);
    if (failure) {
      finalStatus = failure.status || 1;
      break;
    }
  }
  return { timings, finalStatus };
}

function artifactManifestDigest() {
  const release = path.join(ROOT, 'product', 'release');
  const rows = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path
        .relative(release, absolute)
        .split(path.sep)
        .join('/');
      if (relative === 'qualification' || relative.startsWith('qualification/'))
        continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile())
        rows.push({
          path: relative,
          bytes: fs.statSync(absolute).size,
          digest: fileDigest(absolute),
        });
    }
  };
  visit(release);
  return digest(
    rows.sort((left, right) => left.path.localeCompare(right.path)),
  );
}

export function verifyCorePlatformRelease({
  root = ROOT,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const key = `${platform}-${arch}`;
  const contract = readJson(
    path.join(root, 'framework/core/core-platform-package.contract.json'),
  );
  const descriptor = contract.platformPackages.find((item) => item.key === key);
  if (!descriptor)
    throw new Error(`Core release package does not support ${key}`);
  const version = readJson(
    path.join(root, 'framework/core/package.json'),
  ).version;
  const archiveName = `${descriptor.name
    .replace(/^@/u, '')
    .replaceAll('/', '-')}-${version}.tgz`;
  const archive = path.join(root, 'product/release/npm', archiveName);
  const receiptPath = `${archive}.receipt.json`;
  if (!fs.existsSync(archive)) throw new Error(`missing ${archiveName}`);
  if (!fs.existsSync(receiptPath))
    throw new Error(`missing ${archiveName}.receipt.json`);

  const receipt = readJson(receiptPath);
  const expected = {
    schema: 'kungfu.core-platform-package.receipt/v1',
    package: descriptor.name,
    version,
    platform: key,
    archive: archiveName,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (receipt[field] !== value)
      throw new Error(`Core release receipt ${field} mismatch`);
  }
  if (receipt.sha256 !== fileDigest(archive).slice('sha256:'.length))
    throw new Error('Core release archive sha256 mismatch');
  if (receipt.prohibitedContent?.status !== 'passing')
    throw new Error('Core release prohibited-content gate did not pass');
  if (!Array.isArray(receipt.files) || receipt.files.length === 0)
    throw new Error('Core release receipt has no files');
  for (const pattern of contract.platformPayload.requiredPathPatterns) {
    if (!receipt.files.some((file) => new RegExp(pattern, 'u').test(file)))
      throw new Error(`Core release receipt lacks required pattern ${pattern}`);
  }
  if (!receipt.executables?.some((file) => /\/kungfu(?:\.exe)?$/u.test(file)))
    throw new Error('Core release receipt lacks the Kungfu CLI');
  if (
    !receipt.nativeLibraries?.some((file) => /kungfu_node\.node$/u.test(file))
  )
    throw new Error('Core release receipt lacks the native addon');

  const report = {
    schema: 'kungfu.core-platform-release-qualification/v1',
    generatedAt: new Date().toISOString(),
    status: 'passed',
    platform: key,
    package: descriptor.name,
    version,
    archive: path.relative(root, archive).split(path.sep).join('/'),
    sha256: receipt.sha256,
    receipt: path.relative(root, receiptPath).split(path.sep).join('/'),
    fileCount: receipt.files.length,
  };
  const reportPath = path.join(
    root,
    'product/release/qualification/core-platform',
    key,
    'report.json',
  );
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function writeSummary(
  execution,
  timings,
  status,
  startedAt,
  nativeUpgradePolicy,
  artifactScope,
) {
  const receiptPath = path.join(
    ROOT,
    'product',
    'release',
    'qualification',
    'layer-artifact-gate-receipt.json',
  );
  const receipt = fs.existsSync(receiptPath)
    ? JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
    : {};
  const sourceRevision = gitRevision();
  const sourceTree = gitTreeRevision();
  const artifactDigest = artifactManifestDigest();
  const toolchain = {
    node: process.version,
    packageManager: JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ).packageManager,
    contractLock: digest(
      fs.readFileSync(path.join(ROOT, '.buildchain', 'contract-lock.json')),
    ),
  };
  const tuple = {
    sourceRevision,
    platform: process.platform,
    buildchainRuntime: {
      ref: process.env.BUILDCHAIN_RUNTIME_REF || '',
      sha: process.env.BUILDCHAIN_RUNTIME_SHA || '',
    },
    gateRegistryDigest:
      receipt.registry?.digest ||
      digest(fs.readFileSync(path.join(ROOT, 'shifu.gates.json'))),
    toolchainDigest: digest(toolchain),
    artifactManifestDigest: artifactDigest,
  };
  const generatedAt = new Date().toISOString();
  const durationSeconds = Math.max(
    0,
    (Date.parse(generatedAt) - Date.parse(startedAt)) / 1000,
  );
  const executionLimitSeconds =
    execution.parameters.budgetSeconds -
    execution.parameters.upstreamBudgetSeconds -
    execution.parameters.reserveSeconds;
  const withinLimit = status === 0 && durationSeconds <= executionLimitSeconds;
  const substageEvidenceBody = {
    schema: 'kungfu.lifecycle-substage-evidence/v1',
    lifecycleStage: 'verify',
    generatedAt,
    startedAt,
    completedAt: generatedAt,
    conclusion: withinLimit ? 'passed' : 'failed',
    ...(withinLimit
      ? {}
      : {
          failureReason: status === 0 ? 'budget-exceeded' : 'substage-failed',
        }),
    source: {
      sha: sourceRevision,
      tree: sourceTree,
    },
    platform: {
      id:
        process.env.BUILDCHAIN_PLATFORM_ID ||
        `${process.platform}-${process.arch}`,
      os: process.platform,
      arch: process.arch,
    },
    roots: {
      buildchainRuntime: process.env.BUILDCHAIN_RUNTIME_SHA || '',
      dependencyLock: process.env.BUILDCHAIN_DEPENDENCY_LOCK_ROOT || '',
      toolchain: process.env.BUILDCHAIN_TOOLCHAIN_ROOT || '',
      cachePolicy: process.env.BUILDCHAIN_CACHE_POLICY_ROOT || '',
      qualificationPolicy: execution.policyDigest,
    },
    execution: {
      policy: 'declared-order-with-bounded-independent-parallel-groups',
      maxParallelism: 2,
      groups: [...new Set(timings.map((row) => row.concurrencyGroup))],
    },
    durationSeconds,
    substages: timings,
  };
  const substageEvidence = {
    ...substageEvidenceBody,
    evidenceRoot: digest(substageEvidenceBody),
  };
  const summary = {
    schema: 'kungfu.layer-qualification-summary/v1',
    generatedAt,
    startedAt,
    status: withinLimit ? 'passed' : 'failed',
    executionProfile: execution.name,
    artifactScope,
    nativeUpgradePolicy,
    effectiveParameters: execution.parameters,
    policy: { ref: execution.policyRef, digest: execution.policyDigest },
    timings,
    substageEvidence,
    durationSeconds,
    budget: {
      totalSeconds: execution.parameters.budgetSeconds,
      upstreamSeconds: execution.parameters.upstreamBudgetSeconds,
      reserveSeconds: execution.parameters.reserveSeconds,
      executionLimitSeconds,
      withinLimit,
    },
    reuse: {
      policy: execution.reusePolicy,
      tuple,
      keyDigest: digest(tuple),
    },
  };
  fs.mkdirSync(path.dirname(SUMMARY), { recursive: true });
  fs.writeFileSync(SUMMARY, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--core-platform-only') {
    try {
      console.log(JSON.stringify(verifyCorePlatformRelease()));
      return 0;
    } catch (error) {
      console.error(`[core-platform-release] ${error.message}`);
      return 1;
    }
  }
  const options = parseReleaseQualificationOptions(argv);
  const execution = loadExecutionProfile(options.executionProfile);
  prepareReleaseQualificationOutput();
  const sourceOnlyEvidence = verifySourceOnlyEvidence(
    options.sourceOnlyEvidence,
  );
  prepareReleaseQualificationHistory(
    ROOT,
    process.platform,
    prepareGateMeasurementHistory,
    process.arch,
    options.artifactScope,
  );
  const env = releaseQualificationEnvironment(
    ROOT,
    process.env,
    execution.parameters.fuzzSecondsPerTarget,
  );
  const startedAt = new Date().toISOString();
  const stages = releaseQualificationStages(
    process.platform,
    execution,
    options.nativeUpgradePolicy,
    options.artifactScope,
    process.arch,
  );
  const { timings, finalStatus } = await executeReleaseQualificationStages(
    stages,
    { env, sourceOnlyEvidence },
  );
  const summary = writeSummary(
    execution,
    timings,
    finalStatus,
    startedAt,
    options.nativeUpgradePolicy,
    options.artifactScope,
  );
  if (finalStatus === 0 && !summary.budget.withinLimit) {
    console.error(
      `[release-qualification] execution profile ${execution.name} exceeded its ${summary.budget.executionLimitSeconds}s execution limit`,
    );
    return 1;
  }
  return finalStatus;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().then(
    (status) => process.exit(status),
    (error) => {
      console.error(error?.stack || String(error));
      process.exit(1);
    },
  );
