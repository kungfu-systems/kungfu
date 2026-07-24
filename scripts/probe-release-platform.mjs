#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cliSpawnSpecification } from '../product/scripts/cli-surface-qualification.mjs';
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
  const report = probeReleasePlatform({});
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
