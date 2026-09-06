#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cliSpawnSpecification } from '@kungfu-tech/product-kungfu/tooling/cli-surface-qualification';
import { readMetadataContract } from './document-metadata-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CREDENTIAL_ISLAND_POLICY =
  'docs/qualification/gates/macos-credential-island-policy.json';
const REQUIRED_FINAL_VERIFICATIONS = [
  'codesignStrict',
  'hardenedRuntime',
  'appStaple',
  'appGatekeeper',
  'dmgStaple',
  'dmgGatekeeper',
];

function fail(message) {
  throw new Error(`[release-platform-probe] ${message}`);
}

function run(command, args, root = ROOT) {
  const result = childProcess.spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    fail(
      `${command} ${args.join(' ')} failed: ${String(
        result.stderr || result.stdout || result.error?.message || '',
      ).trim()}`,
    );
  }
}

function capture(command, args) {
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    fail(
      `${command} ${args.join(' ')} failed: ${String(
        result.stderr || result.stdout || result.error?.message || '',
      ).trim()}`,
    );
  }
  return String(result.stdout || '').trim();
}

function exact(value, pattern, label) {
  const normalized = String(value || '').trim();
  if (!pattern.test(normalized)) fail(`${label} is invalid or missing`);
  return normalized;
}

export function probeAwsWindowsJitRunner({
  root = ROOT,
  platform = process.platform,
  env = process.env,
  runCommand = capture,
}) {
  if (platform !== 'win32')
    fail('AWS Windows JIT runner profile requires Windows');

  const labels = JSON.parse(env.BUILDCHAIN_RUNNER_LABELS_JSON || '[]');
  for (const required of ['self-hosted', 'Windows', 'X64']) {
    if (!labels.includes(required))
      fail(`runner labels are missing ${required}`);
  }
  const runnerLabel = labels.find((label) =>
    String(label).startsWith('aws-us-ec2-windows-jit-'),
  );
  exact(
    runnerLabel,
    /^aws-us-ec2-windows-jit-[a-z0-9][a-z0-9-]{0,31}$/,
    'runner label',
  );

  const vcvars = 'C:\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat';
  if (!fs.existsSync(vcvars))
    fail(`MSVC environment entrypoint is missing: ${vcvars}`);

  const report = {
    schemaVersion: 1,
    contract: 'kungfu.aws-windows-jit-runner-profile/v1',
    provider: 'aws-ec2',
    sourceSha: exact(env.GITHUB_SHA, /^[0-9a-f]{40}$/, 'source SHA'),
    githubRunId: exact(env.GITHUB_RUN_ID, /^\d+$/, 'GitHub run id'),
    githubRunAttempt: exact(
      env.GITHUB_RUN_ATTEMPT,
      /^\d+$/,
      'GitHub run attempt',
    ),
    runner: {
      name: String(env.RUNNER_NAME || ''),
      os: platform,
      architecture: process.arch,
      labels: [...labels].sort(),
    },
    aws: {
      instanceId: exact(
        env.AWS_EC2_INSTANCE_ID,
        /^i-[0-9a-f]+$/,
        'instance id',
      ),
      instanceType: exact(
        env.AWS_EC2_INSTANCE_TYPE,
        /^[a-z0-9.]+$/,
        'instance type',
      ),
      amiId: exact(env.AWS_EC2_AMI_ID, /^ami-[0-9a-f]+$/, 'AMI id'),
      amiName: String(env.AWS_EC2_AMI_NAME || ''),
      availabilityZone: String(env.AWS_EC2_AVAILABILITY_ZONE || ''),
      launchedAt: String(env.AWS_EC2_LAUNCHED_AT || ''),
    },
    toolchain: {
      git: runCommand('git.exe', ['--version']),
      node: runCommand('node.exe', ['--version']),
      rustc: runCommand('rustc.exe', ['--version']),
      cargo: runCommand('cargo.exe', ['--version']),
      vcvars64: vcvars,
    },
    cacheMode: 'off',
    observedAt: new Date().toISOString(),
  };
  report.digest = `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(report))
    .digest('hex')}`;

  const output = path.join(
    root,
    'product',
    'release',
    'qualification',
    'aws-windows-jit-smoke.json',
  );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  return { report, output };
}

