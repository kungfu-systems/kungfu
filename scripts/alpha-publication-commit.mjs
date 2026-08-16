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
import { bindProductReleaseCut } from '../product/scripts/upgrade-manifest.mjs';
import {
  findAlphaPublicationTailPlan,
  verifyAlphaPublicationTailPlan,
} from './alpha-publication-tail-plan.mjs';
import { applyProductReleaseMetadata } from './github-release-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT_ROOT = process.env.BUILDCHAIN_PUBLICATION_COMMIT_PRODUCT_ROOT
  ? path.resolve(process.env.BUILDCHAIN_PUBLICATION_COMMIT_PRODUCT_ROOT)
  : ROOT;
const TRUST_PATH = path.join(
  PRODUCT_ROOT,
  'product',
  'release-channel-trust.json',
);
const CHANNEL_URL = 'https://kungfu.tech/.well-known/kungfu/alpha.json';
const CANONICAL_BASE_URL = 'https://kungfu.tech';
const BUNDLE_MANIFEST_ASSET = 'kungfu-installer-publication-bundle.json';
const RELEASE_MANIFEST_SCHEMA = 'kungfu.product-upgrade.manifest/v1';
const EXPECTED_RELEASE_MANIFESTS = ['darwin-arm64', 'linux-x64', 'win32-x64'];

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

function releaseCandidateSourceShas(candidatePassportPath) {
  const passport = readJson(
    candidatePassportPath,
    'release-candidate passport',
  );
  const sources = [
    passport.source?.headSha,
    passport.source?.mergeRefSha,
    passport.source?.builtSourceSha,
  ].filter((value) => /^[a-f0-9]{40}$/u.test(value || ''));
  if (sources.length === 0) {
    throw new Error('release-candidate passport has no exact source identity');
  }
  return [...new Set(sources)].sort();
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

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function publicationManifestFiles(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`release-candidate payload root is missing: ${root}`);
  }
  const matches = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (
        entry.isFile() &&
        /^kungfu-upgrade-.+-(darwin|linux|win32)-(arm64|x64)\.json$/u.test(
          entry.name,
        )
      ) {
        matches.push(file);
      }
    }
  };
  visit(root);
  return matches.sort((left, right) => left.localeCompare(right));
}

export function publicationManifestSet({
  payloadRoot,
  candidatePassportPath,
  version,
  sourceSha,
}) {
  const acceptedSources = new Set(
    releaseCandidateSourceShas(candidatePassportPath),
  );
  if (!acceptedSources.has(sourceSha)) {
    throw new Error('publication source is outside the sealed candidate');
  }
  const byIdentity = new Map();
  for (const manifestPath of publicationManifestFiles(payloadRoot)) {
    const manifest = readJson(manifestPath, 'release publication manifest');
    if (manifest.schema !== RELEASE_MANIFEST_SCHEMA) continue;
    const identity = `${manifest.platform}-${manifest.architecture}`;
    const copies = byIdentity.get(identity) || [];
    copies.push({ manifestPath, manifest });
    byIdentity.set(identity, copies);
  }
  const identities = [...byIdentity.keys()].sort();
  if (
    identities.join('\0') !== [...EXPECTED_RELEASE_MANIFESTS].sort().join('\0')
  ) {
    throw new Error(
      `release publication manifests must contain exactly ${EXPECTED_RELEASE_MANIFESTS.join(', ')}; found ${identities.join(', ') || '<none>'}`,
    );
  }
  const manifests = [];
  for (const identity of identities) {
    const copies = byIdentity.get(identity);
    const expected = JSON.stringify(canonical(copies[0].manifest));
    if (
      copies.some(
        ({ manifest }) => JSON.stringify(canonical(manifest)) !== expected,
      )
    ) {
      throw new Error(
        `release publication manifest copies drifted: ${identity}`,
      );
    }
    const { manifest, manifestPath } = copies[0];
    if (manifest.productVersion !== version) {
      throw new Error(
        `release publication manifest version drifted: ${identity}`,
      );
    }
    if (!acceptedSources.has(manifest.sourceCommit)) {
      throw new Error(
        `release publication manifest source is outside the sealed candidate: ${identity}`,
      );
    }
    if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
      throw new Error(
        `release publication manifest has no artifacts: ${identity}`,
      );
    }
    for (const artifact of manifest.artifacts) {
      if (
        typeof artifact.url !== 'string' ||
        !Number.isSafeInteger(artifact.size) ||
        artifact.size < 0 ||
        !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest || '')
      ) {
        throw new Error(
          `release publication manifest has an invalid artifact: ${identity}`,
        );
      }
    }
    manifests.push({
      platform: manifest.platform,
      architecture: manifest.architecture,
      manifestPath,
      manifest,
    });
  }
  return { manifests };
}

