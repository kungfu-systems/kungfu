// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cliQualificationNonClaims,
  cliQualificationRoot,
} from './cli-surface-qualification.mjs';

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SOURCE_PATTERN = /^[0-9a-f]{40}$/u;

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
  const expectedArchitecture = expectedPlatform.split('-').at(-1);
  assert(
    report.architecture === expectedArchitecture,
    `architecture mismatch: expected ${expectedArchitecture}, got ${report.architecture}`,
  );
  assert(
    typeof report.version === 'string' && report.version.length > 0,
    'qualification omitted the installed version',
  );
  assert(
    SOURCE_PATTERN.test(report.identity?.sourceCommit || ''),
    'qualification omitted an exact source commit',
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
    report.claims?.installedProduct === true &&
      report.claims?.qualifiedPlatform === expectedPlatform,
    'qualification claims do not bind the qualified platform',
  );
  assert(
    JSON.stringify(report.nonClaims) ===
      JSON.stringify(cliQualificationNonClaims(expectedPlatform)),
    'qualification non-claims contradict the qualified platform',
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
    architecture: report.architecture,
    version: report.version,
    sourceCommit: report.identity.sourceCommit,
    archive: report.identity.archive,
    archiveSha256: report.identity.archiveSha256,
    qualificationRoot,
  };
}

export function finalizeSignedCliQualification({
  report,
  expectedPlatform,
  archiveName,
  archiveSha256,
  signingResult,
  signingReceipt,
  expectedSourceCommit,
}) {
  assert(
    SOURCE_PATTERN.test(expectedSourceCommit || ''),
    'finalization omitted an exact expected source commit',
  );
  assert(
    report.identity?.sourceCommit === expectedSourceCommit,
    `qualification source mismatch: expected ${expectedSourceCommit}, got ${report.identity?.sourceCommit}`,
  );
  assert(
    ROOT_PATTERN.test(report.identity?.archiveSha256 || ''),
    'qualification omitted its pre-signing archive SHA256',
  );
  const { qualificationRoot, ...originalSubject } = report;
  assert(
    qualificationRoot === cliQualificationRoot(originalSubject),
    'pre-signing qualification semantic root mismatch',
  );
  assert(
    signingResult?.contract ===
      'kungfu-buildchain-artifact-signing-result/v1' &&
      signingResult.verification?.status === 'passed',
    'Buildchain signing result did not pass',
  );
  assert(
    signingReceipt?.contract ===
      'kungfu-buildchain-artifact-signing-receipt/v1' &&
      signingReceipt.status === 'passed',
    'Buildchain signing receipt did not pass',
  );
  assert(
    signingResult.requestDigest === signingReceipt.requestDigest,
    'Buildchain signing result and receipt request digests differ',
  );
  assert(
    signingResult.source?.sha === expectedSourceCommit,
    `Buildchain signing result source mismatch: expected ${expectedSourceCommit}, got ${signingResult.source?.sha}`,
  );
  assert(
    signingResult.artifact?.digest === archiveSha256 &&
      signingReceipt.result?.artifactDigest === archiveSha256,
    'final archive SHA256 does not match the Buildchain signing result and receipt',
  );

  const rebound = structuredClone(report);
  rebound.identity.archiveSha256 = archiveSha256;
  Reflect.deleteProperty(rebound, 'qualificationRoot');
  rebound.qualificationRoot = cliQualificationRoot(rebound);
  verifyCliSurfaceQualification({
    report: rebound,
    expectedPlatform,
    archiveName,
    archiveSha256,
  });
  return rebound;
}

function parseArgs(argv) {
  const options = {};
  const known = new Set([
    '--qualification',
    '--archive',
    '--platform',
    '--signing-result',
    '--signing-receipt',
    '--source-commit',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (!known.has(arg)) throw new Error(`unknown option: ${arg}`);
    index += 1;
    if (index >= argv.length) throw new Error(`${arg} requires a value`);
    options[arg.slice(2)] = argv[index];
  }
  return options;
}

function readJson(file, label = 'qualification') {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label} ${file}: ${error.message}`);
  }
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o644,
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  for (const required of ['qualification', 'archive', 'platform']) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  const qualification = path.resolve(options.qualification);
  const archive = path.resolve(options.archive);
  const archiveSha256 = await sha256File(archive);
  if (options['signing-result'] || options['signing-receipt']) {
    for (const required of ['signing-result', 'signing-receipt']) {
      if (!options[required]) throw new Error(`--${required} is required`);
    }
    const sourceCommit =
      options['source-commit'] || process.env.BUILDCHAIN_SOURCE_SHA || '';
    const report = finalizeSignedCliQualification({
      report: readJson(qualification),
      expectedPlatform: options.platform,
      archiveName: path.basename(archive),
      archiveSha256,
      signingResult: readJson(
        path.resolve(options['signing-result']),
        'signing result',
      ),
      signingReceipt: readJson(
        path.resolve(options['signing-receipt']),
        'signing receipt',
      ),
      expectedSourceCommit: sourceCommit,
    });
    writeJsonAtomic(qualification, report);
    process.stdout.write(
      `${JSON.stringify({
        schema: 'kungfu.signed-cli-qualification-finalization/v1',
        finalized: true,
        platform: report.platform,
        sourceCommit: report.identity.sourceCommit,
        archive: report.identity.archive,
        archiveSha256: report.identity.archiveSha256,
        qualificationRoot: report.qualificationRoot,
      })}\n`,
    );
    return;
  }
  const verification = verifyCliSurfaceQualification({
    report: readJson(qualification),
    expectedPlatform: options.platform,
    archiveName: path.basename(archive),
    archiveSha256,
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
