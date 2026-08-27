#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createKfdPrebuildGate,
  runVerifiedQualification,
  sealKfdSourceEvidence,
  verifyKfdCandidatePayloadSet,
  verifyKfdManifestSet,
} from '../framework/release/kfd-candidate-evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parse(argv) {
  const mode = argv.shift() || '';
  const options = { command: [] };
  while (argv.length > 0) {
    const arg = argv.shift();
    if (arg === '--') {
      options.command = argv.splice(0);
      break;
    }
    if (!arg?.startsWith('--')) throw new Error(`unknown argument: ${arg}`);
    const key = arg
      .slice(2)
      .replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    const value = argv.shift();
    if (!value || value.startsWith('--'))
      throw new Error(`${arg} requires a value`);
    options[key] = value;
  }
  return { mode, options };
}

function writeOutput(filePath, name, value) {
  if (!filePath) return;
  fs.appendFileSync(filePath, `${name}=${value}\n`);
}

function usage() {
  return `Usage:
  node scripts/kfd-candidate-evidence.mjs source-check --source-sha SHA --source-tree TREE --out FILE [--github-output FILE]
  node scripts/kfd-candidate-evidence.mjs source --source-sha SHA --source-tree TREE --expected-input-root ROOT
  node scripts/kfd-candidate-evidence.mjs run-verify --platform PLATFORM --source-sha SHA --source-tree TREE -- COMMAND...
  node scripts/kfd-candidate-evidence.mjs verify-manifest-set --manifest-root DIR --source-sha SHA
  node scripts/kfd-candidate-evidence.mjs verify-set --payload-root DIR --source-sha SHA [--source-tree TREE]
`;
}

const { mode, options } = parse(process.argv.slice(2));
let result;
if (mode === 'source-check') {
  result = createKfdPrebuildGate({
    root: ROOT,
    sourceSha: options.sourceSha,
    sourceTree: options.sourceTree,
  });
  if (options.out) {
    fs.mkdirSync(path.dirname(path.resolve(ROOT, options.out)), {
      recursive: true,
    });
    fs.writeFileSync(
      path.resolve(ROOT, options.out),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
  writeOutput(options.githubOutput, 'kfd-source-input-root', result.inputRoot);
} else if (mode === 'source') {
  result = sealKfdSourceEvidence({
    root: ROOT,
    expectedInputRoot: options.expectedInputRoot,
    sourceSha: options.sourceSha,
    sourceTree: options.sourceTree,
    platform: options.platform,
  });
} else if (mode === 'run-verify') {
  if (!options.command.length)
    throw new Error('run-verify requires a command after --');
  process.exitCode = runVerifiedQualification({
    root: ROOT,
    command: options.command,
    platform: options.platform,
    sourceSha: options.sourceSha,
    sourceTree: options.sourceTree,
  });
  result = { ok: process.exitCode === 0 };
} else if (mode === 'verify-manifest-set') {
  result = verifyKfdManifestSet({
    manifestRoot: path.resolve(ROOT, options.manifestRoot),
    sourceSha: options.sourceSha,
  });
} else if (mode === 'verify-set') {
  result = verifyKfdCandidatePayloadSet({
    payloadRoot: path.resolve(ROOT, options.payloadRoot),
    sourceSha: options.sourceSha,
    sourceTree: options.sourceTree,
  });
} else {
  process.stderr.write(usage());
  process.exitCode = 2;
}
if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
