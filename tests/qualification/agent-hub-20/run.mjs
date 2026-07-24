#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  adapterPath,
  privateHomeSnapshot,
  productIdentity,
  readJson,
  semanticRoot,
  sha256,
  validateKfdPackage,
} from './lib.mjs';

function options(argv) {
  const selected = { kungfu: '/usr/local/bin/kungfu', timeoutMs: 30000 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--kungfu' && value) {
      selected.kungfu = path.resolve(value);
      index += 1;
    } else if (flag === '--kfd-root' && value) {
      selected.kfdRoot = path.resolve(value);
      index += 1;
    } else if (flag === '--output-dir' && value) {
      selected.outputDir = path.resolve(value);
      index += 1;
    } else if (flag === '--timeout-ms' && value) {
      selected.timeoutMs = Number(value);
      index += 1;
    } else {
      throw new Error(`unsupported or incomplete argument: ${flag}`);
    }
  }
  if (!selected.kfdRoot) throw new Error('--kfd-root is required');
  if (!selected.outputDir) throw new Error('--output-dir is required');
  if (fs.existsSync(selected.outputDir)) {
    throw new Error(`qualification output must be new: ${selected.outputDir}`);
  }
  assert.equal(
    Number.isSafeInteger(selected.timeoutMs) && selected.timeoutMs >= 100,
    true,
  );
  return selected;
}

function run(command, args, expected = 0) {
  const result = childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, KFD_AGENT_HUB_OFFLINE: '1' },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== expected) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function main() {
  const selected = options(process.argv.slice(2));
  const { lock, observed } = validateKfdPackage(selected.kfdRoot);
  const product = productIdentity(selected.kungfu);
  if (
    product.sourceCommit !== product.releaseManifestSourceCommit ||
    product.sourcePristine !== true
  ) {
    throw new Error(
      'installed product provenance is not a pristine single source cut',
    );
  }
  fs.mkdirSync(selected.outputDir, { recursive: false });
  const domainsRoot = path.join(selected.outputDir, 'domains');
  fs.mkdirSync(domainsRoot);
  const reportPath = path.join(selected.outputDir, 'kfd-agent-hub-report.json');
  const before = privateHomeSnapshot();
  run(process.execPath, [
    path.join(selected.kfdRoot, 'bin/kfd.mjs'),
    'test',
    'agent-hub',
    '--adapter',
    adapterPath,
    '--adapter-arg',
    '--kungfu',
    '--adapter-arg',
    selected.kungfu,
    '--adapter-arg',
    '--qualification-root',
    '--adapter-arg',
    domainsRoot,
    '--adapter-source-commit',
    product.sourceCommit,
    '--output',
    reportPath,
    '--timeout-ms',
    String(selected.timeoutMs),
  ]);
  const verifierText = run(process.execPath, [
    path.join(selected.kfdRoot, 'bin/kfd.mjs'),
    'verify',
    'agent-hub-report',
    reportPath,
    '--adapter',
    adapterPath,
    '--json',
  ]);
  const verifier = JSON.parse(verifierText);
  const after = privateHomeSnapshot();
  const report = readJson(reportPath);
  const qualification = {
    schema: 'kungfu.kfd-agent-hub-20-qualification/v1',
    claim: 'installed-kungfu-local-peer-kfd-agent-hub-20',
    qualifyingBoundary: {
      product: 'Kungfu Work installed macOS arm64 artifact',
      topology: 'two isolated local-peer Hub authority domains',
      suite: 'KFD Agent Hub 20 experimental alpha profile',
      portability: 'content-bound local export/import observation',
      excludes: [
        'KFD certification',
        'external vendor adoption',
        'production fitness',
        'network transport interoperability',
        'stable or public release',
        'unobserved platforms',
      ],
    },
    kfd: { lock, observed },
    adapter: {
      path: 'tests/qualification/agent-hub-20/adapter.mjs',
      artifactDigest: sha256(fs.readFileSync(adapterPath)),
      sourceClassification: 'product-command-forwarder',
      semanticAuthority: 'installed Kungfu agent hub handle command',
    },
    product,
    isolation: {
      qualificationRootClass: 'retained-disposable-dual-hub-root',
      sourceHomeClass: 'domains/hub-alpha/.kungfu',
      targetHomeClass: 'domains/hub-beta/.kungfu',
      homesDistinct: true,
      sourceStorePresent: fs.existsSync(
        path.join(
          domainsRoot,
          'hub-alpha/.kungfu/runtime/agent-hub/exchange-store.json',
        ),
      ),
      targetStorePresent: fs.existsSync(
        path.join(
          domainsRoot,
          'hub-beta/.kungfu/runtime/agent-hub/exchange-store.json',
        ),
      ),
      realHomeBefore: before,
      realHomeAfter: after,
      realHomeUnchanged: semanticRoot(before) === semanticRoot(after),
    },
    report: {
      path: 'kfd-agent-hub-report.json',
      digest: semanticRoot(report),
      transcriptRoot: report.execution.transcriptRoot,
      resultRoot: report.execution.resultRoot,
      coverage: report.coverage,
      valid: report.valid,
    },
    verifier,
    releaseGateInput: true,
    valid:
      report.valid === true &&
      report.coverage.passed === 20 &&
      verifier.valid === true &&
      semanticRoot(before) === semanticRoot(after),
  };
  fs.writeFileSync(
    path.join(selected.outputDir, 'qualification.json'),
    `${JSON.stringify(qualification, null, 2)}\n`,
    { flag: 'wx' },
  );
  process.stdout.write(
    `Kungfu KFD Agent Hub 20 qualification: ${qualification.valid ? 'pass' : 'fail'} (${report.coverage.passed}/20) -> ${selected.outputDir}\n`,
  );
  if (!qualification.valid) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`agent-hub qualification: ${error.message}\n`);
  process.exitCode = 2;
}