function releaseBaseUrl(releaseTag) {
  return `https://github.com/kungfu-systems/kungfu/releases/download/${releaseTag}`;
}

function releaseArtifactName(url, releaseTag) {
  const prefix = `${releaseBaseUrl(releaseTag)}/`;
  if (typeof url !== 'string' || !url.startsWith(prefix)) return null;
  const relative = url.slice(prefix.length);
  if (!relative || relative.includes('/')) {
    throw new Error(`release artifact URL is not an exact asset name: ${url}`);
  }
  return decodeURIComponent(relative);
}

export function publicationArtifactDrift({
  channelIndex,
  releaseAssets,
  releaseTag,
}) {
  const assetsByName = new Map(
    (releaseAssets || []).map((asset) => [asset.name, asset]),
  );
  const drift = [];
  for (const entry of channelIndex?.entries || []) {
    for (const artifact of entry.manifest?.artifacts || []) {
      const name = releaseArtifactName(artifact.url, releaseTag);
      if (!name) continue;
      const asset = assetsByName.get(name);
      if (
        !asset ||
        asset.state !== 'uploaded' ||
        asset.size !== artifact.size ||
        asset.digest !== artifact.digest
      ) {
        drift.push({
          platform: entry.platform,
          architecture: entry.architecture,
          kind: artifact.kind,
          name,
          expectedSize: artifact.size,
          expectedDigest: artifact.digest,
          observedSize: asset?.size || null,
          observedDigest: asset?.digest || null,
        });
      }
    }
  }
  return drift;
}

export function bindPublicationReleaseAssets({
  admission,
  releaseAssets,
  releaseTag,
}) {
  const candidates = (releaseAssets || []).filter(
    (asset) => asset?.state === 'uploaded',
  );
  return {
    ...admission,
    manifests: admission.manifests.map((entry) => ({
      ...entry,
      manifest: {
        ...entry.manifest,
        artifacts: entry.manifest.artifacts.map((artifact) => {
          if (!releaseArtifactName(artifact.url, releaseTag)) return artifact;
          const matches = candidates.filter(
            (asset) =>
              asset.size === artifact.size && asset.digest === artifact.digest,
          );
          if (matches.length !== 1) {
            throw new Error(
              `release artifact bytes do not resolve to one uploaded asset: ${entry.platform}/${entry.architecture}/${artifact.kind}`,
            );
          }
          return {
            ...artifact,
            url: `${releaseBaseUrl(releaseTag)}/${encodeURIComponent(matches[0].name)}`,
          };
        }),
      },
    })),
  };
}

function bundleAssetDestination(bundleRoot, relativePath) {
  const root = path.resolve(bundleRoot);
  const destination = path.resolve(root, relativePath);
  if (
    typeof relativePath !== 'string' ||
    relativePath === '' ||
    !destination.startsWith(`${root}${path.sep}`)
  ) {
    throw new Error('existing installer publication asset path is unsafe');
  }
  return destination;
}

