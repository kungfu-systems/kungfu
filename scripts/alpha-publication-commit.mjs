#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  verifyInstallerPublicationBundle,
  writeInstallerPublicationBundle,
} from '../framework/site/installer-publication.mjs';
import {
  verifyReleaseChannelIndex,
  writeBootstrapInstallerPublication,
} from '../product/scripts/bootstrap-installer.mjs';
import {
  canonicalBytes,
  channelSpecFromAdmission,
  writeChannelIndex,
} from '../product/scripts/release-channel-index.mjs';
import {
  productReleaseChannelConfig,
  releaseChannelKeyId,
  releaseChannelTrust,
} from '../product/scripts/release-channel-trust.mjs';
import {
  findAlphaPublicationTailPlan,
  verifyAlphaPublicationTailPlan,
} from './alpha-publication-tail-plan.mjs';
import { verifyUpgradePublicationPayloads } from './upgrade-publication-admission.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRUST_PATH = path.join(ROOT, 'product', 'release-channel-trust.json');
const CHANNEL_URL = 'https://kungfu.tech/.well-known/kungfu/alpha.json';
const CANONICAL_BASE_URL = 'https://kungfu.tech';
const BUNDLE_MANIFEST_ASSET = 'kungfu-installer-publication-bundle.json';

function required(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function exactSha(value, label) {
  const normalized = required(value, label);
  if (!/^[a-f0-9]{40}$/.test(normalized)) {
    throw new Error(`${label} must be an exact Git SHA`);
  }
  return normalized;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(
      `failed to read ${label} at ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function run(command, args, { cwd = ROOT, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status ?? result.signal}): ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
  return result.stdout.trim();
}

export function signingIdentity(privateKeyPem) {
  const privateKey = createPrivateKey(required(privateKeyPem, 'signing key'));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('publication signing key must be Ed25519');
  }
  const publicKey = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64');
  return { keyId: releaseChannelKeyId(publicKey), publicKey };
}

export function publicationTimestamp(releasePassport) {
  const value =
    releasePassport?.surfaceTimestampPolicy?.publishedAt ||
    releasePassport?.release?.publishedAt;
  const normalized = required(value, 'release passport publication timestamp');
  const timestamp = new Date(normalized);
  if (Number.isNaN(timestamp.getTime()) || !normalized.endsWith('Z')) {
    throw new Error(
      'release passport publication timestamp must be RFC 3339 UTC',
    );
  }
  return timestamp;
}

function trustedKeyMap(trust) {
  return Object.fromEntries(
    trust.trustedKeys.map(({ keyId, publicKey }) => [keyId, publicKey]),
  );
}

export function publicationCommitEvidence({
  version,
  sourceSha,
  releaseSha,
  releaseTag,
  payloadRoot,
  previousPayloadRoot,
  bundle,
  readbackDigest,
}) {
  return {
    schema: 'kungfu-buildchain-publication-commit-evidence/v1',
    status: 'passed',
    identity: { version, sourceSha, releaseSha, releaseTag },
    publication: {
      url: `${bundle.distribution.releaseBaseUrl}/${bundle.distribution.manifestAsset}`,
      payloadRoot: bundle.bundleRoot,
      installerBundle: {
        schema: bundle.schema,
        bundleRoot: bundle.bundleRoot,
        manifestDigest: readbackDigest,
        sourceCommit: bundle.identity.sourceCommit,
        channel: bundle.identity.channel,
        channelPayloadRoot: payloadRoot,
        channelFileDigest: bundle.identity.channelFileDigest,
        releasePassport: bundle.identity.releasePassport,
        cachePolicy: bundle.cachePolicy,
        assets: bundle.assets,
      },
    },
    readback: {
      status: 'passed',
      url: `${bundle.distribution.releaseBaseUrl}/${bundle.distribution.manifestAsset}`,
      payloadRoot: bundle.bundleRoot,
      manifestDigest: readbackDigest,
    },
    recovery: {
      previousAuthority: previousPayloadRoot ? 'preserved' : 'none',
      rollbackReference: previousPayloadRoot || 'none:first-publication',
    },
    siteHandoff: {
      state: 'deferred-to-site-owned-consumer',
      productionAvailable: false,
      requiredBundleRoot: bundle.bundleRoot,
      authorityBoundary:
        'Kungfu publishes package assets; downstream sites independently pin, verify, project, and deploy them.',
    },
  };
}

export function prepareAlphaPublication({
  payloadDir,
  candidatePassportPath,
  releasePassportPath,
  version,
  sourceSha,
  privateKeyPem,
  trustDocument,
  outputDir,
  previousChannelIndex = null,
  now = new Date(),
}) {
  const trust = releaseChannelTrust(trustDocument, 'alpha');
  const identity = signingIdentity(privateKeyPem);
  if (
    identity.keyId !== trust.activeKeyId ||
    !trust.trustedKeys.some(
      (entry) =>
        entry.status === 'active' &&
        entry.keyId === identity.keyId &&
        entry.publicKey === identity.publicKey,
    )
  ) {
    throw new Error(
      'publication signing key does not match the committed active trust key',
    );
  }
  const admission = verifyUpgradePublicationPayloads({
    payloadRoot: payloadDir,
    releaseCandidatePassportPath: candidatePassportPath,
    expectedVersion: version,
  });
  const generatedAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + 30 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const spec = channelSpecFromAdmission({
    admission,
    releaseCandidatePassportPath: candidatePassportPath,
    releasePassportPath,
    releasePassportRef: `buildchain:release-passport/${sourceSha}`,
    channel: 'alpha',
    installSources: ['archive'],
    keyId: identity.keyId,
    generatedAt,
    expiresAt,
    previousChannelIndex,
  });
  if (spec.sourceCommit !== sourceSha) {
    throw new Error(
      'admitted release source does not match publication source',
    );
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const channelIndexPath = path.join(outputDir, 'alpha.json');
  const channelIndex = writeChannelIndex({
    spec,
    privateKeyPem,
    baseDirectory: ROOT,
    output: channelIndexPath,
  });
  const trustedKeysPath = path.join(outputDir, 'trusted-keys.json');
  fs.writeFileSync(
    trustedKeysPath,
    `${JSON.stringify(
      productReleaseChannelConfig(trustDocument, 'alpha').trustedKeys,
      null,
      2,
    )}\n`,
  );
  const publicationDir = path.join(outputDir, 'site-publication');
  const publication = writeBootstrapInstallerPublication({
    channelIndex: channelIndexPath,
    trustedKeys: trustedKeysPath,
    channel: 'alpha',
    channelUrl: CHANNEL_URL,
    canonicalBaseUrl: CANONICAL_BASE_URL,
    output: publicationDir,
  });
  return {
    admission,
    channelIndex,
    channelIndexPath,
    channelBytes: fs.readFileSync(channelIndexPath),
    trustedKeysPath,
    publication,
    publicationDir,
  };
}

async function fetchChannel(fetcher = fetch) {
  const response = await fetcher(CHANNEL_URL, {
    cache: 'no-store',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`canonical Alpha channel returned HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function previousAuthority(trustedKeys) {
  const bytes = await fetchChannel();
  if (!bytes) return null;
  const index = JSON.parse(bytes);
  verifyReleaseChannelIndex(index, trustedKeys);
  if (
    !bytes.equals(Buffer.concat([canonicalBytes(index), Buffer.from('\n')]))
  ) {
    throw new Error('previous canonical Alpha channel bytes are not canonical');
  }
  return { bytes, index };
}

function ghEnvironment(token) {
  return { ...process.env, GH_TOKEN: token };
}

function ensureLauncherTag({ token, releaseSha, version }) {
  const tag = `shifu-v${version}`;
  const env = ghEnvironment(token);
  const probe = spawnSync(
    'gh',
    [
      'api',
      `repos/kungfu-systems/kungfu/git/ref/tags/${tag}`,
      '--jq',
      '.object.sha',
    ],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (probe.status === 0) {
    if (probe.stdout.trim() !== releaseSha) {
      throw new Error(`${tag} already points to a different release SHA`);
    }
    return tag;
  }
  run(
    'gh',
    [
      'api',
      '--method',
      'POST',
      'repos/kungfu-systems/kungfu/git/refs',
      '-f',
      `ref=refs/tags/${tag}`,
      '-f',
      `sha=${releaseSha}`,
    ],
    { env },
  );
  return tag;
}

function releaseAssetInputs(bundleRoot, bundle, stagingRoot) {
  const sources = new Map();
  for (const asset of bundle.assets) {
    const file = path.join(bundleRoot, asset.path);
    const current = sources.get(asset.releaseAsset);
    if (current && !fs.readFileSync(current).equals(fs.readFileSync(file))) {
      throw new Error(
        `release asset name maps to different bytes: ${asset.releaseAsset}`,
      );
    }
    sources.set(asset.releaseAsset, file);
  }
  sources.set(BUNDLE_MANIFEST_ASSET, path.join(bundleRoot, 'bundle.json'));
  const staged = new Map();
  for (const [name, source] of sources) {
    const destination = path.join(stagingRoot, name);
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    staged.set(name, destination);
  }
  return staged;
}

function publishReleaseAssets({ token, releaseTag, bundleRoot, bundle }) {
  const env = ghEnvironment(token);
  const existing = JSON.parse(
    run(
      'gh',
      [
        'release',
        'view',
        releaseTag,
        '--repo',
        'kungfu-systems/kungfu',
        '--json',
        'assets',
      ],
      { env },
    ),
  );
  const names = new Set(existing.assets.map((asset) => asset.name));
  const stagingRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-installer-release-assets-'),
  );
  try {
    for (const [name, file] of releaseAssetInputs(
      bundleRoot,
      bundle,
      stagingRoot,
    )) {
      if (names.has(name)) {
        throw new Error(
          `installer publication release asset already exists: ${name}`,
        );
      }
      run(
        'gh',
        [
          'release',
          'upload',
          releaseTag,
          file,
          '--repo',
          'kungfu-systems/kungfu',
        ],
        { env },
      );
    }
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

async function waitForBundleReadback(
  bundle,
  {
    timeoutMs = Number(
      process.env.KUNGFU_PUBLICATION_READBACK_TIMEOUT_MS || 30 * 60 * 1000,
    ),
    intervalMs = Number(
      process.env.KUNGFU_PUBLICATION_READBACK_INTERVAL_MS || 15_000,
    ),
  } = {},
) {
  const url = `${bundle.distribution.releaseBaseUrl}/${bundle.distribution.manifestAsset}`;
  const expected = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`);
  const deadline = Date.now() + timeoutMs;
  let last = 'not observed';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const bytes = Buffer.from(await response.arrayBuffer());
        const observed = JSON.parse(bytes);
        if (
          observed.bundleRoot === bundle.bundleRoot &&
          bytes.equals(expected)
        ) {
          return { bytes, digest: sha256(bytes), url };
        }
        last = 'bundle root or manifest bytes differ';
      } else {
        last = `HTTP ${response.status}`;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`installer bundle read-back timed out; last state: ${last}`);
}

async function main() {
  const environment = {
    version: required(
      process.env.BUILDCHAIN_PUBLICATION_COMMIT_VERSION,
      'BUILDCHAIN_PUBLICATION_COMMIT_VERSION',
    ),
    sourceSha: exactSha(
      process.env.BUILDCHAIN_PUBLICATION_COMMIT_SOURCE_SHA,
      'BUILDCHAIN_PUBLICATION_COMMIT_SOURCE_SHA',
    ),
    releaseSha: exactSha(
      process.env.BUILDCHAIN_PUBLICATION_COMMIT_RELEASE_SHA,
      'BUILDCHAIN_PUBLICATION_COMMIT_RELEASE_SHA',
    ),
    releaseTag: required(
      process.env.BUILDCHAIN_PUBLICATION_COMMIT_RELEASE_TAG,
      'BUILDCHAIN_PUBLICATION_COMMIT_RELEASE_TAG',
    ),
    releasePassportPath: path.resolve(
      required(
        process.env.BUILDCHAIN_PUBLICATION_COMMIT_RELEASE_PASSPORT,
        'BUILDCHAIN_PUBLICATION_COMMIT_RELEASE_PASSPORT',
      ),
    ),
    payloadDir: path.resolve(
      required(
        process.env.BUILDCHAIN_PUBLICATION_COMMIT_PAYLOAD_DIR,
        'BUILDCHAIN_PUBLICATION_COMMIT_PAYLOAD_DIR',
      ),
    ),
    evidencePath: path.resolve(
      required(
        process.env.BUILDCHAIN_PUBLICATION_COMMIT_EVIDENCE,
        'BUILDCHAIN_PUBLICATION_COMMIT_EVIDENCE',
      ),
    ),
    token: required(
      process.env.BUILDCHAIN_PUBLICATION_COMMIT_TOKEN,
      'BUILDCHAIN_PUBLICATION_COMMIT_TOKEN',
    ),
    privateKeyPem: required(
      process.env.BUILDCHAIN_PUBLICATION_COMMIT_SIGNING_KEY,
      'BUILDCHAIN_PUBLICATION_COMMIT_SIGNING_KEY',
    ),
  };
  if (environment.releaseTag !== `v${environment.version}`) {
    throw new Error('publication version and public release tag disagree');
  }
  const tailPlanPath = findAlphaPublicationTailPlan(environment.payloadDir);
  verifyAlphaPublicationTailPlan({
    plan: readJson(tailPlanPath, 'Alpha publication tail plan'),
    expectedSourceCommit: environment.sourceSha,
    expectedVersion: environment.version,
  });
  const trustDocument = readJson(TRUST_PATH, 'release-channel trust');
  const trust = releaseChannelTrust(trustDocument, 'alpha');
  const previous = await previousAuthority(trustedKeyMap(trust));
  const candidatePassportPath = path.join(
    path.dirname(environment.payloadDir),
    'passport',
    'release-candidate-passport.json',
  );
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-alpha-publication-'),
  );
  const prepared = prepareAlphaPublication({
    ...environment,
    candidatePassportPath,
    trustDocument,
    previousChannelIndex: previous?.index || null,
    outputDir: path.join(temporaryRoot, 'prepared'),
    now: publicationTimestamp(
      readJson(environment.releasePassportPath, 'final release passport'),
    ),
  });
  ensureLauncherTag(environment);
  const packageMetadata = readJson(
    path.join(ROOT, 'framework', 'site', 'package.json'),
    '@kungfu-tech/site package metadata',
  );
  const bundleRoot = path.join(temporaryRoot, 'installer-publication-bundle');
  const bundle = writeInstallerPublicationBundle({
    publicationRoot: prepared.publicationDir,
    channelIndexPath: prepared.channelIndexPath,
    trustedKeysPath: prepared.trustedKeysPath,
    outputRoot: bundleRoot,
    packageVersion: packageMetadata.version,
    releaseSha: environment.releaseSha,
    releaseTag: environment.releaseTag,
  });
  verifyInstallerPublicationBundle({
    bundleRoot,
    expectedBundleRoot: bundle.bundleRoot,
  });
  publishReleaseAssets({ ...environment, bundleRoot, bundle });
  const readback = await waitForBundleReadback(bundle);
  const evidence = publicationCommitEvidence({
    ...environment,
    payloadRoot: prepared.channelIndex.payloadRoot,
    previousPayloadRoot: previous?.index.payloadRoot,
    bundle,
    readbackDigest: readback.digest,
  });
  fs.mkdirSync(path.dirname(environment.evidencePath), {
    recursive: true,
  });
  fs.writeFileSync(
    environment.evidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(
    `${JSON.stringify({
      status: 'passed',
      channelPayloadRoot: prepared.channelIndex.payloadRoot,
      installerBundleRoot: bundle.bundleRoot,
      installerBundleUrl: evidence.publication.url,
      siteHandoff: evidence.siteHandoff.state,
    })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `alpha-publication-commit: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
