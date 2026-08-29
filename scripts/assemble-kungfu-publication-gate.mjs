#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { executeGateRun } from './shifu-gate-executor.mjs';
import { gateDigest } from './shifu-gate-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = 'release-promotion';
const REQUIRED_PLATFORMS = [
  'linux-x64',
  'linux-arm64',
  'macos-arm64',
  'windows-x64',
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function filesNamed(root, name) {
  const matches = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === name) matches.push(full);
    }
  }
  return matches.sort();
}

function oneJson(root, name) {
  const matches = filesNamed(root, name);
  if (matches.length !== 1)
    throw new Error(
      `expected exactly one ${name} under ${root}, found ${matches.length}`,
    );
  return readJson(matches[0]);
}

function sha256File(file) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
}

function payloadFor(evidenceRoot, manifest) {
  const artifactRoot = path.join(
    evidenceRoot,
    'payloads',
    String(manifest.artifactName || ''),
  );
  if (!fs.existsSync(artifactRoot))
    throw new Error(
      `candidate payload artifact is missing: ${manifest.artifactName}`,
    );
  return {
    artifactName: manifest.artifactName,
    files: (manifest.files || [])
      .filter((entry) => !String(entry.path || '').startsWith('.buildchain/'))
      .map((entry) => {
        const relative = String(entry.path || '');
        if (
          path.isAbsolute(relative) ||
          relative.includes('\\') ||
          relative.split('/').includes('..')
        )
          throw new Error(
            `candidate payload manifest contains an unsafe path: ${relative}`,
          );
        const file = path.join(artifactRoot, relative);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile())
          throw new Error(
            `candidate payload file is missing: ${manifest.artifactName}/${relative}`,
          );
        return {
          path: relative,
          size: fs.statSync(file).size,
          sha256: sha256File(file),
        };
      }),
  };
}

function exactPlatformSet(platforms, label) {
  const actual = [...new Set(platforms.map(String))].sort();
  const expected = [...REQUIRED_PLATFORMS].sort();
  if (actual.join('\0') !== expected.join('\0'))
    throw new Error(
      `${label} must contain exactly ${REQUIRED_PLATFORMS.join(', ')}`,
    );
}

function requireMacCredentialEvidence(manifest) {
  const paths = new Set((manifest.files || []).map((entry) => entry.path));
  const requiredKinds = [
    [
      'credential-island evidence',
      /product\/release\/credential-island-evidence\.json$/,
    ],
    ['signed DMG', /product\/release\/[^/]+\.dmg$/],
    ['signed ZIP', /product\/release\/[^/]+\.zip$/],
    [
      'signing result',
      /^\.buildchain\/artifacts\/signing\/macos-arm64\/.+\/result\.json$/,
    ],
  ];
  for (const [label, pattern] of requiredKinds)
    if (![...paths].some((value) => pattern.test(value)))
      throw new Error(`macOS manifest is missing ${label}`);
}

function requireEvidenceArtifact(evidenceRoot, prefix, sourceSha) {
  const root = path.join(evidenceRoot, 'payloads');
  const expected = `${prefix}${sourceSha}`;
  const matches = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name === expected);
  if (matches.length !== 1)
    throw new Error(
      `release-candidate evidence artifact is missing: ${expected}`,
    );
}

export function createKungfuPublicationGateAggregate({
  sourceSha,
  registry,
  gateReceipt,
  manifestSet,
  publicationAuthorityDigest,
  sha256Json,
}) {
  if (
    !gateReceipt?.ok ||
    !gateReceipt?.qualifying ||
    gateReceipt.status !== 'pass'
  )
    throw new Error('release-promotion Gate receipt is not qualifying');
  exactPlatformSet(
    manifestSet.artifacts.map((artifact) => artifact.platformId),
    'artifact manifest set',
  );
  const registryDigest = gateDigest(registry);
  const matrixDigest = publicationAuthorityDigest({
    profile: PROFILE,
    registryDigest,
    requiredPlatforms: REQUIRED_PLATFORMS,
  });
  const artifacts = new Map(
    manifestSet.artifacts.map((artifact) => [artifact.platformId, artifact]),
  );
  const payload = {
    contract: 'buildchain.shifu-gate-aggregate/v1',
    profile: PROFILE,
    sourceSha,
    registry: {
      ref: 'shifu.gates.json',
      digest: registryDigest,
      projectId: registry.project?.id || 'kungfu',
    },
    matrixDigest,
    status: 'pass',
    ok: true,
    qualifying: true,
    receipts: REQUIRED_PLATFORMS.map((platformId) => {
      const artifact = artifacts.get(platformId);
      return {
        platformId,
        platform: { id: platformId, os: platformId.split('-')[0] },
        status: 'passed',
        qualifying: true,
        issues: [],
        evidence: {
          manifestDigest: artifact.manifestDigest,
          contentDigest: artifact.contentDigest,
          productPayloadDigest: artifact.productPayloadDigest,
        },
      };
    }),
    gates: gateReceipt.results.map((row) => ({
      platformId: 'linux-promotion-controller',
      gateId: row.gateId,
      mode: row.policyMode,
      status: row.status,
      attempted: row.attempted,
      definitionDigest: row.definitionDigest,
      actionId: row.actionId,
      issues: row.reason ? [row.reason] : [],
    })),
    omitted: [],
    issues: [],
  };
  return { ...payload, digest: `sha256:${sha256Json(payload)}` };
}

