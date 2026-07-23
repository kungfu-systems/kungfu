#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cliSpawnSpecification } from '../product/scripts/cli-surface-qualification.mjs';
import {
  ensureGitCommitAvailable,
  readMetadataContract,
} from './document-metadata-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  throw new Error(`[release-platform-probe] ${message}`);
}

function run(command, args) {
  const result = childProcess.spawnSync(command, args, {
    cwd: ROOT,
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

export function probeReleasePlatform({
  root = ROOT,
  platform = process.platform,
}) {
  if (platform === 'darwin') {
    const applications = findApplications(
      path.join(root, 'product', 'dist', 'desktop'),
    );
    if (applications.length !== 1)
      fail(
        `expected one packaged macOS application, found ${applications.length}`,
      );
    run('codesign', [
      '--verify',
      '--deep',
      '--strict',
      '--verbose=2',
      applications[0],
    ]);
    return { platform, check: 'codesign-structure', status: 'passed' };
  }
  if (platform === 'linux') {
    const contract = readMetadataContract(root);
    const cutover = contract.adrIdentity?.legacyCutoverCommit;
    if (!cutover) fail('ADR cutover commit is not configured');
    ensureGitCommitAvailable(root, cutover);
    return { platform, check: 'adr-cutover-history', status: 'passed' };
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
