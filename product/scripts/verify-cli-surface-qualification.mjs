// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractTarGz } from './archive.mjs';
import {
  cliQualificationNonClaims,
  cliQualificationRoot,
} from './cli-surface-qualification.mjs';

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SOURCE_PATTERN = /^[0-9a-f]{40}$/u;
const MACOS_CLI_JIT_EXECUTABLES = [
  'kungfu-episodes-cli-darwin-arm64/runtime/kungfu',
  'kungfu-episodes-cli-darwin-arm64/runtime/python/bin/python3',
  'kungfu-episodes-cli-darwin-arm64/runtime/python/bin/python3.13',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function verifyCliSurfaceQualification({
  report,
  expectedPlatform,
  archiveName,
  archiveSha256,
}) {
  assert(
    report?.schema === 'kungfu.cli-installed-product-qualification/v1',
    `unexpected qualification schema: ${report?.schema}`,
  );
  assert(report.qualified === true, 'CLI qualification is not qualified');
  assert(report.label === 'cli-archive', `unexpected label: ${report.label}`);
  assert(
    report.platform === expectedPlatform,
    `platform mismatch: expected ${expectedPlatform}, got ${report.platform}`,
  );
  const expectedArchitecture = expectedPlatform.split('-').at(-1);
  assert(
    report.architecture === expectedArchitecture,
    `architecture mismatch: expected ${expectedArchitecture}, got ${report.architecture}`,
  );
  assert(
    typeof report.version === 'string' && report.version.length > 0,
    'qualification omitted the installed version',
  );
  assert(
    SOURCE_PATTERN.test(report.identity?.sourceCommit || ''),
    'qualification omitted an exact source commit',
  );
  assert(
    report.identity?.archive === archiveName,
    `archive name mismatch: expected ${archiveName}, got ${report.identity?.archive}`,
  );
  assert(
    ROOT_PATTERN.test(report.identity?.archiveSha256 || ''),
    'qualification omitted a valid archive SHA256',
  );
  assert(
    report.identity.archiveSha256 === archiveSha256,
    `archive SHA256 mismatch: expected ${archiveSha256}, got ${report.identity.archiveSha256}`,
  );
  assert(
    report.productIdentity?.verifiedFromInstalledCommand === true,
    'product identity was not verified from the installed command',
  );
  assert(
    report.claims?.installedProduct === true &&
      report.claims?.qualifiedPlatform === expectedPlatform,
    'qualification claims do not bind the qualified platform',
  );
  assert(
    JSON.stringify(report.nonClaims) ===
      JSON.stringify(cliQualificationNonClaims(expectedPlatform)),
    'qualification non-claims contradict the qualified platform',
  );
  assert(
    report.checks?.kfd3?.linkedApiCount > 0,
    'installed CLI qualification omitted KFD-3 linkage',
  );
  assert(
    report.checks?.mutationPlanReceipt?.planReplayStable === true &&
      report.checks?.mutationPlanReceipt?.receiptVerified === true,
    'installed CLI qualification omitted a verified mutation receipt',
  );
  assert(
    report.isolation?.sourceCheckoutRequired === false &&
      report.isolation?.guiPrivateStateRequired === false,
    'qualification depends on source checkout or GUI-private state',
  );
  assert(
    ROOT_PATTERN.test(report.qualificationRoot || ''),
    'qualification omitted a valid semantic root',
  );
  const { qualificationRoot, ...subject } = report;
  assert(
    qualificationRoot === cliQualificationRoot(subject),
    'qualification semantic root mismatch',
  );
  return {
    schema: 'kungfu.cli-installed-product-qualification-verification/v1',
    verified: true,
    platform: report.platform,
    architecture: report.architecture,
    version: report.version,
    sourceCommit: report.identity.sourceCommit,
    archive: report.identity.archive,
    archiveSha256: report.identity.archiveSha256,
    qualificationRoot,
  };
}

export function finalizeSignedCliQualification({
  report,
  expectedPlatform,
  archiveName,
  archiveSha256,
  signingResult,
  signingReceipt,
  signingProviderEvidence,
  signingProviderEvidenceDigest,
  expectedSourceCommit,
}) {
  assert(
    SOURCE_PATTERN.test(expectedSourceCommit || ''),
    'finalization omitted an exact expected source commit',
  );
  assert(
    report.identity?.sourceCommit === expectedSourceCommit,
    `qualification source mismatch: expected ${expectedSourceCommit}, got ${report.identity?.sourceCommit}`,
  );
  assert(
    ROOT_PATTERN.test(report.identity?.archiveSha256 || ''),
    'qualification omitted its pre-signing archive SHA256',
  );
  const { qualificationRoot, ...originalSubject } = report;
  assert(
    qualificationRoot === cliQualificationRoot(originalSubject),
    'pre-signing qualification semantic root mismatch',
  );
  assert(
    signingResult?.contract ===
      'kungfu-buildchain-artifact-signing-result/v1' &&
      signingResult.verification?.status === 'passed',
    'Buildchain signing result did not pass',
  );
  assert(
    signingReceipt?.contract ===
      'kungfu-buildchain-artifact-signing-receipt/v1' &&
      signingReceipt.status === 'passed',
    'Buildchain signing receipt did not pass',
  );
  assert(
    signingProviderEvidence?.contract ===
      'kungfu-buildchain-apple-developer-id-evidence/v1' &&
      signingProviderEvidence.status === 'passed',
    'Buildchain Apple Developer ID provider evidence did not pass',
  );
  assert(
    ROOT_PATTERN.test(signingProviderEvidenceDigest || ''),
    'Buildchain signing provider evidence omitted its file SHA256',
  );
  const providerEvidenceEntries = (signingResult.evidence || []).filter(
    (entry) => entry?.path === 'provider-evidence.json',
  );
  assert(
    providerEvidenceEntries.length === 1 &&
      providerEvidenceEntries[0].digest === signingProviderEvidenceDigest,
    'Buildchain signing result does not bind the exact provider evidence file',
  );
  assert(
    ROOT_PATTERN.test(signingResult.evidenceDigest || '') &&
      signingResult.evidenceDigest === signingReceipt.result?.evidenceDigest,
    'Buildchain signing result and receipt evidence digests differ',
  );
  assert(
    signingProviderEvidence.compound?.entitlementsProfile ===
      'jit-executable-v1',
    'signed CLI provider evidence omitted the jit-executable-v1 entitlement profile',
  );
  const entitledPaths = signingProviderEvidence.compound?.entitledPaths;
  assert(
    Array.isArray(entitledPaths) &&
      signingProviderEvidence.compound?.entitledExecutableCount ===
        MACOS_CLI_JIT_EXECUTABLES.length &&
      JSON.stringify([...entitledPaths].sort()) ===
        JSON.stringify([...MACOS_CLI_JIT_EXECUTABLES].sort()),
    `signed CLI provider evidence must bind the JIT executables: ${MACOS_CLI_JIT_EXECUTABLES.join(', ')}`,
  );
  assert(
    signingResult.requestDigest === signingReceipt.requestDigest,
    'Buildchain signing result and receipt request digests differ',
  );
  assert(
    signingResult.source?.sha === expectedSourceCommit,
    `Buildchain signing result source mismatch: expected ${expectedSourceCommit}, got ${signingResult.source?.sha}`,
  );
  assert(
    signingResult.artifact?.digest === archiveSha256 &&
      signingReceipt.result?.artifactDigest === archiveSha256,
    'final archive SHA256 does not match the Buildchain signing result and receipt',
  );

  const rebound = structuredClone(report);
  rebound.identity.archiveSha256 = archiveSha256;
  Reflect.deleteProperty(rebound, 'qualificationRoot');
  rebound.qualificationRoot = cliQualificationRoot(rebound);
  verifyCliSurfaceQualification({
    report: rebound,
    expectedPlatform,
    archiveName,
    archiveSha256,
  });
  return rebound;
}

const ARCHIVE_BASE = 'kungfu-episodes-cli-darwin-arm64';
const JIT_EXECUTABLES = [
  'runtime/kungfu',
  'runtime/python/bin/python3',
  'runtime/python/bin/python3.13',
];
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function digestBytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function signedMacosRuntimeReceiptRoot(receipt) {
  const { receiptRoot: _receiptRoot, ...subject } = receipt;
  return digestBytes(JSON.stringify(stable(subject)));
}

function sha256InstalledArchive(file) {
  return digestBytes(fs.readFileSync(file));
}

function assertFile(file, label) {
  assert(
    fs.existsSync(file) && fs.statSync(file).isFile(),
    `${label} not found: ${file}`,
  );
}

function commandFailure(label, result) {
  return [
    `${label} failed (exit ${result.status ?? `signal ${result.signal}`})`,
    result.error?.message ? `error: ${result.error.message}` : '',
    result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : '',
    result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function run(command, args, options = {}, spawn = spawnSync) {
  const result = spawn(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(commandFailure(`${command} ${args.join(' ')}`, result));
  }
  return result;
}

function parseJsonOutput(output, label) {
  const text = String(output || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error(`${label} did not produce JSON output`);
  }
}

function plistXml(output, executable) {
  const text = String(output || '');
  const start = Math.max(text.indexOf('<?xml'), text.indexOf('<plist'));
  const end = text.lastIndexOf('</plist>');
  assert(
    start >= 0 && end >= start,
    `codesign entitlement readback omitted a plist: ${executable}`,
  );
  return text.slice(start, end + '</plist>'.length);
}

export function verifyCodesignEntitlements(
  { installRoot },
  { spawn = spawnSync } = {},
) {
  return JIT_EXECUTABLES.map((relativePath) => {
    const executable = path.join(installRoot, ...relativePath.split('/'));
    assertFile(executable, 'signed JIT executable');
    run('codesign', ['--verify', '--strict', executable], {}, spawn);
    const detail = run(
      'codesign',
      ['--display', '--entitlements', ':-', executable],
      {},
      spawn,
    );
    const converted = run(
      'plutil',
      ['-convert', 'json', '-o', '-', '--', '-'],
      {
        input: plistXml(
          `${detail.stdout || ''}\n${detail.stderr || ''}`,
          executable,
        ),
      },
      spawn,
    );
    const entitlements = parseJsonOutput(
      converted.stdout,
      `codesign entitlements for ${relativePath}`,
    );
    assert(
      entitlements['com.apple.security.cs.allow-jit'] === true,
      `signed executable omitted com.apple.security.cs.allow-jit: ${relativePath}`,
    );
    return {
      path: `${ARCHIVE_BASE}/${relativePath}`,
      allowJit: true,
    };
  });
}

function installedEnvironment({ installRoot, temporaryRoot }) {
  const home = path.join(temporaryRoot, 'home');
  const runtimeHome = path.join(temporaryRoot, 'kungfu-home');
  const configHome = path.join(temporaryRoot, 'kungfu-config');
  const cacheHome = path.join(temporaryRoot, 'kungfu-cache');
  for (const directory of [home, runtimeHome, configHome, cacheHome]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const runtimeEntry = path.join(installRoot, 'runtime', 'kungfu');
  const processEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !['CODEX_HOME', 'OPENAI_API_KEY'].includes(key),
    ),
  );
  const environment = {
    ...processEnvironment,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    KF_HOME: runtimeHome,
    KF_CONFIG_HOME: configHome,
    KF_CACHE_HOME: cacheHome,
    KUNGFU_CONTROLLER_ENTRYPOINT: runtimeEntry,
    KUNGFU_AGENT_SESSION_EXECUTABLE: runtimeEntry,
    PATH: '/usr/bin:/bin',
    TERM: 'xterm-256color',
  };
  return environment;
}

function runKungfu(kungfu, args, { cwd, env, timeout = 60000 } = {}) {
  return run(kungfu, args, { cwd, env, timeout });
}

function verifyEmbeddedWorkProfile({ installRoot, kungfu, env }) {
  const profile = path.join(installRoot, 'extensions', 'work-control');
  const result = runKungfu(kungfu, ['profile', 'validate', profile, '--json'], {
    cwd: installRoot,
    env,
  });
  const report = parseJsonOutput(
    result.stdout,
    'embedded Work Profile checker',
  );
  assert(
    report.schema === 'kungfu.profile-validation/v1' &&
      report.workConformance?.schema ===
        'kungfu.work-profile-conformance-result/v1' &&
      report.workConformance.verdict === 'compatible',
    'embedded Work Profile checker did not return a compatible verdict',
  );
  return {
    schema: report.workConformance.schema,
    verdict: report.workConformance.verdict,
    declarationRoot: report.workConformance.declarationRoot,
  };
}

function writeFixtureCodex({ temporaryRoot }) {
  const executable = path.join(temporaryRoot, 'codex-fixture');
  fs.writeFileSync(
    executable,
    '#!/bin/sh\nif [ "${1:-}" = "--version" ]; then\n  printf "codex-fixture 0.0.0\\n"\n  exit 0\nfi\nexit 97\n',
    { mode: 0o755 },
  );
  return executable;
}

function verifyCodexPlanWithoutCodex({
  installRoot,
  kungfu,
  env,
  temporaryRoot,
}) {
  const fixture = writeFixtureCodex({ temporaryRoot });
  const profile = {
    schema: 'kungfu.agent-runtime-profile/v1',
    id: 'codex.post-sign-fixture',
    label: 'Codex post-sign fixture',
    provider: 'codex',
    launch: {
      executable: fixture,
      argv: [],
      interactiveArgv: [],
      versionArgv: ['--version'],
      shellMode: false,
    },
    cwdPolicy: 'workspace-root',
    backendDefault: 'direct',
    bootstrap: { adapter: 'codex', envelope: 'required' },
    source: 'user',
  };
  runKungfu(
    kungfu,
    [
      'config',
      'set',
      'agent.runtimeProfiles',
      JSON.stringify([profile]),
      '--json',
    ],
    { cwd: installRoot, env },
  );
  runKungfu(
    kungfu,
    [
      'config',
      'set',
      'agent.defaultRuntimeProfile',
      JSON.stringify(profile.id),
      '--json',
    ],
    { cwd: installRoot, env },
  );
  const project = path.join(temporaryRoot, 'project');
  const projectPlan = parseJsonOutput(
    runKungfu(
      kungfu,
      ['agent-work-lab', 'starter-plan', '--destination', project, '--json'],
      { cwd: temporaryRoot, env },
    ).stdout,
    'Agent Work Starter plan',
  );
  assert(projectPlan.planRoot, 'Agent Work Starter plan omitted planRoot');
  assert(
    projectPlan.initialWork?.title,
    'Agent Work Starter plan omitted initial Work title',
  );
  runKungfu(
    kungfu,
    [
      'agent-work-lab',
      'starter-create',
      '--destination',
      project,
      '--expected-plan-root',
      projectPlan.planRoot,
      '--actor',
      'post-sign-smoke',
      '--execute',
      '--json',
    ],
    { cwd: temporaryRoot, env },
  );
  const plan = parseJsonOutput(
    runKungfu(
      kungfu,
      [
        'run',
        'codex',
        projectPlan.initialWork.title,
        '--workspace',
        project,
        '--plan',
        '--json',
      ],
      { cwd: temporaryRoot, env },
    ).stdout,
    'kungfu run codex <task> --plan',
  );
  assert(
    /^sha256:[0-9a-f]{64}$/u.test(plan.planRoot || '') &&
      plan.agent?.provider === 'codex',
    'kungfu run codex <task> --plan did not bind the fixture provider and exact plan',
  );
  return {
    fixtureOnly: true,
    provider: plan.agent.provider,
    planRoot: plan.planRoot,
    realProviderInstalled: false,
    credentialsRead: false,
  };
}

export function ptyDriverSource() {
  return [
    'const nodePty = require(process.argv[1]);',
    'const command = process.argv[2];',
    'const args = JSON.parse(process.argv[3]);',
    'const expected = process.argv[4];',
    'const timeoutMs = Number(process.argv[5]);',
    "let output = '';",
    'const childEnv = {...process.env};',
    'delete childEnv.KUNGFU_AS_VARIANT;',
    "const child = nodePty.spawn(command, args, {name: 'xterm-256color', cols: 120, rows: 40, cwd: process.cwd(), env: childEnv});",
    'child.onData((data) => { output += data; if (output.length > 64 * 1024 * 1024) { child.kill(); process.exit(93); } });',
    'const timeout = setTimeout(() => { child.kill(); process.exit(94); }, timeoutMs);',
    'child.onExit(({exitCode}) => { clearTimeout(timeout); if (exitCode !== 0) { process.stderr.write(output); process.exit(95); } if (!output.includes(expected)) { process.stderr.write(output); process.exit(96); } process.stdout.write(output); process.exit(0); });',
  ].join('');
}

function verifyTuiAutoplayPty({ installRoot, kungfu, env, temporaryRoot }) {
  const runtime = path.join(installRoot, 'runtime', 'kungfu');
  const nodePty = path.join(
    installRoot,
    'tui',
    'node_modules',
    'node-pty',
    'lib',
    'index.js',
  );
  assertFile(nodePty, 'installed node-pty entry');
  const result = run(
    runtime,
    [
      '-e',
      ptyDriverSource(),
      nodePty,
      kungfu,
      JSON.stringify(['agent-work-lab', 'autoplay']),
      'KUNGFU_TUI_DEMO_COMPLETE',
      '180000',
    ],
    {
      cwd: installRoot,
      env: { ...env, KUNGFU_AS_VARIANT: 'node' },
      timeout: 200000,
    },
  );
  return {
    pty: 'node-pty',
    exitCode: 0,
    completion: 'KUNGFU_TUI_DEMO_COMPLETE',
    outputDigest: digestBytes(result.stdout || ''),
    isolatedHome: path.relative(temporaryRoot, env.KF_HOME),
  };
}

export async function verifySignedMacosCliRuntime({
  archive,
  expectedSourceCommit = process.env.BUILDCHAIN_SOURCE_SHA || '',
} = {}) {
  assert(
    process.platform === 'darwin',
    'signed macOS CLI runtime verification requires macOS',
  );
  assert(
    process.arch === 'arm64',
    'signed macOS CLI runtime verification requires arm64',
  );
  assertFile(archive, 'signed macOS CLI archive');
  assert(
    SOURCE_PATTERN.test(expectedSourceCommit),
    'signed macOS CLI runtime verification requires an exact source commit',
  );
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-signed-macos-cli-runtime-'),
  );
  try {
    const extracted = path.join(temporaryRoot, 'extracted');
    fs.mkdirSync(extracted, { recursive: true });
    extractTarGz({ archiveFile: archive, targetDir: extracted });
    const installRoot = path.join(extracted, ARCHIVE_BASE);
    const product = JSON.parse(
      fs.readFileSync(path.join(installRoot, 'product.json'), 'utf8'),
    );
    const upgrade = JSON.parse(
      fs.readFileSync(
        path.join(installRoot, 'upgrade', 'kungfu-release-manifest.json'),
        'utf8',
      ),
    );
    assert(
      product.schema === 'kungfu.product.cli/v1' &&
        product.platform === 'darwin-arm64',
      'signed archive is not the standalone macOS arm64 CLI product',
    );
    assert(
      upgrade.sourceCommit === expectedSourceCommit,
      `signed archive source mismatch: expected ${expectedSourceCommit}, got ${upgrade.sourceCommit}`,
    );
    const kungfu = path.join(installRoot, product.entries.kungfu);
    const env = installedEnvironment({ installRoot, temporaryRoot });
    const receipt = {
      schema: 'kungfu.signed-macos-cli-runtime-verification/v1',
      verified: true,
      platform: 'darwin-arm64',
      architecture: 'arm64',
      sourceCommit: expectedSourceCommit,
      archive: {
        name: path.basename(archive),
        sha256: sha256InstalledArchive(archive),
      },
      checks: {
        entitlements: verifyCodesignEntitlements({ installRoot }),
        workProfile: verifyEmbeddedWorkProfile({ installRoot, kungfu, env }),
        tuiAutoplay: verifyTuiAutoplayPty({
          installRoot,
          kungfu,
          env,
          temporaryRoot,
        }),
        codexPlan: verifyCodexPlanWithoutCodex({
          installRoot,
          kungfu,
          env,
          temporaryRoot,
        }),
      },
      isolation: {
        temporaryHome: true,
        realCodexRequired: false,
        providerCredentialsRead: false,
      },
      nonClaims: [
        'The fixture Codex plan is not a real provider launch or authentication test.',
        'Real Codex trust and model smoke remain clean-machine acceptance evidence.',
      ],
    };
    receipt.receiptRoot = signedMacosRuntimeReceiptRoot(receipt);
    return receipt;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function bindSignedMacosRuntimeQualification({
  report,
  signedRuntimeReceipt,
  expectedPlatform,
  archiveName,
  archiveSha256,
  expectedSourceCommit,
}) {
  assert(
    signedRuntimeReceipt?.schema ===
      'kungfu.signed-macos-cli-runtime-verification/v1' &&
      signedRuntimeReceipt.verified === true,
    'signed macOS CLI runtime verification did not pass',
  );
  assert(
    signedRuntimeReceipt.receiptRoot ===
      signedMacosRuntimeReceiptRoot(signedRuntimeReceipt),
    'signed macOS CLI runtime receipt root mismatch',
  );
  assert(
    signedRuntimeReceipt.platform === expectedPlatform &&
      signedRuntimeReceipt.sourceCommit === expectedSourceCommit &&
      signedRuntimeReceipt.archive?.name === archiveName &&
      signedRuntimeReceipt.archive?.sha256 === archiveSha256,
    'signed macOS CLI runtime receipt does not bind the qualified artifact',
  );
  const rebound = structuredClone(report);
  rebound.checks.signedMacosRuntime = signedRuntimeReceipt;
  Reflect.deleteProperty(rebound, 'qualificationRoot');
  rebound.qualificationRoot = cliQualificationRoot(rebound);
  verifyCliSurfaceQualification({
    report: rebound,
    expectedPlatform,
    archiveName,
    archiveSha256,
  });
  return rebound;
}

function parseArgs(argv) {
  const options = {};
  const known = new Set([
    '--qualification',
    '--archive',
    '--platform',
    '--signing-result',
    '--signing-receipt',
    '--signing-provider-evidence',
    '--source-commit',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (!known.has(arg)) throw new Error(`unknown option: ${arg}`);
    index += 1;
    if (index >= argv.length) throw new Error(`${arg} requires a value`);
    options[arg.slice(2)] = argv[index];
  }
  return options;
}

function readJson(file, label = 'qualification') {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label} ${file}: ${error.message}`);
  }
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o644,
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  for (const required of ['qualification', 'archive', 'platform']) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  const qualification = path.resolve(options.qualification);
  const archive = path.resolve(options.archive);
  const archiveSha256 = await sha256File(archive);
  if (
    options['signing-result'] ||
    options['signing-receipt'] ||
    options['signing-provider-evidence']
  ) {
    for (const required of [
      'signing-result',
      'signing-receipt',
      'signing-provider-evidence',
    ]) {
      if (!options[required]) throw new Error(`--${required} is required`);
    }
    const sourceCommit =
      options['source-commit'] || process.env.BUILDCHAIN_SOURCE_SHA || '';
    const providerEvidencePath = path.resolve(
      options['signing-provider-evidence'],
    );
    let report = finalizeSignedCliQualification({
      report: readJson(qualification),
      expectedPlatform: options.platform,
      archiveName: path.basename(archive),
      archiveSha256,
      signingResult: readJson(
        path.resolve(options['signing-result']),
        'signing result',
      ),
      signingReceipt: readJson(
        path.resolve(options['signing-receipt']),
        'signing receipt',
      ),
      signingProviderEvidence: readJson(
        providerEvidencePath,
        'signing provider evidence',
      ),
      signingProviderEvidenceDigest: await sha256File(providerEvidencePath),
      expectedSourceCommit: sourceCommit,
    });
    if (options.platform === 'darwin-arm64') {
      const signedRuntimeReceipt = await verifySignedMacosCliRuntime({
        archive,
        expectedSourceCommit: sourceCommit,
      });
      report = bindSignedMacosRuntimeQualification({
        report,
        signedRuntimeReceipt,
        expectedPlatform: options.platform,
        archiveName: path.basename(archive),
        archiveSha256,
        expectedSourceCommit: sourceCommit,
      });
    }
    writeJsonAtomic(qualification, report);
    process.stdout.write(
      `${JSON.stringify({
        schema: 'kungfu.signed-cli-qualification-finalization/v1',
        finalized: true,
        platform: report.platform,
        sourceCommit: report.identity.sourceCommit,
        archive: report.identity.archive,
        archiveSha256: report.identity.archiveSha256,
        qualificationRoot: report.qualificationRoot,
      })}\n`,
    );
    return;
  }
  const verification = verifyCliSurfaceQualification({
    report: readJson(qualification),
    expectedPlatform: options.platform,
    archiveName: path.basename(archive),
    archiveSha256,
  });
  process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `[verify-cli-surface-qualification] ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