export function probeAwsMacosJitRunner({
  root = ROOT,
  platform = process.platform,
  env = process.env,
  runCommand = capture,
}) {
  if (platform !== 'darwin')
    fail('AWS macOS JIT runner profile requires macOS');

  const labels = JSON.parse(env.BUILDCHAIN_RUNNER_LABELS_JSON || '[]');
  for (const required of ['self-hosted', 'macOS', 'ARM64']) {
    if (!labels.includes(required))
      fail(`runner labels are missing ${required}`);
  }
  const runnerLabel = labels.find((label) =>
    String(label).startsWith('aws-us-ec2-macos-jit-'),
  );
  exact(
    runnerLabel,
    /^aws-us-ec2-macos-jit-[a-z0-9][a-z0-9-]{0,31}$/,
    'runner label',
  );

  const report = {
    schemaVersion: 1,
    contract: 'kungfu.aws-macos-jit-runner-profile/v1',
    provider: 'aws-ec2-macos-jit',
    sourceSha: exact(env.GITHUB_SHA, /^[0-9a-f]{40}$/, 'source SHA'),
    githubRunId: exact(env.GITHUB_RUN_ID, /^\d+$/, 'GitHub run id'),
    githubRunAttempt: exact(
      env.GITHUB_RUN_ATTEMPT,
      /^\d+$/,
      'GitHub run attempt',
    ),
    runner: {
      name: String(env.RUNNER_NAME || ''),
      os: platform,
      architecture: process.arch,
      labels: [...labels].sort(),
    },
    aws: {
      hostId: exact(
        env.AWS_EC2_MAC_HOST_ID,
        /^h-[0-9a-f]+$/,
        'Dedicated Host id',
      ),
      hostAllocatedAt: String(env.AWS_EC2_MAC_HOST_ALLOCATED_AT || ''),
      instanceId: exact(
        env.AWS_EC2_INSTANCE_ID,
        /^i-[0-9a-f]+$/,
        'instance id',
      ),
      instanceType: exact(
        env.AWS_EC2_INSTANCE_TYPE,
        /^mac2\.metal$/,
        'instance type',
      ),
      amiId: exact(env.AWS_EC2_AMI_ID, /^ami-[0-9a-f]+$/, 'AMI id'),
      amiName: String(env.AWS_EC2_AMI_NAME || ''),
      availabilityZone: String(env.AWS_EC2_AVAILABILITY_ZONE || ''),
      launchedAt: String(env.AWS_EC2_LAUNCHED_AT || ''),
    },
    toolchain: {
      git: runCommand('git', ['--version']),
      node: runCommand('node', ['--version']),
      rustc: runCommand('rustc', ['--version']),
      cargo: runCommand('cargo', ['--version']),
      developerDirectory: runCommand('xcode-select', ['-p']),
      clang: runCommand('xcrun', ['clang', '--version']),
    },
    cacheMode: 'off',
    observedAt: new Date().toISOString(),
  };
  report.digest = `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(report))
    .digest('hex')}`;

  const output = path.join(
    root,
    'product',
    'release',
    'qualification',
    'aws-macos-jit-smoke.json',
  );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  return { report, output };
}

function findApplications(root) {
  const matches = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory() && target.endsWith('.app')) matches.push(target);
      else if (entry.isDirectory()) visit(target);
    }
  };
  visit(root);
  return matches;
}

function credentialIslandPolicy(root) {
  const policyPath = path.join(root, CREDENTIAL_ISLAND_POLICY);
  if (!fs.existsSync(policyPath)) return null;
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch (error) {
    fail(
      `failed to read macOS credential-island policy: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    policy.schema !== 'kungfu.macos-credential-island-policy/v1' ||
    !policy.repository ||
    !policy.environment ||
    !policy.platformId ||
    !policy.app?.bundleId ||
    !['arm64', 'x64'].includes(policy.app?.architecture) ||
    !/^[A-Z0-9]{10}$/.test(policy.identity?.teamId || '') ||
    !/^[a-f0-9]{40}$/i.test(policy.identity?.certificateSha1 || '') ||
    !Array.isArray(policy.requiredVerifications) ||
    REQUIRED_FINAL_VERIFICATIONS.some(
      (verification) => !policy.requiredVerifications.includes(verification),
    )
  ) {
    fail('macOS credential-island policy is incomplete');
  }
  return policy;
}

function assertCredentialIslandApplication(application) {
  const contents = path.join(application, 'Contents');
  const infoPlist = path.join(contents, 'Info.plist');
  const executableDirectory = path.join(contents, 'MacOS');
  if (!fs.existsSync(infoPlist) || !fs.statSync(infoPlist).isFile())
    fail('credential-island application is missing Contents/Info.plist');
  if (
    !fs.existsSync(executableDirectory) ||
    !fs.statSync(executableDirectory).isDirectory() ||
    fs.readdirSync(executableDirectory).length === 0
  )
    fail('credential-island application is missing Contents/MacOS payload');
}

export function probeReleasePlatform({
  root = ROOT,
  platform = process.platform,
  runCommand = (command, args) => run(command, args, root),
}) {
  if (platform === 'darwin') {
    const applications = findApplications(
      path.join(root, 'product', 'dist', 'desktop'),
    );
    if (applications.length !== 1)
      fail(
        `expected one packaged macOS application, found ${applications.length}`,
      );
    if (credentialIslandPolicy(root)) {
      assertCredentialIslandApplication(applications[0]);
      return {
        platform,
        check: 'credential-island-application-structure',
        finalSignature: 'deferred',
        status: 'passed',
      };
    }
    runCommand('codesign', [
      '--verify',
      '--deep',
      '--strict',
      '--verbose=2',
      applications[0],
    ]);
    return { platform, check: 'codesign-structure', status: 'passed' };
  }
  if (platform === 'linux') {
    readMetadataContract(root);
    return { platform, check: 'adr-identity-contract', status: 'passed' };
  }
  if (platform === 'win32') {
    const specification = cliSpawnSpecification(
      'C:\\Program Files\\Kungfu\\kungfu.cmd',
      ['--version'],
      'win32',
      { ComSpec: 'cmd.exe' },
    );
    if (
      specification.shell !== 'cmd.exe' ||
      specification.args.length !== 0 ||
      !specification.command.includes('kungfu.cmd')
    )
      fail('Windows cmd shim does not route through ComSpec');
    return { platform, check: 'windows-cmd-spawn', status: 'passed' };
  }
  fail(`unsupported release platform: ${platform}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.includes('--aws-macos-jit')) {
    const { output } = probeAwsMacosJitRunner({});
    process.stdout.write(`${path.relative(ROOT, output)}\n`);
    process.exit(0);
  }
  if (process.argv.includes('--aws-windows-jit')) {
    const { output } = probeAwsWindowsJitRunner({});
    process.stdout.write(`${path.relative(ROOT, output)}\n`);
    process.exit(0);
  }
  const report = probeReleasePlatform({});
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
