// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliQualificationRoot } from './cli-surface-qualification.mjs';

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function verifyCliSurfaceQualification({
  report,
  expectedPlatform,
  archiveName,
  archiveSha256,
}) {
  assert(
    report?.schema === 'kungfu.cli-installed-product-qualification/v1',
    `unexpected qualification schema: ${report?.schema}`,
  );
  assert(report.qualified === true, 'CLI qualification is not qualified');
  assert(report.label === 'cli-archive', `unexpected label: ${report.label}`);
  assert(
    report.platform === expectedPlatform,
    `platform mismatch: expected ${expectedPlatform}, got ${report.platform}`,
  );
  assert(
    report.identity?.archive === archiveName,
    `archive name mismatch: expected ${archiveName}, got ${report.identity?.archive}`,
  );
  assert(
    ROOT_PATTERN.test(report.identity?.archiveSha256 || ''),
    'qualification omitted a valid archive SHA256',
  );
  assert(
    report.identity.archiveSha256 === archiveSha256,
    `archive SHA256 mismatch: expected ${archiveSha256}, got ${report.identity.archiveSha256}`,
  );
  assert(
    report.productIdentity?.verifiedFromInstalledCommand === true,
    'product identity was not verified from the installed command',
  );
  assert(
    report.checks?.kfd3?.linkedApiCount > 0,
    'installed CLI qualification omitted KFD-3 linkage',
  );
  assert(
    report.checks?.mutationPlanReceipt?.planReplayStable === true &&
      report.checks?.mutationPlanReceipt?.receiptVerified === true,
    'installed CLI qualification omitted a verified mutation receipt',
  );
  assert(
    report.isolation?.sourceCheckoutRequired === false &&
      report.isolation?.guiPrivateStateRequired === false,
    'qualification depends on source checkout or GUI-private state',
  );
  assert(
    ROOT_PATTERN.test(report.qualificationRoot || ''),
    'qualification omitted a valid semantic root',
  );
  const { qualificationRoot, ...subject } = report;
  assert(
    qualificationRoot === cliQualificationRoot(subject),
    'qualification semantic root mismatch',
  );
  return {
    schema: 'kungfu.cli-installed-product-qualification-verification/v1',
    verified: true,
    platform: report.platform,
    archive: report.identity.archive,
    archiveSha256: report.identity.archiveSha256,
    qualificationRoot,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (!['--qualification', '--archive', '--platform'].includes(arg)) {
      throw new Error(`unknown option: ${arg}`);
    }
    index += 1;
    if (index >= argv.length) throw new Error(`${arg} requires a value`);
    options[arg.slice(2)] = argv[index];
  }
  return options;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read qualification ${file}: ${error.message}`);
  }
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

async function main(argv) {
  const options = parseArgs(argv);
  for (const required of ['qualification', 'archive', 'platform']) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  const qualification = path.resolve(options.qualification);
  const archive = path.resolve(options.archive);
  const verification = verifyCliSurfaceQualification({
    report: readJson(qualification),
    expectedPlatform: options.platform,
    archiveName: path.basename(archive),
    archiveSha256: await sha256File(archive),
  });
  process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `[verify-cli-surface-qualification] ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
