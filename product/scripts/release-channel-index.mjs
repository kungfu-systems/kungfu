#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createHash, createPrivateKey, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CHANNEL_INDEX_SCHEMA = 'kungfu.release-channel-index/v1';

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) =>
          Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
        )
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new Error(
    'canonical JSON accepts only null, strings, booleans, and non-negative safe integers',
  );
}

function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) => {
    const code = character.charCodeAt(0).toString(16).padStart(4, '0');
    return `\\u${code}`;
  });
}

export function canonicalBytes(value) {
  return Buffer.from(asciiJson(canonical(value)), 'ascii');
}

export function contentRoot(value) {
  return `sha256:${createHash('sha256').update(canonicalBytes(value)).digest('hex')}`;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `failed to read ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requireRoot(value, label) {
  if (!/^sha256:[a-f0-9]{64}$/.test(value || '')) {
    throw new Error(`${label} must be a sha256 root`);
  }
  return value;
}

function artifactRoot(manifest) {
  return contentRoot(
    (manifest.artifacts || []).map((artifact) => ({
      kind: artifact.kind,
      url: artifact.url,
      size: artifact.size,
      digest: artifact.digest,
      signature: artifact.signature,
    })),
  );
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requireTimestamp(value, label) {
  requireString(value, label);
  if (!value.endsWith('Z') || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an RFC 3339 UTC timestamp`);
  }
  return value;
}

