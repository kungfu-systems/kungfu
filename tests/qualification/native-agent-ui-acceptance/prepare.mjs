// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const providers = new Set(['codex', 'claude', 'amp', 'opencode']);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../..');
const coreRoot = path.join(repoRoot, 'framework', 'core');
const pythonRoot = path.join(coreRoot, 'src', 'python');
const nativeRoot = path.join(coreRoot, 'build', 'Release');
const tuiEntry = path.join(repoRoot, 'framework', 'tui', 'dist', 'tui.mjs');
const sessionEntry = path.join(
  repoRoot,
  'framework',
  'tui',
  'dist',
  'native-agent-session.mjs',
);
const providerSkillSource = (provider) =>
  path.join(pythonRoot, 'kungfu', 'agent', 'skills', provider, 'SKILL.md');

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function flag(name) {
  return process.argv.includes(name);
}

if (flag('--help')) {
  process.stdout.write(
    [
      'Usage: node prepare.mjs [--provider codex|claude|amp|opencode] [--kungfu PATH] [--root EMPTY_DIRECTORY] [--work-id ID] [--json]',
      '',
      'Prepare disposable Kungfu config, runtime, Project, Work, and provider homes.',
      'The command prints exact acceptance commands but never launches a provider or TUI.',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function emptyOrMissing(directory) {
  if (!existsSync(directory)) return true;
  return (
    statSync(directory).isDirectory() && readdirSync(directory).length === 0
  );
}

function runKungfu(home, configHome, args) {
  const stdout = execFileSync(
    'uv',
    [
      'run',
      '--project',
      coreRoot,
      '--frozen',
      'python',
      '-m',
      'kungfu',
      '--home',
      home,
      ...args,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        KF_CONFIG_HOME: configHome,
        PYTHONPATH: [pythonRoot, nativeRoot, process.env.PYTHONPATH]
          .filter(Boolean)
          .join(path.delimiter),
      },
    },
  );
  return JSON.parse(stdout);
}

function commandEnvironment(paths) {
  return {
    PATH: [paths.bin, process.env.PATH].filter(Boolean).join(path.delimiter),
    KUNGFU_CLI_BIN: paths.sourceCli,
    HOME: paths.providerHome,
    CODEX_HOME: path.join(paths.providerRoot, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(paths.providerRoot, 'claude'),
    XDG_CONFIG_HOME: path.join(paths.providerRoot, 'xdg-config'),
    XDG_DATA_HOME: path.join(paths.providerRoot, 'xdg-data'),
    XDG_CACHE_HOME: path.join(paths.providerRoot, 'xdg-cache'),
    TMPDIR: paths.tmp,
    KF_CONFIG_HOME: paths.configHome,
    UV_CACHE_DIR: path.join(os.homedir(), '.cache', 'uv'),
    UV_PYTHON_INSTALL_DIR: path.join(
      os.homedir(),
      '.local',
      'share',
      'uv',
      'python',
    ),
    UV_PROJECT_ENVIRONMENT: paths.pythonEnvironment,
  };
}

function renderEnvironment(environment) {
  return Object.entries(environment)
    .map(([key, value]) => `${key}=${shellQuote(value)} \\`)
    .join('\n');
}

function resolveAgentSessionEndpoint(paths, runtimeDir) {
  return execFileSync(
    'uv',
    [
      'run',
      '--project',
      coreRoot,
      '--frozen',
      'python',
      '-c',
      [
        'import sys',
        'from kungfu.agent.session_surface import endpoint_for_runtime',
        'print(endpoint_for_runtime(sys.argv[1]))',
      ].join(';'),
      runtimeDir,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        KF_CONFIG_HOME: paths.configHome,
        PYTHONPATH: [pythonRoot, nativeRoot, process.env.PYTHONPATH]
          .filter(Boolean)
          .join(path.delimiter),
        UV_PROJECT_ENVIRONMENT: paths.pythonEnvironment,
      },
    },
  ).trim();
}

function renderCommands(paths, provider, frontDoor, workId) {
  const environment = commandEnvironment(paths);
  const shared = renderEnvironment(environment);
  const pythonPath = [pythonRoot, nativeRoot].join(path.delimiter);
  const providerCommand = [
    `cd ${shellQuote(paths.project)}`,
    '',
    shared,
    `KUNGFU_AGENT_SESSION_EXECUTABLE=${shellQuote(frontDoor)} \\`,
    `KUNGFU_NATIVE_AGENT_SESSION_ENTRY=${shellQuote(sessionEntry)} \\`,
    `PYTHONPATH=${shellQuote(pythonPath)} \\`,
    `uv run --project ${shellQuote(coreRoot)} --frozen python -m kungfu --home ${shellQuote(paths.home)} run ${provider}`,
  ].join('\n');
  const tuiCommand = [
    `cd ${shellQuote(paths.project)}`,
    '',
    shared,
    `KUNGFU_TUI_ENTRY=${shellQuote(tuiEntry)} \\`,
    shellQuote(paths.sourceCli),
  ].join('\n');
  const statusCommand = [
    `cd ${shellQuote(paths.project)}`,
    '',
    shared,
    `PYTHONPATH=${shellQuote(pythonPath)} \\`,
    `uv run --project ${shellQuote(coreRoot)} --frozen python -m kungfu --home ${shellQuote(paths.home)} work status \\`,
    `  --workspace ${shellQuote(paths.project)} \\`,
    `  --initiative-id ${shellQuote(workId)} \\`,
    `  --assignment-id ${shellQuote(workId)}`,
  ].join('\n');
  const sessionCommand = [
    `cd ${shellQuote(paths.project)}`,
    '',
    shared,
    `KUNGFU_AGENT_SESSION_ENDPOINT=${shellQuote(paths.sessionEndpoint)} \\`,
    `PYTHONPATH=${shellQuote(pythonPath)} \\`,
    `uv run --project ${shellQuote(coreRoot)} --frozen python -m kungfu --home ${shellQuote(paths.home)} agent session list \\`,
    `  --endpoint ${shellQuote(paths.sessionEndpoint)} \\`,
    '  --json',
  ].join('\n');
  const stageCommand = [
    `${shellQuote(paths.sourceCli)} work stage \\`,
    `  --workspace ${shellQuote(paths.project)} \\`,
    `  --initiative-id ${shellQuote(workId)} \\`,
    `  --assignment-id ${shellQuote(workId)} \\`,
    '  --actor native-agent-acceptance \\',
    "  --reason 'Record partial progress from the first native Agent UI'",
  ].join('\n');
  const bindWorkCommand = [
    `${shellQuote(paths.sourceCli)} agent console bind-work \\`,
    `  --initiative-id ${shellQuote(workId)} \\`,
    `  --assignment-id ${shellQuote(workId)} \\`,
    '  --json',
  ].join('\n');
  const directProviderCommand = [
    `export PATH=${shellQuote(paths.bin)}:"$PATH"`,
    `cd ${shellQuote(paths.project)}`,
    `kungfu run ${provider}`,
  ].join('\n');
  return {
    directProvider: directProviderCommand,
    provider: providerCommand,
    tui: tuiCommand,
    status: statusCommand,
    session: sessionCommand,
    bindWork: bindWorkCommand,
    stage: stageCommand,
  };
}

function validateShell(command, label) {
  try {
    execFileSync('/bin/bash', ['-n'], {
      encoding: 'utf8',
      input: `${command}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const diagnostic = String(error?.stderr || error?.message || error).trim();
    throw new Error(`${label} command is not valid Bash: ${diagnostic}`);
  }
}

function writeLauncher(root, label, command) {
  const launcher = path.join(root, `${label}.sh`);
  const body = ['#!/bin/bash', 'set -euo pipefail', command, ''].join('\n');
  validateShell(body, `${label} launcher`);
  writeFileSync(launcher, body, {
    encoding: 'utf8',
    mode: 0o700,
    flag: 'wx',
  });
  return launcher;
}

function writeVisibleProviderLauncher(root, command, sourceCli) {
  const launcher = path.join(root, 'provider-visible.sh');
  const body = [
    '#!/bin/bash',
    'set -u',
    "echo 'Starting the provider-native UI. Terminal settings will be restored after exit.'",
    `echo ${shellQuote(`Exact Kungfu CLI: ${sourceCli}`)}`,
    "stdin_tty='no'",
    "stdout_tty='no'",
    "stderr_tty='no'",
    "saved_tty_state=''",
    "tty_device=''",
    "[ -t 0 ] && stdin_tty='yes'",
    "[ -t 1 ] && stdout_tty='yes'",
    "[ -t 2 ] && stderr_tty='yes'",
    'if [ -t 0 ]; then',
    '  tty_device=$(tty 2>/dev/null || true)',
    '  if [ -n "$tty_device" ]; then',
    '    if [ "$(uname -s)" = "Darwin" ]; then',
    '      saved_tty_state=$(stty -g -f "$tty_device" 2>/dev/null || true)',
    '    else',
    '      saved_tty_state=$(stty -g -F "$tty_device" 2>/dev/null || true)',
    '    fi',
    '  fi',
    'fi',
    'restore_terminal() {',
    '  if [ -n "$tty_device" ]; then',
    '    if [ "$(uname -s)" = "Darwin" ]; then',
    '      stty -f "$tty_device" sane >/dev/null 2>&1 || true',
    '      if [ -n "$saved_tty_state" ]; then',
    '        stty -f "$tty_device" "$saved_tty_state" >/dev/null 2>&1 || true',
    '      fi',
    '    else',
    '      stty -F "$tty_device" sane >/dev/null 2>&1 || true',
    '      if [ -n "$saved_tty_state" ]; then',
    '        stty -F "$tty_device" "$saved_tty_state" >/dev/null 2>&1 || true',
    '      fi',
    '    fi',
    '  fi',
    '}',
    'trap restore_terminal EXIT',
    'echo "Terminal: stdin=$stdin_tty stdout=$stdout_tty stderr=$stderr_tty TERM=${TERM-<unset>} TERM_PROGRAM=${TERM_PROGRAM-<unset>}"',
    'provider_exit=0',
    `${command} || provider_exit=$?`,
    'restore_terminal',
    'sleep 0.2',
    'restore_terminal',
    "echo ''",
    "echo '------------------------------------------------------------'",
    'echo "Kungfu provider exited with status: $provider_exit"',
    `echo ${shellQuote(`Exact Kungfu CLI was: ${sourceCli}`)}`,
    'if [ "$provider_exit" -ne 0 ]; then',
    "  echo 'Copy the Error line, terminal diagnostics, and status above; the wrapper is returning to the shell.'",
    'fi',
    'exit "$provider_exit"',
    '',
  ].join('\n');
  validateShell(body, 'visible provider launcher');
  writeFileSync(launcher, body, {
    encoding: 'utf8',
    mode: 0o700,
    flag: 'wx',
  });
  return launcher;
}

const provider = option('--provider', 'codex');
if (!providers.has(provider)) {
  throw new Error(`unsupported provider '${provider}'`);
}
const workId = option('--work-id', 'native-agent-ui-acceptance');
if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(workId)) {
  throw new Error(`invalid --work-id '${workId}'`);
}
const skillSource = providerSkillSource(provider);
const skillText = readFileSync(skillSource, 'utf8');
if (!/^---\n(?:.|\n)*?^name: kungfu-agent-onboarding$/m.test(skillText)) {
  throw new Error(
    `provider Skill lacks native discovery metadata: ${skillSource}`,
  );
}
const frontDoor = path.resolve(
  option(
    '--kungfu',
    process.env.KUNGFU_ACCEPTANCE_KUNGFU || '/usr/local/bin/kungfu',
  ),
);
for (const required of [frontDoor, tuiEntry, sessionEntry]) {
  if (!existsSync(required))
    throw new Error(`required acceptance artifact missing: ${required}`);
}

const requestedRoot = option('--root');
const root = requestedRoot
  ? path.resolve(requestedRoot)
  : mkdtempSync(path.join(os.tmpdir(), 'kungfu-native-agent-ui-acceptance-'));
if (requestedRoot && !emptyOrMissing(root)) {
  throw new Error(`--root must be absent or empty: ${root}`);
}
mkdirSync(root, { recursive: true });
const paths = {
  root,
  home: path.join(root, 'kungfu-home'),
  configHome: path.join(root, 'kungfu-config'),
  project: path.join(root, 'project'),
  providerRoot: path.join(root, 'provider'),
  providerHome: path.join(root, 'provider', 'home'),
  bin: path.join(root, 'bin'),
  sourceCli: path.join(root, 'bin', 'kungfu'),
  tmp: path.join(root, 'tmp'),
  pythonEnvironment: path.join(root, 'python-environment'),
};
process.env.UV_PROJECT_ENVIRONMENT = paths.pythonEnvironment;
for (const directory of [
  paths.home,
  paths.configHome,
  paths.providerHome,
  paths.bin,
  paths.tmp,
  path.join(paths.providerRoot, 'codex'),
  path.join(paths.providerRoot, 'claude'),
  path.join(paths.providerRoot, 'xdg-config'),
  path.join(paths.providerRoot, 'xdg-data'),
  path.join(paths.providerRoot, 'xdg-cache'),
]) {
  mkdirSync(directory, { recursive: true });
}

const sourceCliBody = [
  '#!/bin/bash',
  'set -euo pipefail',
  `export KF_CONFIG_HOME=${shellQuote(paths.configHome)}`,
  `export KUNGFU_AGENT_SESSION_EXECUTABLE=${shellQuote(frontDoor)}`,
  `export KUNGFU_NATIVE_AGENT_SESSION_ENTRY=${shellQuote(sessionEntry)}`,
  `export PYTHONPATH=${shellQuote([pythonRoot, nativeRoot].join(path.delimiter))}`,
  `export UV_PROJECT_ENVIRONMENT=${shellQuote(paths.pythonEnvironment)}`,
  `export KUNGFU_CLI_BIN=${shellQuote(paths.sourceCli)}`,
  `exec uv run --project ${shellQuote(coreRoot)} --frozen python -m kungfu --home ${shellQuote(paths.home)} "$@"`,
  '',
].join('\n');
validateShell(sourceCliBody, 'disposable source CLI');
writeFileSync(paths.sourceCli, sourceCliBody, {
  encoding: 'utf8',
  mode: 0o700,
  flag: 'wx',
});

const projectPlan = runKungfu(paths.home, paths.configHome, [
  'project',
  'create-plan',
  '--destination',
  paths.project,
]);
const projectReceipt = runKungfu(paths.home, paths.configHome, [
  'project',
  'create',
  paths.project,
  '--expected-plan-root',
  projectPlan.planRoot,
  '--execute',
]);
if (
  !path
    .resolve(projectReceipt.registryPath)
    .startsWith(`${paths.configHome}${path.sep}`)
) {
  throw new Error(
    `acceptance Project escaped disposable config: ${projectReceipt.registryPath}`,
  );
}

const requestPath = path.join(root, 'request.json');
writeFileSync(
  requestPath,
  `${JSON.stringify(
    {
      schema: 'kungfu.assignment-request/v1',
      source: { kind: 'native-agent-ui-acceptance' },
      retention: {
        policy: 'explicit-expiry-retain-bytes-v1',
        expiresAt: null,
      },
      workDefinition: {
        assignment_id: workId,
        initiative_id: workId,
        title: 'Native Agent UI acceptance',
        objective:
          'Record partial progress and continue it from a fresh native Agent UI without copying provider transcript.',
        acceptance_criteria: [
          'The first Agent records partial progress through public Kungfu Work commands.',
          'A fresh second Agent sees the same remaining obligation and next action.',
        ],
        evidence_episode_roots: [],
        remaining_obligation:
          'Restart the TUI and launch a fresh second provider process against the same Work.',
      },
    },
    null,
    2,
  )}\n`,
  { encoding: 'utf8', mode: 0o600, flag: 'wx' },
);
const capture = runKungfu(paths.home, paths.configHome, [
  'work',
  'capture',
  '--request',
  requestPath,
  '--workspace',
  paths.project,
  '--json',
]);
runKungfu(paths.home, paths.configHome, [
  'work',
  'admit',
  capture.requestPath,
  '--workspace',
  paths.project,
  '--initiative-id',
  workId,
  '--assignment-id',
  workId,
  '--actor',
  'local-user',
  '--actor-type',
  'user',
]);
const leaseExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
runKungfu(paths.home, paths.configHome, [
  'work',
  'claim',
  '--workspace',
  paths.project,
  '--initiative-id',
  workId,
  '--assignment-id',
  workId,
  '--owner',
  'local-user',
  '--agent',
  'native-agent-acceptance',
  '--slot',
  'interactive',
  '--lease-id',
  `${workId}-${Date.now()}`,
  '--lease-expires-at',
  leaseExpiresAt,
  '--authorized-by',
  'local-user',
  '--actor-type',
  'user',
]);
runKungfu(paths.home, paths.configHome, [
  'work',
  'kickoff',
  '--workspace',
  paths.project,
  '--initiative-id',
  workId,
  '--assignment-id',
  workId,
  '--actor',
  'native-agent-acceptance',
  '--reason',
  'Begin disposable native Agent UI acceptance',
]);

const status = runKungfu(paths.home, paths.configHome, [
  'work',
  'status',
  '--workspace',
  paths.project,
  '--initiative-id',
  workId,
  '--assignment-id',
  workId,
]);
if (status.phase !== 'executing') {
  throw new Error(`disposable Work did not reach executing: ${status.phase}`);
}
if (!status.query_proof_root) {
  throw new Error('disposable Work status is missing query_proof_root');
}
if (
  status.assignment?.work_definition?.remaining_obligation !==
  'Restart the TUI and launch a fresh second provider process against the same Work.'
) {
  throw new Error('disposable Work lost its remaining obligation');
}

paths.runtimeDir = path.join(realpathSync(paths.project), '.kungfu', 'runtime');
paths.sessionEndpoint = resolveAgentSessionEndpoint(paths, paths.runtimeDir);

const commands = renderCommands(paths, provider, frontDoor, workId);
for (const [label, command] of Object.entries(commands)) {
  validateShell(command, label);
}
const launchers = Object.fromEntries(
  ['provider', 'tui', 'status', 'session'].map((label) => [
    label,
    writeLauncher(root, label, commands[label]),
  ]),
);
launchers.providerVisible = writeVisibleProviderLauncher(
  root,
  commands.directProvider,
  paths.sourceCli,
);
const result = {
  schema: 'kungfu.native-agent-ui-acceptance-package/v2',
  provider,
  root,
  project: paths.project,
  configHome: paths.configHome,
  runtimeHome: paths.home,
  runtimeDir: paths.runtimeDir,
  sessionEndpoint: paths.sessionEndpoint,
  work: {
    initiativeId: workId,
    assignmentId: workId,
    requestRoot: capture.requestRoot,
    phase: status.phase,
    queryProofRoot: status.query_proof_root,
    remainingObligation: status.assignment.work_definition.remaining_obligation,
    nextActions: status.next_actions,
    leaseExpiresAt,
  },
  isolation: {
    realKungfuHomeUsed: false,
    realKungfuConfigUsed: false,
    realProviderHomeUsed: false,
    cleanupPerformed: false,
    sourceCli: paths.sourceCli,
    pythonEnvironment: paths.pythonEnvironment,
  },
  providerAdapter: {
    sessionScoped: true,
    providerHomeWrites: false,
    projectProviderConfigWrites: false,
    skillSource,
    awarenessProbe:
      'Without pasted context, identify what runtime launched this UI and report the exact workspace Console and SessionAttempt. Then use only the exact argv from KUNGFU_AGENT_CONTEXT.entrypoints.bindWork to bind this session to the native-agent-ui-acceptance Assignment before doing any work. Never invoke plan-native-bind-work or bind-native-work through kungfu agent session; those are internal protocol operations, not CLI entrypoints.',
  },
  directExperience: {
    inheritsProviderHome: true,
    purpose:
      'Exercise the familiar authenticated provider UI through the exact kungfu run command.',
    command: commands.directProvider,
  },
  commands,
  launchers,
  acceptance: [
    'Prefer launchers.providerVisible for manual acceptance. It preserves the native PTY, restores the exact terminal settings, prints the exit status, and returns directly to the shell without recording provider terminal bytes.',
    'Run commands.directProvider in terminals A and B at the same time. Both provider-native UIs must open without choosing or naming a WorkConsole.',
    'In terminal A, enter providerAdapter.awarenessProbe without pasting Kungfu context. The Agent must bind the exact Assignment through commands.bindWork before editing.',
    'In terminal B, ask the Agent to bind the same Assignment. Kungfu must return native_work_already_active with the active provider, attempt, Console, and recovery choices.',
    'Run commands.stage through terminal A after its successful binding. Do not claim completion.',
    'Run launchers.tui in terminal C and confirm both native attempts are observer-only while only terminal A owns the Work binding.',
    'Quit and rerun terminal C while A and B remain active; both providers must continue and the TUI must rediscover them.',
    'Exit terminal A, then retry commands.bindWork in terminal B. It must bind successfully without restarting B or copying transcript.',
    'Run launchers.session and verify two automatically named workspace Consoles, distinct SessionAttempts, and exactly one active binding for the Assignment.',
    'Run launchers.status to inspect the same Core Work phase, remaining obligation, and next action.',
  ],
  note: 'The preparer never launches a provider or TUI and never removes the disposable root.',
};
writeFileSync(
  path.join(root, 'acceptance-package.json'),
  `${JSON.stringify(result, null, 2)}\n`,
  { encoding: 'utf8', mode: 0o600, flag: 'wx' },
);
if (flag('--json')) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(
    [
      `Disposable acceptance package: ${root}`,
      `Package manifest: ${path.join(root, 'acceptance-package.json')}`,
      '',
      'Direct familiar provider experience:',
      commands.directProvider,
      '',
      'Terminal A — provider-native UI:',
      commands.provider,
      '',
      'Inside the first provider UI — record partial progress through public Kungfu CLI:',
      commands.bindWork,
      '',
      commands.stage,
      '',
      'Terminal B — Kungfu TUI observer:',
      commands.tui,
      '',
      'Core Work readback:',
      commands.status,
      '',
      'WorkConsole and SessionAttempt readback:',
      commands.session,
      '',
      'Open the provider command in terminals A and B concurrently; bind A, confirm B is blocked, then exit A and retry B.',
      'No cleanup was performed.',
      '',
    ].join('\n'),
  );
}
