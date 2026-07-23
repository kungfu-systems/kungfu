#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { prepareGateMeasurementHistory } from './prepare-gate-measurement-history.mjs';
import {
  lifecycleEnvironment,
  runShifuWithCache,
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
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!['--execution-profile', '--native-upgrade-policy'].includes(arg))
      throw new Error(`unknown release qualification option: ${arg}`);
    index += 1;
    if (index >= argv.length) throw new Error(`${arg} requires a value`);
    if (arg === '--execution-profile') {
      if (name) throw new Error('--execution-profile may be specified once');
      name = argv[index];
      continue;
    }
    if (nativeUpgradePolicySeen)
      throw new Error('--native-upgrade-policy may be specified once');
    nativeUpgradePolicySeen = true;
    nativeUpgradePolicy = argv[index];
  }
  if (!name)
    throw new Error(
      '--execution-profile is required (alpha, release-candidate, or full-patrol)',
    );
  if (!['required', 'skip'].includes(nativeUpgradePolicy))
    throw new Error('--native-upgrade-policy must be required or skip');
  return { executionProfile: name, nativeUpgradePolicy };
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
  const hostTemporary =
    inherited.RUNNER_TEMP ||
    inherited.TEMP ||
    inherited.TMP ||
    inherited.TMPDIR ||
    temporary;
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

export function releaseQualificationStages(
  platform = process.platform,
  execution = loadExecutionProfile('full-patrol'),
  nativeUpgradePolicy = 'required',
) {
  if (!['required', 'skip'].includes(nativeUpgradePolicy))
    throw new Error(`unknown native upgrade policy: ${nativeUpgradePolicy}`);
  const stages = [
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
    [
      'zero-burden:qualify',
      '--',
      '--retain',
      'product/release/qualification/zero-burden-desktop',
    ],
  ];
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
  stages.push([
    'gate',
    'run',
    'layers.format',
    'layers.sdk',
    'layers.surfaces',
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
) {
  if (platform !== 'linux') return 'not-required';
  return prepare(root);
}

function gitRevision() {
  return spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).stdout.trim();
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

function writeSummary(
  execution,
  timings,
  status,
  startedAt,
  nativeUpgradePolicy,
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
  const durationSeconds = timings.reduce(
    (total, row) => total + row.durationSeconds,
    0,
  );
  const executionLimitSeconds =
    execution.parameters.budgetSeconds -
    execution.parameters.upstreamBudgetSeconds -
    execution.parameters.reserveSeconds;
  const withinLimit = status === 0 && durationSeconds <= executionLimitSeconds;
  const summary = {
    schema: 'kungfu.layer-qualification-summary/v1',
    generatedAt: new Date().toISOString(),
    startedAt,
    status: withinLimit ? 'passed' : 'failed',
    executionProfile: execution.name,
    nativeUpgradePolicy,
    effectiveParameters: execution.parameters,
    policy: { ref: execution.policyRef, digest: execution.policyDigest },
    timings,
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

export function main(argv = process.argv.slice(2)) {
  const options = parseReleaseQualificationOptions(argv);
  const execution = loadExecutionProfile(options.executionProfile);
  prepareReleaseQualificationHistory();
  const env = releaseQualificationEnvironment(
    ROOT,
    process.env,
    execution.parameters.fuzzSecondsPerTarget,
  );
  const timings = [];
  const startedAt = new Date().toISOString();
  let finalStatus = 0;
  for (const args of releaseQualificationStages(
    process.platform,
    execution,
    options.nativeUpgradePolicy,
  )) {
    const started = Date.now();
    const status = runShifuWithCache(args, { env });
    timings.push({
      stage: args[0],
      durationSeconds: (Date.now() - started) / 1000,
      status,
    });
    if (status !== 0) {
      finalStatus = status;
      break;
    }
  }
  const summary = writeSummary(
    execution,
    timings,
    finalStatus,
    startedAt,
    options.nativeUpgradePolicy,
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
  process.exit(main());
