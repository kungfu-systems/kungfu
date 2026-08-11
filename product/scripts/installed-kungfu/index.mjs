// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
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
