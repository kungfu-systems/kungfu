#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { createHash, createPrivateKey, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { qualificationContentRoot } from '@kungfu-tech/workspaces/tooling/upgrade-qualification';

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

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function canonicalKey(value) {
  return canonicalBytes(value).toString('ascii');
}

function assemblePublicReleaseCut(
  manifests,
  { parentReleaseCutRoots = null } = {},
) {
  const aware = manifests.filter((manifest) => manifest.releaseCut);
  if (aware.length === 0) return manifests;
  if (aware.length !== manifests.length) {
    throw new Error(
      'admitted release manifests mix Cut-aware and legacy identities',
    );
  }
  const first = manifests[0];
  const firstCut = first.releaseCut;
  if (
    firstCut?.publicationPolicy?.trustDomain !== 'public' ||
    firstCut.publicationPolicy.publicationEligible !== true
  ) {
    throw new Error('public channel admission requires a public Release Cut');
  }
  const commonFields = [
    'schema',
    'productVersion',
    'parentReleaseCutRoots',
    'sourceSettlementRoot',
    'compatibilityContractRoot',
    'migrationContractRoot',
    'publicationPolicy',
    'omissionRoots',
    'waiverRoots',
  ];
  const slices = manifests
    .map((manifest) => {
      const cut = manifest.releaseCut;
      if (
        cut?.publicationPolicy?.trustDomain !== 'public' ||
        commonFields.some(
          (field) =>
            canonicalKey(cut?.[field]) !== canonicalKey(firstCut[field]),
        )
      ) {
        throw new Error(
          'admitted release manifests do not share one public Cut contract',
        );
      }
      const matches = (cut.platformSlices || []).filter(
        (slice) =>
          slice.platform === manifest.platform &&
          slice.architecture === manifest.architecture &&
          slice.platformSliceRoot === manifest.platformSliceRoot &&
          slice.manifestIdentityRoot === manifest.manifestIdentityRoot,
      );
      if (matches.length !== 1) {
        throw new Error(
          'admitted release manifest is not bound to one exact platform slice',
        );
      }
      return matches[0];
    })
    .sort((left, right) =>
      `${left.platform}/${left.architecture}`.localeCompare(
        `${right.platform}/${right.architecture}`,
      ),
    );
  const targets = slices.map(
    (slice) => `${slice.platform}/${slice.architecture}`,
  );
  if (targets.length !== new Set(targets).size) {
    throw new Error('admitted release manifests duplicate a platform slice');
  }
  const memberRoots = slices.map((slice) => ({
    platform: slice.platform,
    architecture: slice.architecture,
    manifestIdentityRoot: slice.manifestIdentityRoot,
    artifactRoot: slice.artifactRoot,
    platformSliceRoot: slice.platformSliceRoot,
  }));
  const { releaseCutRoot: _individualRoot, ...cutContract } = firstCut;
  const releaseCut = {
    ...cutContract,
    ...(parentReleaseCutRoots
      ? {
          parentReleaseCutRoots: sortedUnique(
            parentReleaseCutRoots.map((root) =>
              requireRoot(root, 'parentReleaseCutRoots'),
            ),
          ),
        }
      : {}),
    semanticIdentityRoot: contentRoot({
      productVersion: first.productVersion,
      releaseChannel: first.releaseChannel,
      sourceCommit: first.sourceCommit,
      platformMembers: memberRoots.map(
        ({ platform, architecture, manifestIdentityRoot }) => ({
          platform,
          architecture,
          manifestIdentityRoot,
        }),
      ),
    }),
    productAssemblyRoot: contentRoot(memberRoots),
    platformSlices: slices,
    qualificationEvidenceRoots: sortedUnique(
      slices.flatMap((slice) => slice.qualificationEvidenceRoots),
    ),
    signingEvidenceRoots: sortedUnique(
      slices.flatMap((slice) => slice.signingEvidenceRoots),
    ),
  };
  releaseCut.releaseCutRoot = contentRoot(releaseCut);
  return manifests.map((manifest) => ({
    ...manifest,
    releaseCut,
    releaseCutRoot: releaseCut.releaseCutRoot,
  }));
}

function rangesOverlap(left, right) {
  return (
    Number.isSafeInteger(left?.min) &&
    Number.isSafeInteger(left?.max) &&
    Number.isSafeInteger(right?.min) &&
    Number.isSafeInteger(right?.max) &&
    Math.max(left.min, right.min) <= Math.min(left.max, right.max)
  );
}

