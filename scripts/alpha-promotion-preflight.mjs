#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = 'kungfu.alpha-promotion-preflight-receipt/v1';
const REQUIRED_PLATFORMS = [
  'linux-x64',
  'linux-arm64',
  'macos-arm64',
  'windows-x64',
];
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const ROOT_FILES = {
  workflow: [
    '.github/actions/require-alpha-preflight/action.yml',
    '.github/workflows/alpha-promotion-preflight.yml',
    '.github/workflows/build.yml',
    '.github/workflows/embedding-membrane-spike.yml',
    '.github/workflows/release-new-version.yml',
    '.github/workflows/shifu-ci.yml',
  ],
  gate: ['shifu.gates.json'],
  toolchain: [
    '.node-version',
    'package.json',
    'crates/libwasm-spike/rust-toolchain.toml',
  ],
  dependencyLock: [
    'package.json',
    'pnpm-lock.yaml',
    'crates/libwasm-spike/wasmer/Cargo.lock',
    'crates/libwasm-spike/wasmtime/Cargo.lock',
  ],
  policy: [
    '.buildchain/alpha-contract-lock.json',
    '.buildchain/contract-lock.json',
    'docs/qualification/alpha-release-latency.contract.json',
    'docs/qualification/alpha-ruleset.contract.json',
    'docs/qualification/gates/execution-profiles.json',
    'docs/release-promotion-rehearsal.contract.json',
    'scripts/alpha-promotion-preflight.mjs',
    '.github/actions/require-alpha-preflight/alpha-macos-overflow.mjs',
    'scripts/alpha-publication-tail-plan.mjs',
    'scripts/alpha-cache-evidence.mjs',
    'scripts/alpha-release-timeline.mjs',
    'scripts/alpha-release-history.mjs',
    'scripts/alpha-ruleset.mjs',
    'scripts/probe-release-platform.mjs',
    'framework/core/tests/python/test_peer_lifecycle.py',
    'framework/core/tests/python/windows_continuity_sentinel.py',
    'framework/core/tests/fixtures/peer_lifecycle_probe.py',
  ],
};
const PLATFORM_CHECKS = {
  'linux-x64': [
    'exact-source',
    'source-contracts',
    'adr-cutover-history',
    'cargo-locked-fetch',
  ],
  'linux-arm64': ['exact-source', 'cargo-locked-fetch'],
  'macos-arm64': ['exact-source', 'codesign-tool', 'cargo-locked-fetch'],
  'windows-x64': ['exact-source', 'windows-cmd-spawn', 'cargo-locked-fetch'],
};
const NON_REUSABLE_EVIDENCE = [
  'credentials',
  'notarization',
  'publication',
  'signing',
];
const EXACT_BUILDCHAIN_SHA = /^[0-9a-f]{40}$/u;
const BUILDCHAIN_V3_NATIVE_RENDITIONS = [
  {
    id: '1080p',
    role: 'primary',
    columns: 150,
    rows: 36,
    width: 1920,
    height: 1080,
  },
  {
    id: '720p',
    role: 'responsive',
    columns: 150,
    rows: 28,
    width: 1280,
    height: 720,
  },
];
const WINDOWS_CONTINUITY_FILES = [
  'framework/core/src/python/kungfu/peer_lifecycle.py',
  'framework/core/tests/python/test_peer_lifecycle.py',
  'framework/core/tests/python/windows_continuity_sentinel.py',
  'framework/core/tests/fixtures/peer_lifecycle_probe.py',
];
const WINDOWS_CONTINUITY_PHASES = [
  'initialReadiness',
  'hostCrashAdoption',
  'peerAdoption',
  'staleOwnerFencing',
  'peerRestartHealth',
  'cleanup',
];
const WINDOWS_CONTINUITY_INVALIDATION_KEYS = [
  'sourceCommit',
  'sourceTree',
  'workflowRoot',
  'toolchainRoot',
  'policyRoot',
  'continuityInputRoot',
  'nativeScenarioRoot',
  'platform.os',
  'platform.arch',
];
const WINDOWS_CONTINUITY_CLAIM_BOUNDARY =
  'Windows-native crash, adoption, restart-health, fencing, and cleanup only; does not claim full Alpha qualification';