function requirePublicHttps(value, label) {
  requireString(value, label);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a public HTTPS URL`);
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search
  ) {
    throw new Error(
      `${label} must be a public HTTPS URL without credentials or query`,
    );
  }
  return value;
}

export function channelSpecFromAdmission({
  admission,
  releaseCandidatePassportPath,
  channel,
  installSources = ['archive'],
  keyId,
  generatedAt,
  expiresAt,
}) {
  if (!['alpha', 'stable'].includes(channel)) {
    throw new Error(`release channel is invalid: ${channel}`);
  }
  if (
    !Array.isArray(admission?.manifests) ||
    admission.manifests.length === 0
  ) {
    throw new Error('upgrade admission has no exact release manifests');
  }
  if (!Array.isArray(installSources) || installSources.length === 0) {
    throw new Error('at least one install source is required');
  }
  const manifests = admission.manifests.map((entry) => ({
    ...entry,
    manifest: readJson(entry.manifestPath, 'admitted release manifest'),
  }));
  const sourceCommits = new Set(
    manifests.map((entry) => entry.manifest.sourceCommit),
  );
  if (sourceCommits.size !== 1) {
    throw new Error(
      'admitted release manifests do not share one source commit',
    );
  }
  const passport = readJson(
    releaseCandidatePassportPath,
    'release-candidate passport',
  );
  const sourceCommit = [...sourceCommits][0];
  return {
    keyId,
    generatedAt,
    expiresAt,
    sourceCommit,
    releasePassport: {
      ref: `buildchain:release-candidate-passport/${sourceCommit}`,
      root: contentRoot(passport),
    },
    entries: manifests.flatMap(({ manifestPath, manifest }) =>
      installSources.map((installSource) => ({
        channel,
        installSource,
        rollout: 'current',
        manifestPath,
        documentationUrl: manifest.documentationUrl,
      })),
    ),
  };
}

export function buildChannelIndex({
  spec,
  privateKeyPem,
  baseDirectory = process.cwd(),
}) {
  if (!/^[a-f0-9]{40}$/.test(spec.sourceCommit || '')) {
    throw new Error('sourceCommit must be an exact Git SHA');
  }
  if (!spec.releasePassport?.ref) {
    throw new Error('releasePassport.ref is required');
  }
  requireRoot(spec.releasePassport.root, 'releasePassport.root');
  requireString(spec.keyId, 'keyId');
  const generatedAt = requireTimestamp(spec.generatedAt, 'generatedAt');
  const expiresAt = requireTimestamp(spec.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(generatedAt)) {
    throw new Error('expiresAt must be later than generatedAt');
  }
  if (!Array.isArray(spec.entries) || spec.entries.length === 0) {
    throw new Error('at least one release channel entry is required');
  }
  const identities = new Set();
  const entries = spec.entries.map((entry) => {
    const manifestPath = path.resolve(baseDirectory, entry.manifestPath);
    const manifest = readJson(manifestPath, 'release manifest');
    if (!['alpha', 'stable'].includes(entry.channel)) {
      throw new Error(`release channel is invalid: ${entry.channel}`);
    }
    requireString(entry.installSource, 'entry.installSource');
    requirePublicHttps(
      entry.documentationUrl || manifest.documentationUrl,
      'entry.documentationUrl',
    );
    for (const artifact of manifest.artifacts || []) {
      if (
        typeof artifact.url === 'string' &&
        artifact.url.startsWith('https:')
      ) {
        requirePublicHttps(artifact.url, `artifact ${artifact.kind} URL`);
      }
    }
    const identity = [
      entry.channel,
      manifest.platform,
      manifest.architecture,
      entry.installSource,
    ].join('/');
    if (identities.has(identity)) {
      throw new Error(`duplicate release channel entry: ${identity}`);
    }
    identities.add(identity);
    if (
      manifest.sourceCommit !== spec.sourceCommit ||
      manifest.releaseChannel !== entry.channel
    ) {
      throw new Error(`release manifest identity mismatch: ${identity}`);
    }
    if (!['current', 'paused', 'rollback-only'].includes(entry.rollout)) {
      throw new Error(`release rollout is invalid: ${identity}`);
    }
    return {
      channel: entry.channel,
      platform: manifest.platform,
      architecture: manifest.architecture,
      installSource: entry.installSource,
      rollout: entry.rollout,
      manifest,
      manifestRoot: contentRoot(manifest),
      artifactRoot: artifactRoot(manifest),
      documentationUrl: entry.documentationUrl || manifest.documentationUrl,
    };
  });
  entries.sort((left, right) =>
    [left.channel, left.platform, left.architecture, left.installSource]
      .join('/')
      .localeCompare(
        [
          right.channel,
          right.platform,
          right.architecture,
          right.installSource,
        ].join('/'),
      ),
  );
  const payload = {
    schema: CHANNEL_INDEX_SCHEMA,
    generatedAt,
    expiresAt,
    sourceCommit: spec.sourceCommit,
    releasePassport: spec.releasePassport,
    entries,
  };
  const signed = { ...payload, payloadRoot: contentRoot(payload) };
  const signature = sign(
    null,
    canonicalBytes(signed),
    createPrivateKey(privateKeyPem),
  ).toString('base64');
  return {
    ...signed,
    signature: {
      algorithm: 'ed25519',
      keyId: spec.keyId,
      value: signature,
    },
  };
}

export function writeChannelIndex(options) {
  const index = buildChannelIndex(options);
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(
    options.output,
    Buffer.concat([canonicalBytes(index), Buffer.from('\n')]),
  );
  return index;
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--spec') options.spec = args[++index];
    else if (value === '--private-key') options.privateKey = args[++index];
    else if (value === '--output') options.output = args[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  for (const field of ['spec', 'privateKey', 'output']) {
    if (!options[field]) {
      throw new Error(
        `--${field.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)} is required`,
      );
    }
  }
  return options;
}

function main(args) {
  const options = parseArgs(args);
  const specPath = path.resolve(options.spec);
  const output = path.resolve(options.output);
  const index = writeChannelIndex({
    spec: readJson(specPath, 'release channel specification'),
    privateKeyPem: fs.readFileSync(path.resolve(options.privateKey), 'utf8'),
    baseDirectory: path.dirname(specPath),
    output,
  });
  process.stdout.write(
    `${JSON.stringify({ output, payloadRoot: index.payloadRoot, entries: index.entries.length })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `release channel generation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