function publicCutTransition(previousIndex, targetManifest, passportRoot) {
  if (!previousIndex) return null;
  const previousEntries = previousIndex.entries || [];
  if (previousEntries.length === 0) {
    throw new Error('previous public channel has no Release Cut entries');
  }
  const previousRoots = sortedUnique(
    previousEntries.map((entry) =>
      requireRoot(entry.releaseCutRoot, 'previous entry releaseCutRoot'),
    ),
  );
  const previousVersions = sortedUnique(
    previousEntries.map((entry) =>
      requireString(entry.manifest?.productVersion, 'previous productVersion'),
    ),
  );
  if (previousRoots.length !== 1 || previousVersions.length !== 1) {
    throw new Error('previous public channel does not bind one Release Cut');
  }
  const previousManifest = previousEntries[0].manifest;
  const evidenceRoots = sortedUnique([
    requireRoot(passportRoot, 'release passport root'),
    ...targetManifest.releaseCut.qualificationEvidenceRoots,
    ...targetManifest.releaseCut.signingEvidenceRoots,
  ]);
  const providerResumeRequired = targetManifest.providerResumeRequired === true;
  const transition = {
    schema: 'kungfu.product-release-cut-transition/v1',
    fromReleaseCutRoot: previousRoots[0],
    toReleaseCutRoot: targetManifest.releaseCutRoot,
    fromProductVersion: previousVersions[0],
    toProductVersion: targetManifest.productVersion,
    relation: 'verified-successor',
    authorization: {
      trustDomain: 'public',
      kind:
        previousVersions[0] === targetManifest.productVersion
          ? 'signed-supersession'
          : 'signed-lineage',
      publicationEligible: true,
      evidenceRoots,
    },
    compatibility: {
      controlProtocol: rangesOverlap(
        previousManifest.controlProtocolRange,
        targetManifest.controlProtocolRange,
      ),
      peerWireProtocol: rangesOverlap(
        previousManifest.peerWireProtocolRange,
        targetManifest.peerWireProtocolRange,
      ),
      journalReadable:
        Number.isSafeInteger(previousManifest.journalSchemaWriteVersion) &&
        Number.isSafeInteger(targetManifest.journalSchemaReadRange?.min) &&
        Number.isSafeInteger(targetManifest.journalSchemaReadRange?.max) &&
        previousManifest.journalSchemaWriteVersion >=
          targetManifest.journalSchemaReadRange.min &&
        previousManifest.journalSchemaWriteVersion <=
          targetManifest.journalSchemaReadRange.max,
      migrationClass: targetManifest.migrationClass,
      rollbackClass: targetManifest.rollbackClass,
      providerResumeRequired,
    },
    migrationPlanRoot: contentRoot({
      migrationClass: targetManifest.migrationClass,
      fromReleaseCutRoot: previousRoots[0],
      toReleaseCutRoot: targetManifest.releaseCutRoot,
    }),
    rollbackPlanRoot: contentRoot({
      rollbackClass: targetManifest.rollbackClass,
      fromReleaseCutRoot: targetManifest.releaseCutRoot,
      toReleaseCutRoot: previousRoots[0],
    }),
    activeWorkPolicy: providerResumeRequired
      ? 'provider-resume'
      : targetManifest.activeWorkPolicy || 'keep-pinned',
    evidenceRoots,
    diagnostics: [],
  };
  transition.cutTransitionRoot = contentRoot(transition);
  return transition;
}

