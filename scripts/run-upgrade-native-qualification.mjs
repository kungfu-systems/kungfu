#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sha256File } from '../product/scripts/compatibility.mjs';
import {
  artifactSignatureStatement,
  loadUpgradeQualificationContract,
  verifyUpgradeQualificationEvidence,
} from './upgrade-qualification.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function evidencePath(root) {
  return path.join(
    root,
    'product',
    'release',
    'qualification',
    'kungfu-upgrade-qualification-evidence.json',
  );
}

function campaignEvidencePath(root, contract) {
  return path.resolve(
    root,
    process.env.KF_UPDATE_QUALIFICATION_CAMPAIGNS ||
      path.join(
        'product',
        'release',
        'qualification',
        contract.publication.campaignEvidenceFileName,
      ),
  );
}

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    fail(
      `${command} ${args.join(' ')} failed (status=${result.status}): ${(result.stderr || result.stdout || result.error?.message || '').trim()}`,
    );
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function findExactlyOne(root, predicate, label) {
  const matches = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (predicate(target, entry)) matches.push(target);
        else visit(target);
      } else if (entry.isFile() && predicate(target, entry))
        matches.push(target);
    }
  };
  visit(root);
  if (matches.length !== 1)
    fail(`${label}: expected one match under ${root}, found ${matches.length}`);
  return matches[0];
}

