// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function exitLabel(status, signal) {
  return status == null ? `signal ${signal}` : String(status);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..', '..', '..');
const isWin = process.platform === 'win32';

function parseJsonOutput(output, label) {
  const text = output.trim();
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

function assertFile(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`${label} not found: ${file}`);
  }
}

function contentRoot(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function installedKungfuInvocation(
  kungfuBin,
  args,
  { platform = process.platform, comspec = process.env.ComSpec } = {},
) {
  if (platform !== 'win32') return { command: kungfuBin, args };
  return {
    command: comspec || 'cmd.exe',
    args: ['/d', '/s', '/c', 'call', kungfuBin, ...args],
  };
}

export function runInstalledKungfuCommand(
  { cli, args, env, cwd },
  {
    platform = process.platform,
    comspec = process.env.ComSpec,
    spawn = spawnSync,
  } = {},
) {
  const invocation = installedKungfuInvocation(cli, args, {
    platform,
    comspec,
  });
  const result = spawn(invocation.command, invocation.args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
  if (result.error) throw result.error;
  return result;
}

export function spawnInstalledKungfu(kungfuBin, args, options) {
  const invocation = installedKungfuInvocation(kungfuBin, args);
  return spawnSync(invocation.command, invocation.args, {
    ...options,
    shell: false,
  });
}

export function runInstalledTuiBootstrapSmoke(
  {
    installRoot,
    kungfuBin,
    runtimeEntry,
    tuiEntry,
    env,
    home = path.join(installRoot, '.tui-qualification-home'),
  },
  { spawn = spawnInstalledKungfu } = {},
) {
  const result = spawn(kungfuBin, [tuiEntry, '--agent-work-lab-demo'], {
    cwd: installRoot,
    env: {
      ...env,
      KUNGFU_AS_VARIANT: 'node',
      KUNGFU_DIR: path.dirname(runtimeEntry),
      KUNGFU_TUI_ENTRY: tuiEntry,
      KF_HOME: home,
      KF_RUNTIME_DIR: path.join(home, 'runtime'),
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `installed TUI bootstrap failed (exit ${exitLabel(result.status, result.signal)})`,
        result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : '',
        result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  if (
    !(result.stdout || '').includes(
      '"schema":"kungfu.agent-work-lab.report/v1"',
    )
  ) {
    throw new Error(
      'installed TUI bootstrap did not return the Agent Work Lab report',
    );
  }
}

export function runInstalledEmbeddedNodeAddonSmoke(
  { installRoot, runtimeEntry, env },
  { spawn = spawnSync } = {},
) {
  const nodePtyEntry = path.join(
    installRoot,
    'tui',
    'node_modules',
    'node-pty',
    'lib',
    'index.js',
  );
  assertFile(nodePtyEntry, 'installed node-pty entry');
  const result = spawn(
    runtimeEntry,
    [
      '-e',
      [
        'const nodePty = require(process.env.KUNGFU_NODE_PTY_ENTRY);',
        "if (typeof nodePty.spawn !== 'function') process.exit(42);",
        "const token = 'KUNGFU_NODE_PTY_CHILD_READY';",
        "const child = nodePty.spawn(process.execPath, ['-e', `process.stdout.write('${token}\\\\n')`], {name: 'xterm-color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env});",
        "let output = '';",
        'child.onData((data) => { output += data; });',
        'const timeout = setTimeout(() => { child.kill(); process.exit(43); }, 10000);',
        "child.onExit(({exitCode}) => { clearTimeout(timeout); if (exitCode !== 0 || !output.includes(token)) process.exit(44); require('node:fs').writeSync(1, 'KUNGFU_NODE_PTY_READY\\n'); process.exit(0); });",
      ].join(''),
    ],
    {
      cwd: installRoot,
      env: {
        ...env,
        KUNGFU_AS_VARIANT: 'node',
        KUNGFU_NODE_PTY_ENTRY: nodePtyEntry,
      },
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  if (
    result.status !== 0 ||
    !(result.stdout || '').includes('KUNGFU_NODE_PTY_READY')
  ) {
    throw new Error(
      [
        `installed embedded Node could not spawn through node-pty (exit ${exitLabel(result.status, result.signal)})`,
        result.error?.message ? `error: ${result.error.message}` : '',
        result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : '',
        result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
}

export function runInstalledKungfu({
  kungfuBin,
  installRoot,
  home,
  args,
  env,
}) {
  const result = spawnInstalledKungfu(kungfuBin, ['-H', home, ...args], {
    cwd: installRoot,
    env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `installed kungfu ${args.join(' ')} failed (exit ${exitLabel(result.status, result.signal)})`,
        result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : '',
        result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  return result.stdout || '';
}

export function runInstalledCliSemanticSmoke({
  installRoot,
  kungfuBin,
  env,
  home = path.join(installRoot, '.qualification-home'),
}) {
  const episodeId = 49003;
  const exportPath = path.join(installRoot, 'episode-export.json');
  runInstalledKungfu({
    kungfuBin,
    installRoot,
    home,
    args: ['storage', 'layout', '--json'],
    env,
  });
  runInstalledKungfu({
    kungfuBin,
    installRoot,
    home,
    args: [
      'storage',
      'episode',
      'begin',
      '--episode-id',
      String(episodeId),
      '--source',
      'adr0049-cli',
      '--json',
    ],
    env,
  });
  runInstalledKungfu({
    kungfuBin,
    installRoot,
    home,
    args: [
      'storage',
      'episode',
      'heartbeat',
      '--episode-id',
      String(episodeId),
      '--note',
      'qualification',
      '--json',
    ],
    env,
  });
  runInstalledKungfu({
    kungfuBin,
    installRoot,
    home,
    args: [
      'storage',
      'episode',
      'end',
      '--episode-id',
      String(episodeId),
      '--reason',
      'qualified',
      '--json',
    ],
    env,
  });
  const query = parseJsonOutput(
    runInstalledKungfu({
      kungfuBin,
      installRoot,
      home,
      args: [
        'storage',
        'query',
        '--table',
        'episodes',
        '--scope',
        'all',
        '--json',
      ],
      env,
    }),
    'storage query',
  );
  if (!query.ok || query.row_count < 1)
    throw new Error('installed CLI query did not return the recorded Episode');
  const fsck = parseJsonOutput(
    runInstalledKungfu({
      kungfuBin,
      installRoot,
      home,
      args: [
        'storage',
        'fsck',
        '--scope',
        'episode',
        '--episode-id',
        String(episodeId),
        '--json',
      ],
      env,
    }),
    'storage fsck',
  );
  if (!fsck.ok)
    throw new Error('installed CLI fsck rejected the recorded Episode');
  runInstalledKungfu({
    kungfuBin,
    installRoot,
    home,
    args: [
      'storage',
      'export',
      '--scope',
      'episode',
      '--episode-id',
      String(episodeId),
      '--format',
      'bundle-json',
      '--out',
      exportPath,
      '--json',
    ],
    env,
  });
  assertFile(exportPath, 'installed CLI Episode export');
  const brief = runInstalledKungfu({
    kungfuBin,
    installRoot,
    home,
    args: ['agent', 'brief'],
    env,
  });
  if (!brief.trim()) throw new Error('installed CLI agent brief was empty');
  const firstValue = parseJsonOutput(
    runInstalledKungfu({
      kungfuBin,
      installRoot,
      home,
      args: ['agent', 'first-value', 'contract', '--json'],
      env,
    }),
    'agent first-value contract',
  );
  if (
    firstValue.schema !== 'kungfu.agent-first-value-contract-view/v1' ||
    firstValue.contract?.result?.maximumQuestionCount !== 1
  )
    throw new Error('installed CLI agent first-value contract was incomplete');
  const mode = parseJsonOutput(
    runInstalledKungfu({
      kungfuBin,
      installRoot,
      home,
      args: ['agent', 'choose-mode', '--json'],
      env,
    }),
    'agent choose-mode',
  );
  if (!mode.mode)
    throw new Error('installed CLI agent discovery did not choose a mode');
  return { home, exportPath, episodeId };
}

export function isShippedKfdSupport(standard) {
  if (standard?.status === 'supported') return true;
  return (
    standard?.status === 'source-supported' &&
    standard?.verification?.status === 'passed' &&
    standard?.buildchain?.gateStatus === 'passed' &&
    standard?.claimClass === 'release-qualified-support' &&
    standard?.releaseQualification?.status === 'alpha-release-passport' &&
    standard?.releaseQualification?.shippedSupport === true
  );
}

export function runInstalledKungfuKfdSmoke({
  installRoot,
  kungfuBin,
  sdkEntry,
  kfd3Registry,
  kfdUpstreamAggregate,
  extensionsRoot,
  env,
}) {
  const result = spawnInstalledKungfu(kungfuBin, ['kfd', 'status', '--json'], {
    cwd: installRoot,
    env: {
      ...env,
      KUNGFU_SDK_ENTRY: sdkEntry,
      KUNGFU_KFD3_REGISTRY: kfd3Registry,
      KUNGFU_KFD_UPSTREAM_AGGREGATE: kfdUpstreamAggregate,
      KF_BUNDLED_EXTENSION_ROOT: extensionsRoot,
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `installed kungfu kfd smoke failed (exit ${exitLabel(result.status, result.signal)})`,
        result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : '',
        result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  const data = parseJsonOutput(result.stdout || '', 'kungfu kfd status');
  if (data.contract !== 'kungfu-sdk-kfd-standards-status') {
    throw new Error(`unexpected kfd status contract: ${data.contract}`);
  }
  if (!isShippedKfdSupport(data.standards?.['kfd-3'])) {
    throw new Error(
      'installed kungfu kfd status did not report release-qualified KFD-3 support',
    );
  }
  if (
    data.agentRuntime?.status !== 'available' ||
    data.agentRuntime?.profile?.id !== 'kfd-agent-runtime'
  ) {
    throw new Error(
      'installed kungfu kfd status did not discover the KFD Agent Runtime adapter',
    );
  }
}

export function runInstalledKungfuAgentHubSmoke({
  installRoot,
  kungfuBin,
  env,
  run = runInstalledKungfu,
}) {
  const userHome = path.join(installRoot, '.agent-hub-user-home');
  const smokeEnv = {
    ...env,
    HOME: userHome,
    USERPROFILE: userHome,
    KF_CACHE_HOME: path.join(installRoot, '.agent-hub-cache-home'),
  };
  const qualification = parseJsonOutput(
    run({
      kungfuBin,
      installRoot,
      home: path.join(installRoot, '.agent-hub-runtime-home'),
      args: [
        'agent',
        'hub',
        'qualify',
        '--output-dir',
        path.join(installRoot, 'agent-hub-qualification'),
        '--json',
      ],
      env: smokeEnv,
    }),
    'kungfu agent hub qualify',
  );
  if (
    qualification.valid !== true ||
    qualification.coverage?.passed !== 20 ||
    qualification.coverage?.total !== 20 ||
    qualification.isolation?.realHomeUnchanged !== true ||
    typeof qualification.meaning !== 'string' ||
    !qualification.meaning ||
    !qualification.nonClaims?.includes('KFD certification') ||
    !qualification.next?.verify?.includes('kungfu agent hub verify') ||
    !/^sha256:[0-9a-f]{64}$/.test(qualification.evidence?.reportDigest || '')
  ) {
    throw new Error(
      'installed kungfu Agent Hub qualification returned an incomplete verdict',
    );
  }
  const verification = parseJsonOutput(
    run({
      kungfuBin,
      installRoot,
      home: path.join(installRoot, '.agent-hub-runtime-home'),
      args: [
        'agent',
        'hub',
        'verify',
        '--qualification-dir',
        path.join(installRoot, 'agent-hub-qualification'),
        '--json',
      ],
      env: smokeEnv,
    }),
    'kungfu agent hub verify',
  );
  if (
    verification.valid !== true ||
    verification.coverage?.passed !== 20 ||
    verification.coverage?.total !== 20 ||
    verification.meaning !== qualification.meaning ||
    JSON.stringify(verification.nonClaims) !==
      JSON.stringify(qualification.nonClaims) ||
    verification.checks?.some((check) => check.passed !== true)
  ) {
    throw new Error(
      'installed kungfu Agent Hub verification did not preserve the qualification verdict',
    );
  }
  if (fs.existsSync(userHome)) {
    throw new Error('Agent Hub smoke modified isolated HOME');
  }
}

export function runInstalledKungfuActionSmoke({
  installRoot,
  kungfuBin,
  actionEntry,
  env,
}) {
  const poisonDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-action-node-poison-'),
  );
  const marker = path.join(poisonDir, 'system-node-used');
  const fakeNode = path.join(poisonDir, isWin ? 'node.cmd' : 'node');
  try {
    fs.writeFileSync(
      fakeNode,
      isWin
        ? `@echo off\r\n>"%KUNGFU_NODE_FALLBACK_MARKER%" echo fallback\r\nexit /b 99\r\n`
        : '#!/bin/sh\nprintf fallback > "$KUNGFU_NODE_FALLBACK_MARKER"\nexit 99\n',
      'utf8',
    );
    if (!isWin) fs.chmodSync(fakeNode, 0o755);
    const result = spawnInstalledKungfu(
      kungfuBin,
      ['action', 'contract', '--json'],
      {
        cwd: installRoot,
        env: {
          ...env,
          KUNGFU_ACTION_ENTRY: actionEntry,
          KUNGFU_NODE_FALLBACK_MARKER: marker,
          PATH: [poisonDir, process.env.PATH || '']
            .filter(Boolean)
            .join(path.delimiter),
        },
        encoding: 'utf8',
      },
    );
    if (result.status !== 0) {
      throw new Error(
        [
          `installed kungfu action smoke failed (exit ${exitLabel(result.status, result.signal)})`,
          result.stdout?.trim() ? `stdout:\n${result.stdout.trim()}` : '',
          result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
    if (fs.existsSync(marker)) {
      throw new Error('installed kungfu action used PATH node fallback');
    }
    if (!(result.stdout || '').trim()) {
      throw new Error(
        [
          'installed kungfu action produced no stdout',
          result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
    const data = parseJsonOutput(result.stdout || '', 'kungfu action contract');
    if (
      data.schema !== 'kungfu.action.response/v1' ||
      data.host?.runtime !== 'embedded-libnode' ||
      data.host?.layout !== 'installed' ||
      !/^sha256:[0-9a-f]{64}$/.test(data.semanticRoot || '')
    ) {
      throw new Error(
        'installed kungfu action returned an invalid host contract',
      );
    }
  } finally {
    fs.rmSync(poisonDir, { recursive: true, force: true });
  }
}

export function runInstalledKungfuXinfaSmoke({ installRoot, kungfuBin, env }) {
  const fixtureRoot = path.join(
    ROOT,
    'crates',
    'xinfa',
    'fixtures',
    'repository-small',
  );
  const project = path.join(fixtureRoot, 'project.json');
  const atlasOutput = path.join(installRoot, 'xinfa-smoke-atlas');
  const installed = spawnInstalledKungfu(
    kungfuBin,
    [
      'xinfa',
      'compile',
      '--project',
      project,
      '--root',
      fixtureRoot,
      '--output',
      atlasOutput,
      '--visibility',
      'public',
      '--json',
    ],
    {
      cwd: installRoot,
      env,
      encoding: 'utf8',
    },
  );
  if (installed.status !== 0) {
    throw new Error(
      `linked kungfu xinfa compile failed (exit ${exitLabel(installed.status, installed.signal)}): ${installed.stderr || ''}`,
    );
  }
  const verification = parseJsonOutput(
    runInstalledKungfu({
      kungfuBin,
      installRoot,
      home: path.join(installRoot, '.xinfa-smoke-home'),
      args: ['xinfa', 'verify', '--atlas', atlasOutput, '--json'],
      env,
    }),
    'kungfu xinfa verify',
  );
  if (verification.valid !== true || !verification.atlas_root) {
    throw new Error('installed kungfu xinfa did not verify its compiled Atlas');
  }

  const defaultWorkspace = path.join(installRoot, 'xinfa-default-workspace');
  fs.cpSync(fixtureRoot, defaultWorkspace, { recursive: true });
  fs.mkdirSync(path.join(defaultWorkspace, '.xinfa'), { recursive: true });
  fs.renameSync(
    path.join(defaultWorkspace, 'project.json'),
    path.join(defaultWorkspace, '.xinfa', 'project.json'),
  );
  const defaultCompile = parseJsonOutput(
    runInstalledKungfu({
      kungfuBin,
      installRoot,
      home: path.join(installRoot, '.xinfa-default-home'),
      args: ['xinfa', 'compile', '--workspace', defaultWorkspace],
      env,
    }),
    'bare kungfu xinfa compile',
  );
  if (
    !defaultCompile.atlas_root ||
    !fs.existsSync(path.join(defaultWorkspace, '.xinfa', 'atlas'))
  ) {
    throw new Error(
      'bare kungfu xinfa compile did not create the default Atlas',
    );
  }
}

export function runInstalledActionPrimitiveDiscovery({
  installRoot,
  kungfuBin,
  env,
}) {
  const briefHome = path.join(installRoot, '.brief-home-must-not-exist');
  const brief = runInstalledKungfu({
    kungfuBin,
    installRoot,
    home: briefHome,
    args: ['agent', 'brief'],
    env,
  });
  if (!brief.includes('kungfu xinfa compile')) {
    throw new Error(
      'installed Agent brief omitted the single-entry CLI topology',
    );
  }
  if (fs.existsSync(briefHome)) {
    throw new Error('kungfu agent brief initialized runtime state');
  }

  const roleHome = path.join(installRoot, '.role-discovery-home');
  for (const role of ['atlas', 'pursuit', 'warrant', 'episode']) {
    const capabilities = parseJsonOutput(
      runInstalledKungfu({
        kungfuBin,
        installRoot,
        home: roleHome,
        args: [role, 'capabilities', '--json'],
        env,
      }),
      `kungfu ${role} capabilities`,
    );
    if (
      capabilities.schema !== 'kungfu.action-primitive-role-capabilities/v1' ||
      capabilities.role !== role ||
      !capabilities.transitions?.length
    ) {
      throw new Error(`installed kungfu ${role} discovery is invalid`);
    }
  }
}

export function runInstalledKfxWebhookAuthoringQualification({
  installRoot,
  kungfuBin,
  env,
  authorityFactory,
  removalAuthorityFactory,
  reportPath,
  artifactIdentity,
}) {
  if (
    typeof authorityFactory !== 'function' ||
    typeof removalAuthorityFactory !== 'function'
  ) {
    throw new TypeError(
      'installed KFX qualification requires explicit policy and recovery authority factories',
    );
  }
  const packageKey = 'agent-webhook-terminal';
  const task =
    'Create a local signed webhook KFX, prove invalid and replayed deliveries fail closed, retain evidence, then remove it.';
  const qualificationRoot = path.join(
    installRoot,
    '.kfx-webhook-agent-qualification',
  );
  const originalRoot = path.join(qualificationRoot, 'original');
  const source = path.join(originalRoot, packageKey);
  const build = path.join(qualificationRoot, 'build', packageKey);
  const packagePath = path.join(qualificationRoot, `${packageKey}-0.1.0.tgz`);
  const replacementRoot = path.join(qualificationRoot, 'replacement');
  const replacementSource = path.join(replacementRoot, packageKey);
  const replacementBuild = path.join(
    qualificationRoot,
    'build-replacement',
    packageKey,
  );
  const replacementPackagePath = path.join(
    qualificationRoot,
    `${packageKey}-0.2.0.tgz`,
  );
  const home = path.join(qualificationRoot, 'home');
  const candidateHome = path.join(qualificationRoot, 'candidate-home');
  const commandTrace = [];
  const runAtHome = (args, label, selectedHome) => {
    commandTrace.push(args.join(' '));
    return runInstalledKungfu({
      kungfuBin,
      installRoot,
      home: selectedHome,
      args,
      env,
    });
  };
  const run = (args, label) => runAtHome(args, label, home);
  const runJson = (args, label) => parseJsonOutput(run(args, label), label);
  const runJsonAtHome = (args, label, selectedHome) =>
    parseJsonOutput(runAtHome(args, label, selectedHome), label);
  const writeAuthority = (name, value) => {
    const target = path.join(qualificationRoot, `${name}.json`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return target;
  };
  const replacePackageVersion = (root, version) => {
    for (const name of ['package.json', 'kungfu.kfx.json']) {
      const target = path.join(root, name);
      const value = JSON.parse(fs.readFileSync(target, 'utf8'));
      value.version = version;
      fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    }
  };
  const assessMutationAuthority = ({
    packageRoot,
    rootArgument,
    operation,
    cutRoot,
    authority,
    prefix,
  }) => {
    const files = Object.fromEntries(
      ['policy', 'attestation', 'trustInputs', 'kfdAssessment'].map((field) => [
        field,
        writeAuthority(`${prefix}-${field}`, authority[field]),
      ]),
    );
    const args = [
      'kfx',
      'native',
      'assess',
      packageKey,
      '--root',
      rootArgument,
      '--operation',
      operation,
      '--purpose',
      authority.purpose,
      '--cut',
      cutRoot,
      '--assessment-time',
      String(authority.assessmentTime),
      '--attestation',
      files.attestation,
      '--trust-inputs',
      files.trustInputs,
      '--kfd-assessment',
      files.kfdAssessment,
      '--policy',
      files.policy,
    ];
    for (const capability of authority.requestedCapabilities) {
      args.push('--requested-capability', capability);
    }
    const assessment = runJsonAtHome(
      args,
      `KFX ${operation} authority assessment`,
      candidateHome,
    );
    if (
      assessment.admissionPlan?.packageRoot !== packageRoot ||
      assessment.admissionPlan?.allowed !== true ||
      assessment.trustReport?.fresh !== true
    ) {
      throw new Error(
        `installed KFX ${operation} authority was not fresh and allowed: ${JSON.stringify(
          assessment.trustReport?.reasons ?? [],
        )}`,
      );
    }
    return assessment;
  };
  const expectDiagnosis = (args, expectedCode) => {
    commandTrace.push(args.join(' '));
    const result = spawnInstalledKungfu(kungfuBin, ['-H', home, ...args], {
      cwd: installRoot,
      env,
      encoding: 'utf8',
    });
    if (result.status === 0) {
      throw new Error(
        `installed KFX command unexpectedly passed: ${args.join(' ')}`,
      );
    }
    const diagnosis = parseJsonOutput(
      `${result.stderr || ''}\n${result.stdout || ''}`,
      `expected ${expectedCode} diagnosis`,
    );
    if (diagnosis.code !== expectedCode) {
      throw new Error(
        `installed KFX diagnosis drifted: expected ${expectedCode}, got ${diagnosis.code}`,
      );
    }
    return diagnosis;
  };

  if (fs.existsSync(qualificationRoot)) {
    throw new Error(
      `installed KFX qualification root must start absent: ${qualificationRoot}`,
    );
  }
  const brief = run(['kfx', 'author', 'brief'], 'KFX authoring brief');
  if (!brief.includes('Installed KFX Authoring Brief')) {
    throw new Error('installed KFX authoring brief is incomplete');
  }
  const capabilities = runJson(
    ['kfx', 'author', 'capabilities', '--json'],
    'KFX authoring capabilities',
  );
  if (
    capabilities.status !== 'available' ||
    capabilities.nonClaims?.includes(
      'authoring-does-not-grant-capabilities',
    ) !== true
  ) {
    throw new Error('installed KFX authoring capabilities are incomplete');
  }
  const scaffoldPlan = runJson(
    ['kfx', 'author', 'scaffold', packageKey, '--out', source, '--json'],
    'KFX scaffold plan',
  );
  if (scaffoldPlan.willWrite !== false || fs.existsSync(source)) {
    throw new Error('installed KFX scaffold plan mutated the destination');
  }
  const scaffold = runJson(
    [
      'kfx',
      'author',
      'scaffold',
      packageKey,
      '--out',
      source,
      '--execute',
      '--json',
    ],
    'KFX scaffold apply',
  );
  if (scaffold.verified !== true) {
    throw new Error('installed KFX scaffold receipt was not verified');
  }
  fs.appendFileSync(
    path.join(source, 'README.md'),
    `\n## Qualification Agent goal\n\n${task}\n`,
    'utf8',
  );
  const inspection = runJson(
    ['kfx', 'author', 'inspect', source, '--json'],
    'KFX source inspection',
  );
  const validation = runJson(
    ['kfx', 'author', 'validate', source, '--json'],
    'KFX source validation',
  );
  if (
    !inspection.valid ||
    inspection.sourceRoot !== validation.sourceRoot ||
    inspection.sourceFallback !== false
  ) {
    throw new Error('installed KFX source inspection is not exact-rooted');
  }
  const tampered = path.join(qualificationRoot, 'tampered', packageKey);
  fs.cpSync(source, tampered, { recursive: true });
  fs.appendFileSync(
    path.join(tampered, 'sdk', 'service-webhook-host.mjs'),
    '\n// qualification drift\n',
    'utf8',
  );
  const drift = expectDiagnosis(
    ['kfx', 'author', 'validate', tampered, '--json'],
    'sdk-root-mismatch',
  );
  const buildPlan = runJson(
    ['kfx', 'author', 'build', source, '--out', build, '--json'],
    'KFX build plan',
  );
  if (buildPlan.willWrite !== false || fs.existsSync(build)) {
    throw new Error('installed KFX build plan mutated the destination');
  }
  const built = runJson(
    ['kfx', 'author', 'build', source, '--out', build, '--execute', '--json'],
    'KFX build apply',
  );
  const qualification = runJson(
    ['kfx', 'author', 'qualify', build, '--json'],
    'KFX offline qualification',
  );
  const requiredLifecycle = [
    'start',
    'ready',
    'restart',
    'upgrade',
    'rollback',
    'deactivate',
    'uninstall',
  ];
  const lifecycleOperations = new Set(
    qualification.lifecycle?.map((row) => row.operation),
  );
  if (
    qualification.status !== 'passed' ||
    qualification.installedOnly !== true ||
    qualification.sourceFallback !== false ||
    requiredLifecycle.some((operation) => !lifecycleOperations.has(operation))
  ) {
    throw new Error('installed KFX lifecycle qualification is incomplete');
  }
  const packagePlan = runJson(
    ['kfx', 'author', 'package', build, '--out', packagePath, '--json'],
    'KFX package plan',
  );
  if (packagePlan.willWrite !== false || fs.existsSync(packagePath)) {
    throw new Error('installed KFX package plan mutated the destination');
  }
  const packaged = runJson(
    [
      'kfx',
      'author',
      'package',
      build,
      '--out',
      packagePath,
      '--execute',
      '--json',
    ],
    'KFX package apply',
  );
  const transport = runJson(
    ['kfx', 'inspect', packagePath, '--json'],
    'KFX package inspection',
  );
  if (transport.package?.key !== packageKey) {
    throw new Error('installed KFX package transport identity drifted');
  }

  const nativeInspection = runJson(
    [
      'kfx',
      'native',
      'inspect',
      packageKey,
      '--root',
      `workspace=${path.dirname(build)}`,
    ],
    'KFX native package inspection',
  );
  const authorityFile = writeAuthority(
    'install-authority',
    authorityFactory(
      nativeInspection.package.packageRoot,
      nativeInspection.package.declaredCapabilities,
    ),
  );
  run(
    ['kfx', 'install', packagePath, '--authority-file', authorityFile],
    'KFX install and activation',
  );
  const installed = runJson(['kfx', 'list', '--json'], 'KFX installed state');
  const installedPackage = installed.find((row) => row.key === packageKey);
  if (
    !installedPackage ||
    installedPackage.grantedCapabilities?.includes('credential.verify') !==
      true ||
    installedPackage.grantedCapabilities?.includes('network.listen') !== true
  ) {
    throw new Error('installed KFX did not retain its exact capability grant');
  }

  const installedRoot = path.join(home, 'extensions');
  const userRoot = `user=${installedRoot}`;
  const installedInspection = runJson(
    ['kfx', 'native', 'inspect', packageKey, '--root', userRoot],
    'installed KFX native inspection',
  );
  const installedGrantRoot =
    installedInspection.package.authority?.capabilityGrantRoot;
  if (!/^sha256:[0-9a-f]{64}$/.test(installedGrantRoot ?? '')) {
    throw new Error('installed KFX capability grant is not exact-rooted');
  }

  fs.cpSync(source, replacementSource, { recursive: true });
  replacePackageVersion(replacementSource, '0.2.0');
  fs.appendFileSync(
    path.join(replacementSource, 'README.md'),
    '\n## Replacement qualification\n\nThis is the bounded 0.2.0 replacement.\n',
    'utf8',
  );
  const replacementValidation = runJson(
    ['kfx', 'author', 'validate', replacementSource, '--json'],
    'KFX replacement validation',
  );
  const replacementBuilt = runJson(
    [
      'kfx',
      'author',
      'build',
      replacementSource,
      '--out',
      replacementBuild,
      '--execute',
      '--json',
    ],
    'KFX replacement build',
  );
  runJson(
    [
      'kfx',
      'author',
      'package',
      replacementBuild,
      '--out',
      replacementPackagePath,
      '--execute',
      '--json',
    ],
    'KFX replacement package',
  );
  const replacementNativeInspection = runJsonAtHome(
    [
      'kfx',
      'native',
      'inspect',
      packageKey,
      '--root',
      `workspace=${path.dirname(replacementBuild)}`,
    ],
    'KFX replacement native inspection',
    candidateHome,
  );
  const replacementAuthority = authorityFactory(
    replacementNativeInspection.package.packageRoot,
    replacementNativeInspection.package.declaredCapabilities,
  );
  const replacementStatus = runJson(
    ['kfx', 'native', 'status', '--root', userRoot],
    'pre-replacement KFX native status',
  );
  assessMutationAuthority({
    packageRoot: replacementNativeInspection.package.packageRoot,
    rootArgument: `workspace=${path.dirname(replacementBuild)}`,
    operation: 'update',
    cutRoot: replacementStatus.cutRoot,
    authority: replacementAuthority,
    prefix: 'replacement-assessment',
  });
  const replacementAuthorityFile = writeAuthority(
    'replacement-authority',
    replacementAuthority,
  );
  run(
    [
      'kfx',
      'install',
      replacementPackagePath,
      '--force',
      '--authority-file',
      replacementAuthorityFile,
    ],
    'KFX compatible replacement',
  );
  const replaced = runJson(
    ['kfx', 'native', 'inspect', packageKey, '--root', userRoot],
    'replaced KFX native inspection',
  );
  if (
    replaced.package.version !== '0.2.0' ||
    replaced.package.packageRoot !==
      replacementNativeInspection.package.packageRoot
  ) {
    throw new Error('installed KFX replacement did not bind the exact root');
  }

  const rollbackAuthority = authorityFactory(
    nativeInspection.package.packageRoot,
    nativeInspection.package.declaredCapabilities,
  );
  const rollbackStatus = runJson(
    ['kfx', 'native', 'status', '--root', userRoot],
    'pre-rollback KFX native status',
  );
  assessMutationAuthority({
    packageRoot: nativeInspection.package.packageRoot,
    rootArgument: `workspace=${path.dirname(build)}`,
    operation: 'update',
    cutRoot: rollbackStatus.cutRoot,
    authority: rollbackAuthority,
    prefix: 'rollback-assessment',
  });
  const rollbackAuthorityFile = writeAuthority(
    'rollback-authority',
    rollbackAuthority,
  );
  run(
    [
      'kfx',
      'install',
      packagePath,
      '--force',
      '--authority-file',
      rollbackAuthorityFile,
    ],
    'KFX exact-root rollback',
  );
  const rolledBack = runJson(
    ['kfx', 'native', 'inspect', packageKey, '--root', userRoot],
    'rolled-back KFX native inspection',
  );
  if (
    rolledBack.package.version !== '0.1.0' ||
    rolledBack.package.packageRoot !== nativeInspection.package.packageRoot
  ) {
    throw new Error('installed KFX rollback did not restore the exact root');
  }

  const nativeStatus = runJson(
    ['kfx', 'native', 'status', '--root', userRoot],
    'installed KFX native status',
  );
  const removalFile = writeAuthority(
    'removal-authority',
    removalAuthorityFactory(
      installedInspection.package.packageRoot,
      nativeStatus,
      `${packageKey}-terminal-removal`,
    ),
  );
  run(
    ['kfx', 'remove', packageKey, '--authority-file', removalFile],
    'KFX deactivate and uninstall',
  );
  const removed = runJson(['kfx', 'list', '--json'], 'KFX removed state');
  const removedPackage = removed.find((row) => row.key === packageKey);
  if (
    fs.existsSync(path.join(installedRoot, packageKey)) ||
    !removedPackage ||
    removedPackage.desiredState !== 'dormant' ||
    removedPackage.verdict !== 'dormant'
  ) {
    throw new Error(
      'installed KFX removal did not leave an absent, dormant registry record',
    );
  }

  const body = {
    schema: 'kungfu.installed-kfx-webhook-agent-qualification/v1',
    status: 'passed',
    platform: `${process.platform}-${process.arch}`,
    task: {
      naturalLanguage: task,
      agentInput: 'installed-product-and-user-goal-only',
      repositoryRead: false,
      hiddenCommandUse: false,
      interventions: [
        {
          kind: 'qualification-fixture-authority',
          reason:
            'the automated native lifecycle used exact-root test-only install and removal authorities',
          humanIntervention: false,
        },
      ],
    },
    productVersion: capabilities.productVersion,
    artifactIdentity,
    contractRoot: capabilities.contractRoot,
    sdkRoot: capabilities.sdk.root,
    sourceRoot: inspection.sourceRoot,
    artifactRoot: built.artifactRoot,
    qualificationRoot: qualification.qualificationRoot,
    replacementSourceRoot: replacementValidation.sourceRoot,
    replacementArtifactRoot: replacementBuilt.artifactRoot,
    packageRoot: contentRoot(fs.readFileSync(packagePath)),
    packageReceiptRoot: packaged.receiptRoot,
    native: {
      installed: true,
      activated: installedPackage.observedState,
      packageRoot: installedInspection.package.packageRoot,
      capabilityGrantRoot: installedGrantRoot,
      replacementPackageRoot: replaced.package.packageRoot,
      replacementCapabilityGrantRoot:
        replaced.package.authority?.capabilityGrantRoot ?? null,
      rollbackPackageRoot: rolledBack.package.packageRoot,
      rollbackCapabilityGrantRoot:
        rolledBack.package.authority?.capabilityGrantRoot ?? null,
      removed: true,
      removedDesiredState: removedPackage.desiredState,
      removedVerdict: removedPackage.verdict,
    },
    failureEvidence: { sdkDrift: drift.code },
    offline: qualification.receiver?.externalNetwork === false,
    sourceFallback: false,
    commandTrace,
  };
  const receipt = {
    ...body,
    evidenceRoot: contentRoot(JSON.stringify(body)),
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return receipt;
}