export function channelSpecFromAdmission({
  admission,
  releaseCandidatePassportPath,
  releasePassportPath,
  releasePassportRef,
  channel,
  installSources = ['archive'],
  keyId,
  generatedAt,
  expiresAt,
  previousChannelIndex = null,
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
  const admitted = admission.manifests.map((entry) => ({
    ...entry,
    manifest:
      entry.manifest ||
      readJson(entry.manifestPath, 'admitted release manifest'),
  }));
  const sourceCommits = new Set(
    admitted.map((entry) => entry.manifest.sourceCommit),
  );
  if (sourceCommits.size !== 1) {
    throw new Error(
      'admitted release manifests do not share one source commit',
    );
  }
  const passportPath = releasePassportPath || releaseCandidatePassportPath;
  const passport = readJson(passportPath, 'release passport');
  const sourceCommit = [...sourceCommits][0];
  const passportRef =
    releasePassportRef ||
    `buildchain:${
      releasePassportPath ? 'release-passport' : 'release-candidate-passport'
    }/${sourceCommit}`;
  const previousRoots = previousChannelIndex
    ? sortedUnique(
        (previousChannelIndex.entries || []).map((entry) =>
          requireRoot(entry.releaseCutRoot, 'previous entry releaseCutRoot'),
        ),
      )
    : [];
  if (previousChannelIndex && previousRoots.length !== 1) {
    throw new Error('previous public channel does not bind one Release Cut');
  }
  const assembled = assemblePublicReleaseCut(
    admitted.map((entry) => entry.manifest),
    { parentReleaseCutRoots: previousRoots },
  );
  const cutTransition = publicCutTransition(
    previousChannelIndex,
    assembled[0],
    qualificationContentRoot(passport),
  );
  return {
    keyId,
    generatedAt,
    expiresAt,
    sourceCommit,
    releasePassport: {
      ref: passportRef,
      root: qualificationContentRoot(passport),
    },
    entries: admitted.flatMap(({ manifestPath }, index) =>
      installSources.map((installSource) => ({
        channel,
        installSource,
        rollout: 'current',
        manifestPath,
        manifest: assembled[index],
        ...(cutTransition ? { cutTransition } : {}),
        documentationUrl: assembled[index].documentationUrl,
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
  const sourceManifests = new Map();
  for (const entry of spec.entries) {
    const manifestPath = path.resolve(baseDirectory, entry.manifestPath);
    if (!sourceManifests.has(manifestPath)) {
      sourceManifests.set(
        manifestPath,
        entry.manifest || readJson(manifestPath, 'release manifest'),
      );
    }
  }
  const assembledManifests = assemblePublicReleaseCut([
    ...sourceManifests.values(),
  ]);
  const manifestByPath = new Map(
    [...sourceManifests.keys()].map((manifestPath, index) => [
      manifestPath,
      assembledManifests[index],
    ]),
  );
  const identities = new Set();
  const entries = spec.entries.map((entry) => {
    const manifestPath = path.resolve(baseDirectory, entry.manifestPath);
    const manifest = manifestByPath.get(manifestPath);
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
    const cutBinding = manifest.releaseCutRoot
      ? {
          releaseCutRoot: requireRoot(
            manifest.releaseCutRoot,
            'manifest.releaseCutRoot',
          ),
          platformSliceRoot: requireRoot(
            manifest.platformSliceRoot,
            'manifest.platformSliceRoot',
          ),
          ...(entry.cutTransition || entry.cutTransitionPath
            ? {
                cutTransition:
                  entry.cutTransition ||
                  readJson(
                    path.resolve(baseDirectory, entry.cutTransitionPath),
                    'Cut Transition',
                  ),
              }
            : {}),
        }
      : {};
    return {
      channel: entry.channel,
      platform: manifest.platform,
      architecture: manifest.architecture,
      installSource: entry.installSource,
      rollout: entry.rollout,
      manifest,
      manifestRoot: contentRoot(manifest),
      artifactRoot: artifactRoot(manifest),
      ...cutBinding,
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
  const cutEntries = entries.filter((entry) => entry.releaseCutRoot);
  if (cutEntries.length > 0) {
    if (cutEntries.length !== entries.length) {
      throw new Error(
        'release channel cannot mix Cut-aware and legacy entries',
      );
    }
    const releaseCutRoots = new Set(
      cutEntries.map((entry) => entry.releaseCutRoot),
    );
    if (releaseCutRoots.size !== 1) {
      throw new Error(
        'release channel entries do not share one Product Release Cut',
      );
    }
    const transitionKeys = sortedUnique(
      cutEntries.map((entry) =>
        entry.cutTransition ? canonicalKey(entry.cutTransition) : '',
      ),
    );
    if (transitionKeys.length !== 1) {
      throw new Error(
        'release channel entries do not share one Cut Transition',
      );
    }
    const transition = cutEntries[0].cutTransition;
    if (transition) {
      const expectedTransitionRoot = contentRoot(
        Object.fromEntries(
          Object.entries(transition).filter(
            ([key]) => key !== 'cutTransitionRoot',
          ),
        ),
      );
      if (
        transition.toReleaseCutRoot !== [...releaseCutRoots][0] ||
        transition.cutTransitionRoot !== expectedTransitionRoot
      ) {
        throw new Error(
          'release channel Cut Transition does not bind the exact target Cut',
        );
      }
    }
    const cut = cutEntries[0].manifest.releaseCut;
    const admittedTargets = new Set(
      cutEntries.map((entry) => `${entry.platform}/${entry.architecture}`),
    );
    const cutTargets = new Set(
      cut.platformSlices.map(
        (slice) => `${slice.platform}/${slice.architecture}`,
      ),
    );
    if (
      admittedTargets.size !== cutTargets.size ||
      [...admittedTargets].some((target) => !cutTargets.has(target))
    ) {
      throw new Error(
        'Product Release Cut platform slices do not match channel entries',
      );
    }
  }
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