export async function assembleKungfuPublicationGate({
  root = ROOT,
  subjectRoot = root,
  evidenceRoot,
  runtimeRoot,
  sourceSha,
  targetRef,
  outputPath,
}) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha))
    throw new Error(
      'BUILDCHAIN_PUBLICATION_SOURCE_SHA must be an exact commit SHA',
    );
  if (!/^(alpha|release)\/v[0-9]+\/v[0-9]+\.[0-9]+$/.test(targetRef))
    throw new Error(
      'BUILDCHAIN_PUBLICATION_TARGET_REF must be an Alpha or release channel',
    );
  for (const directory of [evidenceRoot, runtimeRoot])
    if (
      !directory ||
      !fs.existsSync(directory) ||
      !fs.statSync(directory).isDirectory()
    )
      throw new Error(
        `required directory is unavailable: ${directory || '<empty>'}`,
      );

  const authority = await import(
    pathToFileURL(
      path.join(runtimeRoot, 'packages/core/publication-authority.js'),
    ).href
  );
  const candidate = await import(
    pathToFileURL(path.join(runtimeRoot, 'packages/core/release-candidate.js'))
      .href
  );
  const controllers = await import(
    pathToFileURL(
      path.join(runtimeRoot, 'packages/core/controller-evidence.js'),
    ).href
  );

  const passport = oneJson(
    path.join(evidenceRoot, 'passport'),
    'release-candidate-passport.json',
  );
  const buildSummary = oneJson(
    path.join(evidenceRoot, 'summary'),
    'build-summary.json',
  );
  const controllerReceipt = oneJson(
    path.join(evidenceRoot, 'controller'),
    'release-candidate-receipt.json',
  );
  const manifests = filesNamed(
    path.join(evidenceRoot, 'manifests'),
    'manifest.json',
  ).map(readJson);
  exactPlatformSet(
    passport.platformMatrix.map((platform) => platform.platformId),
    'release-candidate passport',
  );
  exactPlatformSet(
    manifests.map((manifest) => manifest.platform?.id),
    'downloaded manifests',
  );

  const passportValidation = candidate.validateReleaseCandidatePassport({
    passport,
    repository: 'kungfu-systems/kungfu',
    targetChannel: targetRef,
    sourceHeadSha: sourceSha,
    buildSummary,
  });
  if (!passportValidation.ok)
    throw new Error(
      `release-candidate passport is invalid: ${passportValidation.errors.join('; ')}`,
    );
  const promotionTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: subjectRoot,
    encoding: 'utf8',
  }).trim();
  if (passport.source?.treeHash !== promotionTree)
    throw new Error(
      'promotion source tree does not match the release candidate',
    );

  const controllerValidation = controllers.validateControllerReceipt(
    controllerReceipt,
    {
      expectedSourceSha: passport.source.headSha,
      expectedRuntimeSha: passport.buildchain.sha,
    },
  );
  if (!controllerValidation.qualifying)
    throw new Error(
      `release-candidate controller is not qualifying: ${controllerValidation.issues.join('; ')}`,
    );
  const controllerReference = passport.controllerReceipts?.[0];
  if (
    passport.controllerReceipts?.length !== 1 ||
    controllerReference.receiptDigest !== controllerReceipt.digest ||
    controllerReference.planDigest !== controllerReceipt.planDigest
  )
    throw new Error('release-candidate controller receipt reference mismatch');

  const payloads = manifests.map((manifest) =>
    payloadFor(evidenceRoot, manifest),
  );
  const manifestSet = authority.createPublicationArtifactManifestSet({
    repository: passport.repository,
    sourceSha: passport.source.headSha,
    sourceTreeSha: passport.source.treeHash,
    manifests,
    payloads,
  });
  const macManifest = manifests.find(
    (manifest) => manifest.platform?.id === 'macos-arm64',
  );
  if (!macManifest)
    throw new Error('downloaded manifests are missing macos-arm64');
  requireMacCredentialEvidence(macManifest);
  requireEvidenceArtifact(
    evidenceRoot,
    'kungfu-macos-credential-',
    passport.source.headSha,
  );
  requireEvidenceArtifact(
    evidenceRoot,
    'kungfu-credential-manifest-macos-',
    passport.source.headSha,
  );
  requireEvidenceArtifact(
    evidenceRoot,
    'kungfu-attestation-policy-linux-x64-',
    passport.source.headSha,
  );

  const registry = readJson(path.join(root, 'shifu.gates.json'));
  const subjectRegistry = readJson(path.join(subjectRoot, 'shifu.gates.json'));
  if (gateDigest(registry) !== gateDigest(subjectRegistry))
    throw new Error(
      'consumer Gate controller registry does not match the publication subject',
    );
  const validationFiles = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-buildchain-config-'),
  );
  const validateBuildchainConfig = () => {
    const output = path.join(validationFiles, 'output');
    const summary = path.join(validationFiles, 'summary');
    fs.writeFileSync(output, '');
    fs.writeFileSync(summary, '');
    const result = spawnSync(
      process.execPath,
      [path.join(runtimeRoot, 'actions/validate-config/dist/index.js')],
      {
        cwd: subjectRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          'INPUT_CONFIG-REQUIRED': 'true',
          'INPUT_REQUIRE-VERSION-STATE': 'true',
          'INPUT_REQUIRE-LIFECYCLE-STAGES': 'install,check,build,verify',
        },
      },
    );
    if (result.status !== 0)
      throw new Error(
        `Buildchain config validation failed: ${(result.stderr || result.stdout || '').trim()}`,
      );
  };

  try {
    const gateReceipt = await executeGateRun(registry, {
      root,
      registryRef: 'shifu.gates.json',
      registryDigest: gateDigest(registry),
      profile: PROFILE,
      platform: 'linux',
      capabilities: [
        'buildchain-cli',
        'buildchain-release',
        'publication-evidence',
      ],
      source: { sha: sourceSha, dirty: false },
      handlers: {
        'kungfu.workflow.buildchain-config': async () => {
          validateBuildchainConfig();
          return { status: 'pass', exitCode: 0 };
        },
        'kungfu.buildchain.artifact-admission': async () => ({
          status: 'pass',
          exitCode: 0,
        }),
      },
      writer: process.stderr,
    });
    const aggregate = createKungfuPublicationGateAggregate({
      sourceSha,
      registry,
      gateReceipt,
      manifestSet,
      publicationAuthorityDigest: authority.publicationAuthorityDigest,
      sha256Json: candidate.sha256Json,
    });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(aggregate, null, 2)}\n`);
    return aggregate;
  } finally {
    fs.rmSync(validationFiles, { recursive: true, force: true });
  }
}

async function main() {
  const aggregate = await assembleKungfuPublicationGate({
    subjectRoot: path.resolve(
      process.env.BUILDCHAIN_PUBLICATION_SUBJECT_ROOT || ROOT,
    ),
    evidenceRoot: process.env.BUILDCHAIN_PUBLICATION_EVIDENCE_ROOT,
    runtimeRoot: process.env.BUILDCHAIN_PUBLICATION_AUTHORITY_RUNTIME_ROOT,
    sourceSha: process.env.BUILDCHAIN_PUBLICATION_SOURCE_SHA,
    targetRef: process.env.BUILDCHAIN_PUBLICATION_TARGET_REF,
    outputPath: process.env.BUILDCHAIN_PUBLICATION_GATE_RESULT_PATH,
  });
  process.stdout.write(
    `${JSON.stringify({ status: aggregate.status, qualifying: aggregate.qualifying, digest: aggregate.digest })}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `[assemble-kungfu-publication-gate] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
