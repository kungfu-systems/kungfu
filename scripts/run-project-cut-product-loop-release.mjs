#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ProjectCutProductLoopReleaseError,
  loadProjectCutProductLoopReleaseContract,
  verifyRetainedProjectCutProductLoopRelease,
} from './project-cut-product-loop-release.mjs';
import { writeShifuGateEvidence } from './shifu-gate-evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  return (
    'usage: node scripts/run-project-cut-product-loop-release.mjs ' +
    '--evidence FILE --passport FILE [--json]'
  );
}

function parseArgs(argv) {
  const options = { evidence: '', passport: '', json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument !== '--evidence' && argument !== '--passport') {
      throw new Error(`unknown argument '${argument}'`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a file`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (!options.evidence || !options.passport) {
    throw new Error('--evidence and --passport are required');
  }
  return options;
}

function git(root, args) {
  const result = childProcess.spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    ),
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${String(result.stderr || '').trim()}`,
    );
  }
  return String(result.stdout || '').trim();
}

function requireCleanTrackedSource(root) {
  const unstaged = childProcess.spawnSync('git', ['diff', '--quiet', '--'], {
    cwd: root,
  });
  const staged = childProcess.spawnSync(
    'git',
    ['diff', '--cached', '--quiet', '--'],
    { cwd: root },
  );
  if (unstaged.status !== 0 || staged.status !== 0) {
    throw new Error(
      'tracked source is dirty; qualify an exact committed source checkout',
    );
  }
}

function repositoryFile(root, value, label) {
  const absoluteRoot = fs.realpathSync(root);
  const absolute = fs.realpathSync(path.resolve(root, value));
  const relative = path.relative(absoluteRoot, absolute).replaceAll('\\', '/');
  if (!relative || relative === '..' || relative.startsWith('../')) {
    throw new Error(`${label} must stay inside the repository`);
  }
  return { absolute, relative };
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function sha256(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

export function runProjectCutProductLoopRelease({
  root = ROOT,
  evidencePath,
  passportPath,
  gateEvidenceFile = process.env.SHIFU_GATE_EVIDENCE_FILE,
}) {
  requireCleanTrackedSource(root);
  const sourceCommit = git(root, ['rev-parse', 'HEAD']);
  const evidenceFile = repositoryFile(root, evidencePath, 'evidence');
  const passportFile = repositoryFile(root, passportPath, 'release passport');
  const contract = loadProjectCutProductLoopReleaseContract(
    path.join(
      root,
      'framework/work/work-loop/project-cut-product-loop.release-contract.json',
    ),
  );
  const evidence = readJson(evidenceFile.absolute, 'evidence');
  verifyRetainedProjectCutProductLoopRelease(
    {
      evidence,
      passport: readJson(passportFile.absolute, 'release passport'),
      passportDigest: sha256(passportFile.absolute),
      passportRef: passportFile.relative,
      sourceCommit,
    },
    contract,
  );
  writeShifuGateEvidence({
    schema: 'kungfu.project-cut-product-loop.gate-evidence/v1',
    pointers: [
      { id: 'project-cut-product-loop-report', file: evidenceFile.absolute },
      { id: 'buildchain-release-passport', file: passportFile.absolute },
    ],
    root,
    evidenceFile: gateEvidenceFile,
  });
  return {
    schema: 'kungfu.project-cut-product-loop.release-run/v1',
    verification: 'pass',
    sourceCommit,
    evidence: evidenceFile.relative,
    releasePassport: {
      ref: passportFile.relative,
      digest: sha256(passportFile.absolute),
    },
    targetGate: contract.targetGate,
  };
}

export function main(argv = process.argv.slice(2), root = ROOT) {
  let options;
  try {
    options = parseArgs(argv);
    const result = runProjectCutProductLoopRelease({
      root,
      evidencePath: options.evidence,
      passportPath: options.passport,
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `[project-cut-product-loop] verification=pass source=${result.sourceCommit} evidence=${result.evidence}`,
      );
    }
    return 0;
  } catch (error) {
    const message =
      error instanceof ProjectCutProductLoopReleaseError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`[project-cut-product-loop] ${message}`);
    console.error(usage());
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main());
