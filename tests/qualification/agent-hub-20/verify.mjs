#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { evaluateReleaseGate } from './gate.mjs';
import {
  adapterPath,
  productIdentity,
  readJson,
  semanticRoot,
  sha256,
  validateKfdPackage,
} from './lib.mjs';

function options(argv) {
  const selected = { kungfu: '/usr/local/bin/kungfu' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--kungfu' && value) {
      selected.kungfu = path.resolve(value);
      index += 1;
    } else if (flag === '--kfd-root' && value) {
      selected.kfdRoot = path.resolve(value);
      index += 1;
    } else if (flag === '--qualification-dir' && value) {
      selected.qualificationDir = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`unsupported or incomplete argument: ${flag}`);
    }
  }
  if (!selected.kfdRoot) throw new Error('--kfd-root is required');
  if (!selected.qualificationDir)
    throw new Error('--qualification-dir is required');
  return selected;
}

function main() {
  const selected = options(process.argv.slice(2));
  const { lock, observed } = validateKfdPackage(selected.kfdRoot);
  const qualificationPath = path.join(
    selected.qualificationDir,
    'qualification.json',
  );
  const reportPath = path.join(
    selected.qualificationDir,
    'kfd-agent-hub-report.json',
  );
  const qualification = readJson(qualificationPath);
  const report = readJson(reportPath);
  const currentProduct = productIdentity(selected.kungfu);
  const verifier = childProcess.spawnSync(
    process.execPath,
    [
      path.join(selected.kfdRoot, 'bin/kfd.mjs'),
      'verify',
      'agent-hub-report',
      reportPath,
      '--adapter',
      adapterPath,
      '--json',
    ],
    { encoding: 'utf8', env: { ...process.env, KFD_AGENT_HUB_OFFLINE: '1' } },
  );
  const offline = verifier.status === 0 ? JSON.parse(verifier.stdout) : null;
  const evaluated = evaluateReleaseGate({
    qualification,
    report,
    lock,
    observed,
    currentProduct,
    currentAdapterDigest: sha256(fs.readFileSync(adapterPath)),
    offlineVerifierStatus: verifier.status,
    offline,
  });
  const result = {
    schema: 'kungfu.kfd-agent-hub-20-release-gate/v1',
    valid: evaluated.valid,
    qualificationDigest: semanticRoot(qualification),
    reportDigest: semanticRoot(report),
    checks: evaluated.checks,
    offlineVerifier: offline,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = evaluated.valid ? 0 : 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`agent-hub release gate: ${error.message}\n`);
  process.exitCode = 2;
}