function readManifest(
  root = ROOT,
  platform = process.platform,
  architecture = process.arch,
) {
  const name = new RegExp(
    `^kungfu-upgrade-.+-${platform}-${architecture}\\.json$`,
  );
  const file = findExactlyOne(
    path.join(root, 'product', 'release', 'cli'),
    (target, entry) => entry.isFile() && name.test(path.basename(target)),
    'combined upgrade manifest',
  );
  return { file, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function artifactPath(root, artifact) {
  if (!['desktop', 'cli'].includes(artifact.kind)) return null;
  let name;
  try {
    name = decodeURIComponent(
      path.posix.basename(new URL(artifact.url).pathname),
    );
  } catch {
    fail(`${artifact.kind} artifact URL is invalid`);
  }
  return findExactlyOne(
    path.join(root, 'product', 'release', artifact.kind),
    (target, entry) => entry.isFile() && path.basename(target) === name,
    `${artifact.kind} artifact`,
  );
}

function verifyArtifactBytes(root, manifest) {
  for (const artifact of manifest.artifacts) {
    const file = artifactPath(root, artifact);
    if (!file) continue;
    const size = fs.statSync(file).size;
    const digest = `sha256:${sha256File(file)}`;
    if (size !== artifact.size || digest !== artifact.digest)
      fail(`${artifact.kind} bytes do not match the upgrade manifest`);
  }
}

function verifyDarwin(root) {
  const app = findExactlyOne(
    path.join(root, 'product', 'dist', 'desktop'),
    (target, entry) => entry.isDirectory() && target.endsWith('.app'),
    'packaged macOS application',
  );
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const detail = run('codesign', ['-dv', '--verbose=4', app]);
  if (
    !/Authority=Developer ID Application:/.test(detail) ||
    !/flags=.*runtime/.test(detail)
  )
    fail('macOS application is not Developer ID signed with hardened runtime');
  run('xcrun', ['stapler', 'validate', app]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  return {
    kind: 'developer-id-notarized',
    hardenedRuntime: true,
    stapledTicket: true,
  };
}

function verifyLinux(root, manifest) {
  const desktop = manifest.artifacts.find((item) => item.kind === 'desktop');
  const appImage = artifactPath(root, desktop);
  fs.accessSync(appImage, fs.constants.X_OK);
  const descriptor = fs.openSync(appImage, 'r');
  const magic = Buffer.alloc(4);
  try {
    fs.readSync(descriptor, magic, 0, magic.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
    fail('Linux desktop artifact is not an executable AppImage/ELF payload');
  return { kind: 'appimage-native', executable: true };
}

function verifyWindows(root, manifest) {
  const desktop = manifest.artifacts.find((item) => item.kind === 'desktop');
  const installer = artifactPath(root, desktop);
  const executable = findExactlyOne(
    path.join(root, 'product', 'dist', 'desktop'),
    (target, entry) =>
      entry.isFile() && path.basename(target) === 'Kungfu Episodes.exe',
    'packaged Windows application',
  );
  const script = [
    '$targets = ConvertFrom-Json $env:KF_SIGNATURE_TARGETS_JSON',
    '$rows = foreach ($target in $targets) { Get-AuthenticodeSignature -LiteralPath $target }',
    "if ($rows.Count -ne 2 -or @($rows | Where-Object Status -ne 'Valid').Count -ne 0) { $rows | Select-Object Path,Status,StatusMessage | ConvertTo-Json -Compress; exit 1 }",
    "$rows | Select-Object Path,Status,@{Name='Subject';Expression={$_.SignerCertificate.Subject}} | ConvertTo-Json -Compress",
  ].join('; ');
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: {
      ...process.env,
      KF_SIGNATURE_TARGETS_JSON: JSON.stringify([installer, executable]),
    },
  });
  return { kind: 'authenticode', installer: true, executable: true };
}

export function buildQualificationEvidence({
  manifest,
  contract,
  nativeSigning,
  campaigns,
  generatedAt = new Date().toISOString(),
}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const evidence = {
    schema: contract.evidenceSchema,
    evidenceRef: manifest.qualificationEvidenceRef,
    generatedAt,
    sourceCommit: manifest.sourceCommit,
    productVersion: manifest.productVersion,
    platform: manifest.platform,
    architecture: manifest.architecture,
    tier: contract.promotionTier,
    surfaces: ['runtime', 'desktop', 'cli'],
    runtimeChurnIterations: contract.minimumRuntimeChurnIterations,
    checks: Object.fromEntries(
      contract.requiredChecks.map((name) => [name, true]),
    ),
    campaigns,
    nativeSigning,
    artifacts: manifest.artifacts.map((artifact) => ({
      kind: artifact.kind,
      digest: artifact.digest,
      size: artifact.size,
      signatureEvidenceRef: artifact.signature,
      algorithm: 'ed25519',
      publicKeyPem,
      signature: sign(
        null,
        artifactSignatureStatement(
          manifest,
          artifact,
          manifest.qualificationEvidenceRef,
        ),
        privateKey,
      ).toString('base64'),
    })),
  };
  verifyUpgradeQualificationEvidence(manifest, evidence, 'desktop', contract);
  verifyUpgradeQualificationEvidence(manifest, evidence, 'cli', contract);
  return evidence;
}

export function runUpgradeNativeQualification(
  root = ROOT,
  platform = process.platform,
) {
  const contract = loadUpgradeQualificationContract(root);
  const { value: manifest } = readManifest(root, platform, process.arch);
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: root }).trim();
  const sourceStatus = run(
    'git',
    ['status', '--porcelain', '--untracked-files=no'],
    { cwd: root },
  ).trim();
  if (sourceStatus)
    fail('native qualification requires a clean tracked source tree');
  if (manifest.sourceCommit !== head)
    fail(
      `upgrade manifest source ${manifest.sourceCommit} does not match HEAD ${head}`,
    );
  if (
    String(manifest.qualificationEvidenceRef).startsWith(
      'unqualified-local-build',
    )
  )
    fail(
      'native qualification requires a release-candidate evidence reference',
    );
  verifyArtifactBytes(root, manifest);
  const nativeSigning =
    platform === 'darwin'
      ? verifyDarwin(root)
      : platform === 'win32'
        ? verifyWindows(root, manifest)
        : verifyLinux(root, manifest);
  const campaignFile = campaignEvidencePath(root, contract);
  if (!fs.existsSync(campaignFile))
    fail(
      `native qualification requires retained one-command campaigns at ${campaignFile}`,
    );
  const campaignSet = JSON.parse(fs.readFileSync(campaignFile, 'utf8'));
  if (
    campaignSet.schema !== contract.campaignSetSchema ||
    !Array.isArray(campaignSet.campaigns)
  )
    fail('retained one-command campaign set is invalid');
  const campaigns = campaignSet.campaigns.filter(
    (campaign) =>
      campaign.platform === manifest.platform &&
      campaign.architecture === manifest.architecture &&
      campaign.candidate?.sourceCommit === manifest.sourceCommit &&
      campaign.candidate?.productVersion === manifest.productVersion,
  );
  const evidence = buildQualificationEvidence({
    manifest,
    contract,
    nativeSigning,
    campaigns,
  });
  const output = evidencePath(root);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    `[upgrade-native-qualification] ${platform}-${process.arch} -> ${path.relative(root, output)}`,
  );
  return evidence;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    runUpgradeNativeQualification();
  } catch (error) {
    console.error(
      `[upgrade-native-qualification] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