function requirePattern(issues, source, pattern, message) {
  if (!pattern.test(source)) issues.push(message);
}

export function inspectWindowsFastSentinel({ shifuCmd, lifecycle }) {
  const issues = [];
  requirePattern(
    issues,
    shifuCmd,
    /if \/i not "%~1"=="check:source" goto native/iu,
    'shifu.cmd no longer routes check:source through the build-free source gate',
  );
  requirePattern(
    issues,
    shifuCmd,
    /source-acceptance\.mjs/iu,
    'shifu.cmd no longer invokes the source-acceptance authority',
  );
  requirePattern(
    issues,
    lifecycle,
    /export function windowsCmdArgs/iu,
    'release qualification no longer exposes the reviewed Windows command adapter',
  );
  requirePattern(
    issues,
    lifecycle,
    /windowsVerbatimArguments:\s*true/iu,
    'Windows qualification no longer preserves verbatim cmd.exe arguments',
  );
  requirePattern(
    issues,
    lifecycle,
    /\['\/d',\s*'\/s',\s*'\/c'/u,
    'Windows qualification no longer uses the bounded cmd.exe /d /s /c entry',
  );
  return issues;
}

export function inspectAuditableDemoFastSentinel({
  workflow,
  scenario,
  transportScenario,
  product,
}) {
  const issues = [];
  let scenarioValue;
  let transportScenarioValue;
  try {
    scenarioValue =
      typeof scenario === 'string' ? JSON.parse(scenario) : scenario;
  } catch {
    issues.push('auditable-demo scenario is not valid JSON');
  }
  try {
    transportScenarioValue =
      typeof transportScenario === 'string'
        ? JSON.parse(transportScenario)
        : transportScenario;
  } catch {
    issues.push('auditable-demo transport scenario is not valid JSON');
  }
  const demos = scenarioValue?.demos || [];
  const autoplay = demos.find((demo) => demo?.id === 'agent-work-lab-autoplay');
  const projectTourEpisode1 = demos.find(
    (demo) => demo?.id === 'project-tour-episode-1',
  );
  const projectTourEpisode2 = demos.find(
    (demo) => demo?.id === 'project-tour-episode-2',
  );
  if (
    scenarioValue?.schema !== 'buildchain.declarative-binary-demo/v1' ||
    scenarioValue?.execution?.durationClass !== 'long-form' ||
    scenarioValue?.execution?.totalTimeoutSeconds !== 360 ||
    scenarioValue?.authority?.grants?.length !== 0 ||
    demos.length !== 3 ||
    JSON.stringify(autoplay?.steps?.[0]?.argv) !==
      JSON.stringify(['agent-work-lab', 'autoplay']) ||
    autoplay?.steps?.[0]?.timeoutSeconds !== 90 ||
    JSON.stringify(projectTourEpisode1?.steps?.[0]?.argv) !==
      JSON.stringify([
        'agent-work-lab',
        'project-tour',
        '--episode',
        '1',
        '--speed',
        '4',
      ]) ||
    projectTourEpisode1?.steps?.[0]?.timeoutSeconds !== 360 ||
    JSON.stringify(projectTourEpisode2?.steps?.[0]?.argv) !==
      JSON.stringify([
        'agent-work-lab',
        'project-tour',
        '--episode',
        '2',
        '--speed',
        '4',
      ]) ||
    projectTourEpisode2?.steps?.[0]?.timeoutSeconds !== 360
  ) {
    issues.push(
      'auditable-demo scenario no longer declares the exact bounded three-demo cut',
    );
  }
  if (
    transportScenarioValue?.schema !==
      'buildchain.declarative-binary-demo/v1' ||
    transportScenarioValue?.execution?.totalTimeoutSeconds !== 60 ||
    JSON.stringify(transportScenarioValue?.renditions) !==
      JSON.stringify(BUILDCHAIN_V3_NATIVE_RENDITIONS) ||
    JSON.stringify(transportScenarioValue?.product) !==
      JSON.stringify(scenarioValue?.product) ||
    JSON.stringify(transportScenarioValue?.artifact) !==
      JSON.stringify(scenarioValue?.artifact) ||
    JSON.stringify(transportScenarioValue?.transportSmoke) !==
      JSON.stringify(scenarioValue?.transportSmoke) ||
    JSON.stringify(transportScenarioValue?.authority) !==
      JSON.stringify(scenarioValue?.authority)
  ) {
    issues.push(
      'auditable-demo transport scenario no longer binds the exact bounded v3-compatible artifact smoke and native rendition profiles',
    );
  }
  requirePattern(
    issues,
    product,
    /writeAuditableDemoBinaryMetadata\(stageRoot, layout\)/u,
    'Kungfu product no longer emits exact declarative demo binary metadata',
  );
  requirePattern(
    issues,
    product,
    /runInstalledEmbeddedNodeAddonSmoke\([\s\S]*runtimeEntry/u,
    'Kungfu product no longer executes the staged node-pty addon before upload',
  );
  requirePattern(
    issues,
    workflow,
    /artifact-paths:[\s\S]*product\/dist\/cli\/kungfu-cli-linux-x64/u,
    'build artifact no longer retains the exact standalone demo distribution',
  );
  requirePattern(
    issues,
    workflow,
    /pre-upload-transport-smoke-scenario-path:\s*\.buildchain\/auditable-demo-transport-smoke\.json/u,
    'build no longer uses the bounded v3-compatible pre-upload transport scenario',
  );
  const runtime = workflow.match(
    /uses:\s*kungfu-systems\/buildchain\/\.github\/workflows\/\.declarative-auditable-demo\.yml@([0-9a-f]{40})/u,
  );
  if (!runtime || !EXACT_BUILDCHAIN_SHA.test(runtime[1])) {
    issues.push(
      'declarative auditable-demo workflow is not pinned to one exact Buildchain SHA',
    );
  }
  requirePattern(
    issues,
    workflow,
    /render-failure-advisory:\s*\$\{\{ github\.event_name == 'pull_request' && startsWith\(github\.base_ref, 'alpha\/'\) \}\}[\s\S]*media-profile:\s*responsive-long-form-web-delivery-v1[\s\S]*materialize:\s*\$\{\{ github\.event_name != 'workflow_dispatch' \|\| \(inputs\.mode == 'full' && inputs\.materialize\) \}\}/u,
    'declarative auditable-demo no longer preserves a required Gate with Alpha-only advisory rendering',
  );
  return issues;
}

export function runAlphaFastSentinel(kind, root = ROOT) {
  if (kind === 'windows') {
    return inspectWindowsFastSentinel({
      shifuCmd: fs.readFileSync(path.join(root, 'shifu.cmd'), 'utf8'),
      lifecycle: fs.readFileSync(
        path.join(root, 'scripts', 'run-shifu-lifecycle.mjs'),
        'utf8',
      ),
    });
  }
  if (kind === 'auditable-demo') {
    return inspectAuditableDemoFastSentinel({
      workflow: fs.readFileSync(
        path.join(root, '.github', 'workflows', 'auditable-demo.yml'),
        'utf8',
      ),
      scenario: fs.readFileSync(
        path.join(root, '.buildchain', 'auditable-demo.json'),
        'utf8',
      ),
      transportScenario: fs.readFileSync(
        path.join(root, '.buildchain', 'auditable-demo-transport-smoke.json'),
        'utf8',
      ),
      product: fs.readFileSync(
        path.join(root, 'product', 'scripts', 'dist.mjs'),
        'utf8',
      ),
    });
  }
  throw new Error(`unknown Alpha fast sentinel: ${kind || '<empty>'}`);
}

function windowsContinuityInputRoot(root = ROOT) {
  return digest(fileRows(root, WINDOWS_CONTINUITY_FILES));
}

function validateWindowsContinuityScenario(report, expectedPlatform) {
  const issues = [];
  if (
    report?.schema !== 'kungfu.windows-continuity-fast-sentinel/v1' ||
    report?.status !== 'passed'
  )
    issues.push('Windows continuity scenario did not pass');
  if (!Number.isInteger(report?.sampleCount) || report.sampleCount < 2)
    issues.push('Windows continuity scenario requires two independent samples');
  if (
    !Array.isArray(report?.samples) ||
    report.samples.length !== report.sampleCount
  )
    issues.push('Windows continuity scenario sample set is incomplete');
  if (report?.platform?.system !== expectedPlatform)
    issues.push(
      'Windows continuity native platform does not match the receipt',
    );
  for (const [index, sample] of (report?.samples || []).entries()) {
    if (
      sample?.schema !== 'kungfu.windows-continuity-fast-sentinel/v1' ||
      sample?.sample !== index + 1
    )
      issues.push('Windows continuity sample identity is invalid');
    if (sample?.status !== 'passed') {
      issues.push(
        `Windows continuity sample ${String(sample?.sample || '<unknown>')} failed`,
      );
      continue;
    }
    for (const coverage of [
      'realHostCrash',
      'peerAdoption',
      'peerRestart',
      'restartedHealthy',
      'staleOwnerFenced',
      'cleanupComplete',
    ]) {
      if (sample?.coverage?.[coverage] !== true)
        issues.push(`Windows continuity sample omitted ${coverage}`);
    }
    for (const phase of WINDOWS_CONTINUITY_PHASES) {
      const timing = sample?.phaseTimings?.[phase];
      if (
        !Number.isInteger(timing?.durationMs) ||
        !Number.isInteger(timing?.deadlineMs) ||
        timing.durationMs < 0 ||
        timing.deadlineMs <= 0 ||
        timing.durationMs > timing.deadlineMs
      )
        issues.push(`Windows continuity phase timing is invalid: ${phase}`);
    }
  }
  if (
    report?.retryPolicy !==
    'none; repeated samples are independent qualifications'
  )
    issues.push('Windows continuity retry policy is not fail-closed');
  return issues;
}

export function buildWindowsContinuityFastReceipt({
  root = ROOT,
  sourceSha = '',
  platform = process.platform,
  architecture = process.arch,
  nativeReport,
  nativeExitCode = 0,
  durationMs = 0,
}) {
  const binding = sourceBinding(root);
  const issues = [
    ...runAlphaFastSentinel('windows', root),
    ...validateWindowsContinuityScenario(nativeReport, platform),
  ];
  if (platform !== 'win32')
    issues.push(
      `Windows continuity qualification requires win32, got ${platform}`,
    );
  if (
    !EXACT_BUILDCHAIN_SHA.test(sourceSha) ||
    sourceSha !== binding.sourceCommit
  )
    issues.push(
      'Windows continuity source SHA does not match the exact checkout',
    );
  if (nativeExitCode !== 0)
    issues.push(`Windows continuity native scenario exited ${nativeExitCode}`);
  const body = {
    schema: 'kungfu.alpha-fast-sentinel/v1',
    kind: 'windows',
    sourceSha,
    status: issues.length ? 'failed' : 'passed',
    issues: [...new Set(issues)].sort(),
    durationMs,
    binding: {
      ...binding,
      continuityInputRoot: windowsContinuityInputRoot(root),
      nativeScenarioRoot: digest(nativeReport || {}),
    },
    platform: { os: platform, arch: architecture },
    nativeScenario: nativeReport || {},
    reuse: {
      scope: 'exact-source-windows-continuity-only',
      invalidationKeys: WINDOWS_CONTINUITY_INVALIDATION_KEYS,
      downstreamVerificationRequired: true,
      crossShaReuse: false,
      partialReuse: false,
    },
    claimBoundary: WINDOWS_CONTINUITY_CLAIM_BOUNDARY,
  };
  return withReceiptRoot(body);
}

export function verifyWindowsContinuityFastReceipt({
  root = ROOT,
  receipt,
  expectedSourceCommit = '',
  expectedPlatform = 'win32',
  expectedArchitecture = '',
}) {
  verifyRoot(receipt);
  if (
    receipt.schema !== 'kungfu.alpha-fast-sentinel/v1' ||
    receipt.kind !== 'windows' ||
    receipt.status !== 'passed'
  )
    throw new Error('Windows continuity fast receipt is not qualifying');
  const binding = {
    ...sourceBinding(root),
    continuityInputRoot: windowsContinuityInputRoot(root),
    nativeScenarioRoot: digest(receipt.nativeScenario || {}),
  };
  assertBinding(receipt.binding, binding);
  if (expectedSourceCommit && receipt.sourceSha !== expectedSourceCommit)
    throw new Error(
      'Windows continuity source SHA does not match the consumer',
    );
  if (receipt.sourceSha !== binding.sourceCommit)
    throw new Error('Windows continuity source SHA is stale');
  if (receipt.platform?.os !== expectedPlatform)
    throw new Error('Windows continuity platform does not match the consumer');
  if (expectedArchitecture && receipt.platform?.arch !== expectedArchitecture)
    throw new Error(
      'Windows continuity architecture does not match the consumer',
    );
  const scenarioIssues = validateWindowsContinuityScenario(
    receipt.nativeScenario,
    expectedPlatform,
  );
  if (scenarioIssues.length)
    throw new Error(
      `Windows continuity scenario drifted: ${scenarioIssues.join('; ')}`,
    );
  if (
    receipt.reuse?.scope !== 'exact-source-windows-continuity-only' ||
    JSON.stringify(receipt.reuse?.invalidationKeys) !==
      JSON.stringify(WINDOWS_CONTINUITY_INVALIDATION_KEYS) ||
    receipt.reuse?.downstreamVerificationRequired !== true ||
    receipt.reuse?.crossShaReuse !== false ||
    receipt.reuse?.partialReuse !== false
  )
    throw new Error('Windows continuity reuse boundary drifted');
  if (receipt.claimBoundary !== WINDOWS_CONTINUITY_CLAIM_BOUNDARY)
    throw new Error('Windows continuity claim boundary drifted');
  return receipt;
}

function executeWindowsContinuityScenario(outFile, root = ROOT) {
  const scenarioFile = outFile.replace(/\.json$/u, '.scenario.json');
  const runtimeRoot = path.join(
    os.tmpdir(),
    `kungfu-windows-continuity-${Date.now()}-${process.pid}`,
  );
  const command = [
    'run',
    '--frozen',
    '--project',
    path.join(root, 'framework', 'core'),
    'python',
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'python',
      'windows_continuity_sentinel.py',
    ),
    '--out',
    scenarioFile,
    '--runtime-root',
    runtimeRoot,
    '--probe',
    path.join(
      root,
      'framework',
      'core',
      'tests',
      'fixtures',
      'peer_lifecycle_probe.py',
    ),
    '--repeat',
    '2',
  ];
  const result = childProcess.spawnSync('uv', command, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONPATH: [
        path.join(root, 'framework', 'core', 'src', 'python'),
        process.env.PYTHONPATH,
      ]
        .filter(Boolean)
        .join(path.delimiter),
    },
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  let report = {};
  try {
    report = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
  } catch (error) {
    report = {
      schema: 'kungfu.windows-continuity-fast-sentinel/v1',
      status: 'failed',
      sampleCount: 0,
      samples: [],
      retryPolicy: 'none; repeated samples are independent qualifications',
      diagnostic: String(
        result.stderr || result.stdout || result.error?.message || error,
      ).slice(-4000),
    };
  }
  return { report, exitCode: result.status ?? 1 };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function digest(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(JSON.stringify(canonical(value)));
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function git(root, args) {
  const result = childProcess.spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${String(
        result.stderr || result.stdout || result.error?.message || '',
      ).trim()}`,
    );
  }
  return String(result.stdout || '').trim();
}

function fileRows(root, files) {
  return files.map((relative) => {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) {
      throw new Error(`preflight root input is missing: ${relative}`);
    }
    return {
      path: relative,
      digest: digest(fs.readFileSync(absolute)),
    };
  });
}

export function sourceBinding(root = ROOT) {
  const roots = Object.fromEntries(
    Object.entries(ROOT_FILES).map(([name, files]) => [
      `${name}Root`,
      digest(fileRows(root, files)),
    ]),
  );
  return {
    sourceCommit: git(root, ['rev-parse', 'HEAD^{commit}']),
    sourceTree: git(root, ['rev-parse', 'HEAD^{tree}']),
    ...roots,
  };
}

function withReceiptRoot(receipt) {
  return { ...receipt, receiptRoot: digest(receipt) };
}

export function buildPlatformReceipt({
  root = ROOT,
  platform,
  generatedAt = new Date().toISOString(),
  runtime = {},
}) {
  const checks = PLATFORM_CHECKS[platform];
  if (!checks) throw new Error(`unsupported preflight platform: ${platform}`);
  return withReceiptRoot({
    schema: SCHEMA,
    kind: 'platform',
    status: 'passed',
    generatedAt,
    platform,
    binding: sourceBinding(root),
    checks: Object.fromEntries(checks.map((check) => [check, 'passed'])),
    runtime,
    reuse: {
      scope: 'source-and-platform-probes-only',
      maxAgeSeconds: MAX_AGE_SECONDS,
      excludedEvidence: NON_REUSABLE_EVIDENCE,
    },
  });
}

function verifyRoot(receipt) {
  const { receiptRoot, ...body } = receipt;
  if (receiptRoot !== digest(body)) throw new Error('receipt root mismatch');
}

function assertBinding(actual, expected) {
  for (const [field, value] of Object.entries(expected)) {
    if (actual?.[field] !== value) {
      throw new Error(
        `${field} mismatch: expected ${value}, got ${String(actual?.[field])}`,
      );
    }
  }
}

export function aggregatePlatformReceipts({
  root = ROOT,
  receipts,
  generatedAt = new Date().toISOString(),
}) {
  if (!Array.isArray(receipts) || receipts.length !== REQUIRED_PLATFORMS.length)
    throw new Error('aggregate requires exactly four platform receipts');
  const byPlatform = new Map();
  const binding = sourceBinding(root);
  for (const receipt of receipts) {
    verifyRoot(receipt);
    if (
      receipt.schema !== SCHEMA ||
      receipt.kind !== 'platform' ||
      receipt.status !== 'passed'
    )
      throw new Error('platform receipt is not qualifying');
    if (byPlatform.has(receipt.platform))
      throw new Error(`duplicate platform receipt: ${receipt.platform}`);
    assertBinding(receipt.binding, binding);
    for (const check of PLATFORM_CHECKS[receipt.platform] || []) {
      if (receipt.checks?.[check] !== 'passed')
        throw new Error(`${receipt.platform} omitted required check ${check}`);
    }
    byPlatform.set(receipt.platform, receipt);
  }
  for (const platform of REQUIRED_PLATFORMS) {
    if (!byPlatform.has(platform))
      throw new Error(`missing platform receipt: ${platform}`);
  }
  return withReceiptRoot({
    schema: SCHEMA,
    kind: 'aggregate',
    status: 'passed',
    generatedAt,
    binding,
    platforms: REQUIRED_PLATFORMS.map((platform) => byPlatform.get(platform)),
    reuse: {
      scope: 'source-and-platform-probes-only',
      maxAgeSeconds: MAX_AGE_SECONDS,
      excludedEvidence: NON_REUSABLE_EVIDENCE,
    },
  });
}

export function verifyAggregateReceipt({
  root = ROOT,
  receipt,
  expectedSourceCommit = '',
  now = Date.now(),
}) {
  verifyRoot(receipt);
  if (
    receipt.schema !== SCHEMA ||
    receipt.kind !== 'aggregate' ||
    receipt.status !== 'passed'
  )
    throw new Error('aggregate receipt is not qualifying');
  const binding = sourceBinding(root);
  assertBinding(receipt.binding, binding);
  if (
    expectedSourceCommit &&
    receipt.binding.sourceCommit !== expectedSourceCommit
  )
    throw new Error(
      `sourceCommit mismatch: expected ${expectedSourceCommit}, got ${receipt.binding.sourceCommit}`,
    );
  const ageSeconds =
    (now - Date.parse(String(receipt.generatedAt || 'invalid'))) / 1000;
  if (
    !Number.isFinite(ageSeconds) ||
    ageSeconds < 0 ||
    ageSeconds > MAX_AGE_SECONDS
  )
    throw new Error(`preflight receipt age is outside ${MAX_AGE_SECONDS}s`);
  if (
    JSON.stringify(receipt.reuse?.excludedEvidence) !==
    JSON.stringify(NON_REUSABLE_EVIDENCE)
  )
    throw new Error('preflight receipt reuse exclusions drifted');
  const platforms = receipt.platforms?.map((entry) => entry.platform) || [];
  if (JSON.stringify(platforms) !== JSON.stringify(REQUIRED_PLATFORMS))
    throw new Error('aggregate platform coverage drifted');
  for (const platformReceipt of receipt.platforms) {
    verifyRoot(platformReceipt);
    if (
      platformReceipt.schema !== SCHEMA ||
      platformReceipt.kind !== 'platform' ||
      platformReceipt.status !== 'passed'
    )
      throw new Error(`${platformReceipt.platform} receipt is not qualifying`);
    assertBinding(platformReceipt.binding, binding);
    for (const check of PLATFORM_CHECKS[platformReceipt.platform] || []) {
      if (platformReceipt.checks?.[check] !== 'passed')
        throw new Error(
          `${platformReceipt.platform} omitted required check ${check}`,
        );
    }
  }
  return receipt;
}

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!flag?.startsWith('--') || index + 1 >= rest.length)
      throw new Error(`invalid preflight option: ${flag || '<missing>'}`);
    options[flag.slice(2)] = rest[index + 1];
  }
  return { command, options };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function main(argv = process.argv.slice(2)) {
  const { command, options } = parse(argv);
  if (command === 'write-platform') {
    if (!options.platform || !options.out)
      throw new Error('write-platform requires --platform and --out');
    writeJson(
      path.resolve(options.out),
      buildPlatformReceipt({
        platform: options.platform,
        runtime: {
          node: process.version,
          rustc: options.rustc || '',
          cargo: options.cargo || '',
        },
      }),
    );
    return;
  }
  if (command === 'aggregate') {
    if (!options.inputs || !options.out)
      throw new Error('aggregate requires --inputs and --out');
    const receipts = fs
      .readdirSync(path.resolve(options.inputs))
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) =>
        JSON.parse(
          fs.readFileSync(
            path.join(path.resolve(options.inputs), file),
            'utf8',
          ),
        ),
      );
    writeJson(
      path.resolve(options.out),
      aggregatePlatformReceipts({ receipts }),
    );
    return;
  }
  if (command === 'verify') {
    if (!options.receipt || !options['source-commit'])
      throw new Error('verify requires --receipt and --source-commit');
    const receipt = JSON.parse(
      fs.readFileSync(path.resolve(options.receipt), 'utf8'),
    );
    verifyAggregateReceipt({
      receipt,
      expectedSourceCommit: options['source-commit'],
    });
    process.stdout.write(
      `[alpha-preflight] verified ${receipt.receiptRoot} for ${receipt.binding.sourceCommit} tree ${receipt.binding.sourceTree}\n`,
    );
    return;
  }
  if (command === 'verify-fast-sentinel') {
    if (!options.receipt || !options['source-commit'])
      throw new Error(
        'verify-fast-sentinel requires --receipt and --source-commit',
      );
    const receipt = JSON.parse(
      fs.readFileSync(path.resolve(options.receipt), 'utf8'),
    );
    verifyWindowsContinuityFastReceipt({
      receipt,
      expectedSourceCommit: options['source-commit'],
      expectedPlatform: options.platform || 'win32',
      expectedArchitecture: options.architecture || '',
    });
    process.stdout.write(
      `[alpha-fast-sentinel] verified ${receipt.receiptRoot} for ${receipt.sourceSha} ${receipt.platform.os}/${receipt.platform.arch}\n`,
    );
    return;
  }
  if (command === 'fast-sentinel') {
    if (!options.kind || !options.out)
      throw new Error('fast-sentinel requires --kind and --out');
    const startedAt = Date.now();
    const output = path.resolve(options.out);
    let result;
    if (options.kind === 'windows') {
      if (!options['source-commit'])
        throw new Error('Windows fast-sentinel requires --source-commit');
      const native = executeWindowsContinuityScenario(output);
      result = buildWindowsContinuityFastReceipt({
        sourceSha: options['source-commit'],
        nativeReport: native.report,
        nativeExitCode: native.exitCode,
        durationMs: Date.now() - startedAt,
      });
    } else {
      const issues = runAlphaFastSentinel(options.kind);
      result = {
        schema: 'kungfu.alpha-fast-sentinel/v1',
        kind: options.kind,
        sourceSha: process.env.GITHUB_SHA || '',
        status: issues.length ? 'failed' : 'passed',
        issues,
        durationMs: Date.now() - startedAt,
        claimBoundary:
          'source-contract-only; does not claim platform or full Alpha qualification',
      };
    }
    writeJson(output, result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== 'passed') process.exitCode = 1;
    return;
  }
  throw new Error(`unknown alpha preflight command: ${command || '<missing>'}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
