#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Internal least-privilege adapter for the repository-work experiment.

import { spawnSync } from 'node:child_process';
import process from 'node:process';

function fail(message) {
  process.stderr.write(`opencode-docker-proxy: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const result = {
    image: '',
    baseUrl: '',
    model: '',
    context: 65_536,
    mode: '',
    dockerHost: '',
    command: [],
  };
  let index = 0;
  for (; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') {
      result.command = argv.slice(index + 1);
      break;
    }
    if (value === '--image') result.image = argv[++index] || '';
    else if (value === '--base-url') result.baseUrl = argv[++index] || '';
    else if (value === '--model') result.model = argv[++index] || '';
    else if (value === '--context')
      result.context = Number.parseInt(argv[++index] || '', 10);
    else if (value === '--mode') result.mode = argv[++index] || '';
    else if (value === '--docker-host') result.dockerHost = argv[++index] || '';
    else fail(`unknown proxy argument: ${value}`);
  }
  if (!result.image.includes('@sha256:'))
    fail('--image must be pinned by digest');
  if (!/^https?:\/\/[^/]+(?::[0-9]+)?\/v1$/u.test(result.baseUrl))
    fail('--base-url must be an explicit HTTP(S) /v1 endpoint');
  if (!result.model || result.model.includes('/'))
    fail('--model must be a non-empty provider-local identifier');
  if (!Number.isInteger(result.context) || result.context < 8_192)
    fail('--context must be an integer of at least 8192');
  if (!['read-only', 'bounded-write'].includes(result.mode))
    fail('--mode must be read-only or bounded-write');
  try {
    result.dockerHost = validateDockerHost(result.dockerHost);
  } catch (error) {
    fail(error.message);
  }
  if (result.command[0] !== 'run')
    fail('only the OpenCode run command is supported');
  return result;
}

export function validateDockerHost(
  dockerHost,
  uid = typeof process.getuid === 'function' ? process.getuid() : 1000,
) {
  if (!dockerHost) return '';
  const allowed = new Set([
    'unix:///var/run/docker.sock',
    `unix:///run/user/${uid}/docker.sock`,
  ]);
  if (!allowed.has(dockerHost))
    throw new Error(
      '--docker-host must be the default rootful socket or the current user rootless socket',
    );
  return dockerHost;
}

function config({ baseUrl, model, context, mode }) {
  const writePermission = mode === 'read-only' ? 'deny' : 'allow';
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    permission: {
      '*': 'deny',
      read: 'allow',
      list: 'allow',
      glob: 'allow',
      grep: 'allow',
      edit: writePermission,
      bash: 'allow',
      external_directory: 'deny',
    },
    provider: {
      local: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Runtime supplied local provider',
        options: { baseURL: baseUrl },
        models: {
          [model]: {
            name: model,
            limit: { context, output: 8_192 },
          },
        },
      },
    },
  });
}

export function dockerArgs(options, cwd = process.cwd()) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;
  const containerUser = options.rootless ? '0:0' : `${uid}:${gid}`;
  const volume =
    options.mode === 'read-only' ? `${cwd}:/workspace:ro` : `${cwd}:/workspace`;
  return [
    'run',
    '--rm',
    '--user',
    containerUser,
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=512m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '256',
    '--memory',
    '8g',
    '--cpus',
    '4',
    '--network',
    'bridge',
    '--add-host',
    'host.docker.internal:host-gateway',
    '--volume',
    volume,
    '--workdir',
    '/workspace',
    '--env',
    'HOME=/tmp/opencode-home',
    '--env',
    'XDG_CONFIG_HOME=/tmp/opencode-config',
    '--env',
    'XDG_DATA_HOME=/tmp/opencode-data',
    '--env',
    'XDG_STATE_HOME=/tmp/opencode-state',
    '--env',
    'XDG_CACHE_HOME=/tmp/opencode-cache',
    '--env',
    'PYTHONDONTWRITEBYTECODE=1',
    '--env',
    `OPENCODE_CONFIG_CONTENT=${config(options)}`,
    options.image,
    'opencode',
    ...options.command,
  ];
}

export function dockerIsRootless(output) {
  let securityOptions;
  try {
    securityOptions = JSON.parse(output);
  } catch {
    fail('Docker SecurityOptions are not valid JSON');
  }
  if (
    !Array.isArray(securityOptions) ||
    securityOptions.some((option) => typeof option !== 'string')
  )
    fail('Docker SecurityOptions must be a string array');
  return securityOptions.some(
    (option) => option === 'rootless' || option === 'name=rootless',
  );
}

export function runProxy(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const dockerEnvironment = options.dockerHost
    ? { ...process.env, DOCKER_HOST: options.dockerHost }
    : process.env;
  const info = spawnSync(
    'docker',
    ['info', '--format', '{{json .SecurityOptions}}'],
    {
      encoding: 'utf8',
      env: dockerEnvironment,
    },
  );
  if (info.error) {
    process.stderr.write(`${info.error.message}\n`);
    return 127;
  }
  if (info.status !== 0) {
    process.stderr.write(info.stderr || 'docker info failed\n');
    return info.status ?? 1;
  }
  const result = spawnSync(
    'docker',
    dockerArgs({ ...options, rootless: dockerIsRootless(info.stdout.trim()) }),
    {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: dockerEnvironment,
    },
  );
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    return 127;
  }
  if (result.signal) {
    process.stderr.write(`docker terminated by ${result.signal}\n`);
    return 128;
  }
  return result.status ?? 1;
}

if (import.meta.url === `file://${process.argv[1]}`)
  process.exitCode = runProxy();