function run(command, args, { cwd = PRODUCT_ROOT, env = process.env } = {}) {
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

export function validateExistingPublicationIdentity({
  bundle,
  version,
  candidateSourceSha,
  acceptedSourceShas = [candidateSourceSha],
  releaseSha,
  releaseTag,
}) {
  if (
    bundle?.identity?.channel !== 'alpha' ||
    bundle.identity.version !== version ||
    !acceptedSourceShas.includes(bundle.identity.sourceCommit) ||
    bundle.identity.releaseSha !== releaseSha ||
    bundle.identity.releaseTag !== releaseTag ||
    bundle.identity.releasePassport?.ref !==
      `buildchain:release-passport/${candidateSourceSha}` ||
    bundle.distribution?.repository !== 'kungfu-systems/kungfu' ||
    bundle.distribution.releaseBaseUrl !== releaseBaseUrl(releaseTag) ||
    bundle.distribution.manifestAsset !== BUNDLE_MANIFEST_ASSET
  ) {
    throw new Error(
      'existing installer publication bundle does not match the exact Alpha release identity',
    );
  }
  return bundle;
}

async function fetchReleaseAsset(
  url,
  { fetcher = fetch, optional = false } = {},
) {
  const response = await fetcher(url, {
    cache: 'no-store',
    headers: { accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(30_000),
  });
  if (optional && response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `public release asset returned HTTP ${response.status}: ${url}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function existingPublicationAuthority({
  version,
  candidateSourceSha,
  acceptedSourceShas,
  releaseSha,
  releaseTag,
  trust,
  releaseAssets = null,
  fetcher = fetch,
}) {
  const baseUrl = releaseBaseUrl(releaseTag);
  const manifestUrl = `${baseUrl}/${BUNDLE_MANIFEST_ASSET}`;
  const manifestBytes = await fetchReleaseAsset(manifestUrl, {
    fetcher,
    optional: true,
  });
  if (!manifestBytes) return null;
  const bundle = JSON.parse(manifestBytes);
  let identityDrift = [];
  try {
    validateExistingPublicationIdentity({
      bundle,
      version,
      candidateSourceSha,
      acceptedSourceShas,
      releaseSha,
      releaseTag,
    });
  } catch {
    identityDrift = [
      {
        kind: 'publication-identity',
        expected: {
          version,
          candidateSourceSha,
          releaseSha,
          releaseTag,
        },
        observed: bundle.identity || null,
      },
    ];
  }
  const canonicalManifest = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`);
  if (!manifestBytes.equals(canonicalManifest)) {
    throw new Error(
      'existing installer publication bundle manifest bytes are not canonical',
    );
  }
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-existing-alpha-publication-'),
  );
  try {
    fs.writeFileSync(path.join(temporaryRoot, 'bundle.json'), manifestBytes, {
      flag: 'wx',
    });
    const downloadedAssets = new Map();
    for (const asset of bundle.assets) {
      const expectedUrl = `${baseUrl}/${asset.releaseAsset}`;
      if (asset.releaseUrl !== expectedUrl) {
        throw new Error(
          `existing installer publication asset URL drifted: ${asset.path}`,
        );
      }
      if (!downloadedAssets.has(asset.releaseAsset)) {
        downloadedAssets.set(
          asset.releaseAsset,
          await fetchReleaseAsset(expectedUrl, { fetcher }),
        );
      }
      const destination = bundleAssetDestination(temporaryRoot, asset.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, downloadedAssets.get(asset.releaseAsset), {
        flag: 'wx',
      });
    }
    verifyInstallerPublicationBundle({
      bundleRoot: temporaryRoot,
      expectedBundleRoot: bundle.bundleRoot,
    });
    const channelBytes = fs.readFileSync(
      path.join(temporaryRoot, 'channel-index.json'),
    );
    const channelIndex = JSON.parse(channelBytes);
    verifyReleaseChannelIndex(channelIndex, trustedKeyMap(trust));
    if (
      !channelBytes.equals(
        Buffer.concat([canonicalBytes(channelIndex), Buffer.from('\n')]),
      )
    ) {
      throw new Error(
        'existing installer publication Alpha channel bytes are not canonical',
      );
    }
    const artifactDrift = releaseAssets
      ? publicationArtifactDrift({
          channelIndex,
          releaseAssets,
          releaseTag,
        })
      : [];
    return {
      bundle,
      artifactDrift: [...identityDrift, ...artifactDrift],
      manifestDigest: sha256(manifestBytes),
      manifestUrl,
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function publicationCommitEvidence({
  version,
  sourceSha,
  candidateSourceSha,
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
    identity: {
      version,
      sourceSha,
      candidateSourceSha,
      releaseSha,
      releaseTag,
    },
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
  releaseAssets = null,
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
  const manifestSet = publicationManifestSet({
    payloadRoot: payloadDir,
    candidatePassportPath,
    version,
    sourceSha,
  });
  const releaseBoundAdmission = releaseAssets
    ? bindPublicationReleaseAssets({
        admission: manifestSet,
        releaseAssets,
        releaseTag: `v${version}`,
      })
    : manifestSet;
  const publicAdmission = {
    ...releaseBoundAdmission,
    manifests: releaseBoundAdmission.manifests.map((entry) => ({
      ...entry,
      manifest: bindProductReleaseCut(entry.manifest, {
        parentReleaseCutRoots: [],
        sourceBuild: false,
      }),
    })),
  };
  const generatedAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + 30 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const spec = channelSpecFromAdmission({
    admission: publicAdmission,
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
  if (
    !releaseCandidateSourceShas(candidatePassportPath).includes(
      spec.sourceCommit,
    )
  ) {
    throw new Error(
      'admitted release source is outside the sealed candidate identity',
    );
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const channelIndexPath = path.join(outputDir, 'alpha.json');
  const channelIndex = writeChannelIndex({
    spec,
    privateKeyPem,
    baseDirectory: PRODUCT_ROOT,
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
    admission: publicAdmission,
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

export function validateExistingLauncherRelease({ tag, release }) {
  if (release?.tagName !== tag) {
    throw new Error(`existing launcher Release tag mismatch: expected ${tag}`);
  }
  const assets = new Set(
    Array.isArray(release.assets)
      ? release.assets.map((asset) => asset?.name).filter(Boolean)
      : [],
  );
  for (const requiredAsset of ['component-release-bom.json', 'SHA256SUMS']) {
    if (!assets.has(requiredAsset)) {
      throw new Error(
        `existing launcher Release ${tag} is missing ${requiredAsset}`,
      );
    }
  }
  return tag;
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
    const releaseProbe = spawnSync(
      'gh',
      [
        'release',
        'view',
        tag,
        '--repo',
        'kungfu-systems/kungfu',
        '--json',
        'tagName,assets',
      ],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (releaseProbe.status !== 0) {
      throw new Error(
        `existing launcher tag ${tag} has no complete GitHub Release`,
      );
    }
    return validateExistingLauncherRelease({
      tag,
      release: JSON.parse(releaseProbe.stdout),
    });
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

function releaseAssetInventory({ token, releaseTag }) {
  const release = JSON.parse(
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
      { env: ghEnvironment(token) },
    ),
  );
  return release.assets;
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

export function existingReleaseAssetIsWinner(asset, file) {
  if (!asset) return false;
  const size = fs.statSync(file).size;
  const digest = sha256(fs.readFileSync(file));
  if (
    asset.state !== 'uploaded' ||
    asset.size !== size ||
    asset.digest !== digest
  ) {
    throw new Error(
      `installer publication release asset conflicts with existing bytes: ${asset.name}`,
    );
  }
  return true;
}

function publishReleaseAssets({
  token,
  releaseTag,
  bundleRoot,
  bundle,
  replaceConflicting = false,
}) {
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
  const assetsByName = new Map(
    existing.assets.map((asset) => [asset.name, asset]),
  );
  const stagingRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-installer-release-assets-'),
  );
  try {
    for (const [name, file] of releaseAssetInputs(
      bundleRoot,
      bundle,
      stagingRoot,
    )) {
      try {
        if (existingReleaseAssetIsWinner(assetsByName.get(name), file)) {
          continue;
        }
      } catch (error) {
        if (!replaceConflicting) throw error;
        run(
          'gh',
          [
            'release',
            'upload',
            releaseTag,
            file,
            '--repo',
            'kungfu-systems/kungfu',
            '--clobber',
          ],
          { env },
        );
        continue;
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
    candidateSourceSha: exactSha(
      process.env.BUILDCHAIN_PUBLICATION_COMMIT_CANDIDATE_SOURCE_SHA ||
        process.env.BUILDCHAIN_PUBLICATION_COMMIT_SOURCE_SHA,
      'BUILDCHAIN_PUBLICATION_COMMIT_CANDIDATE_SOURCE_SHA',
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
    root: PRODUCT_ROOT,
    plan: readJson(tailPlanPath, 'Alpha publication tail plan'),
    expectedSourceCommit: environment.candidateSourceSha,
    expectedVersion: environment.version,
  });
  const trustDocument = readJson(TRUST_PATH, 'release-channel trust');
  const trust = releaseChannelTrust(trustDocument, 'alpha');
  const previous = await previousAuthority(trustedKeyMap(trust));
  const releaseAssets = releaseAssetInventory(environment);
  const candidatePassportPath = path.join(
    path.dirname(environment.payloadDir),
    'passport',
    'release-candidate-passport.json',
  );
  const existing = await existingPublicationAuthority({
    ...environment,
    acceptedSourceShas: releaseCandidateSourceShas(candidatePassportPath),
    trust,
    releaseAssets,
  });
  if (existing && existing.artifactDrift.length === 0) {
    ensureLauncherTag(environment);
    await applyProductReleaseMetadata({
      repository: 'kungfu-systems/kungfu',
      tag: environment.releaseTag,
      token: environment.token,
    });
    const evidence = publicationCommitEvidence({
      ...environment,
      payloadRoot: existing.bundle.identity.channelPayloadRoot,
      previousPayloadRoot: previous?.index.payloadRoot,
      bundle: existing.bundle,
      readbackDigest: existing.manifestDigest,
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
        action: 'reused-existing-publication-authority',
        channelPayloadRoot: existing.bundle.identity.channelPayloadRoot,
        installerBundleRoot: existing.bundle.bundleRoot,
        installerBundleUrl: existing.manifestUrl,
        siteHandoff: evidence.siteHandoff.state,
      })}\n`,
    );
    return;
  }
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-alpha-publication-'),
  );
  const prepared = prepareAlphaPublication({
    ...environment,
    sourceSha: environment.candidateSourceSha,
    candidatePassportPath,
    trustDocument,
    releaseAssets,
    previousChannelIndex: previous?.index || null,
    outputDir: path.join(temporaryRoot, 'prepared'),
    now: publicationTimestamp(
      readJson(environment.releasePassportPath, 'final release passport'),
    ),
  });
  ensureLauncherTag(environment);
  const packageMetadata = readJson(
    path.join(PRODUCT_ROOT, 'framework', 'site', 'package.json'),
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
  publishReleaseAssets({
    ...environment,
    bundleRoot,
    bundle,
    replaceConflicting: Boolean(existing),
  });
  await applyProductReleaseMetadata({
    repository: 'kungfu-systems/kungfu',
    tag: environment.releaseTag,
    token: environment.token,
  });
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
