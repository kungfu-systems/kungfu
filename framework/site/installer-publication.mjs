// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const INSTALLER_PUBLICATION_BUNDLE_SCHEMA =
  'kungfu.installer-publication-bundle/v1';

const PUBLICATION_SCHEMA = 'kungfu.bootstrap-installer-publication/v1';
const ROOT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const REQUIRED_TOP_LEVEL = new Map([
  ['installer-publication.json', 'publication-manifest'],
  ['channel-index.json', 'signed-channel-index'],
  ['trusted-keys.json', 'public-trust-anchors'],
  ['install.sh', 'friendly-installer'],
  ['install.ps1', 'friendly-installer'],
]);
const RELEASE_ASSET_NAMES = {
  'installer-publication.json': 'kungfu-installer-publication.json',
  'channel-index.json': 'kungfu-installer-channel-index.json',
  'trusted-keys.json': 'kungfu-installer-trusted-keys.json',
  'install.sh': 'kungfu-install.sh',
  'install.ps1': 'kungfu-install.ps1',
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function root(value) {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function requiredRoot(value, label) {
  const normalized = requiredString(value, label);
  if (!ROOT_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a lowercase sha256 root`);
  }
  return normalized;
}

function safeRelative(value, label) {
  const normalized = requiredString(value, label).replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    normalized.split('/').some((part) => part === '' || part === '..')
  ) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return normalized;
}

function readRegularFile(rootDirectory, relativePath, label) {
  const safePath = safeRelative(relativePath, label);
  const rootPath = path.resolve(rootDirectory);
  const absolute = path.resolve(rootPath, safePath);
  if (!absolute.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`${label} escapes the bundle root`);
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  return { path: safePath, bytes: fs.readFileSync(absolute) };
}

function json(bytes, label) {
  try {
    return JSON.parse(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function contentType(relativePath) {
  if (relativePath.endsWith('.json')) {
    return 'application/json; charset=utf-8';
  }
  if (relativePath.endsWith('.sh')) {
    return 'text/x-shellscript; charset=utf-8';
  }
  if (relativePath.endsWith('.ps1')) {
    return 'text/plain; charset=utf-8';
  }
  throw new Error(`installer bundle has no content type for ${relativePath}`);
}

function releaseAssetName(relativePath) {
  const name = path.posix.basename(relativePath);
  const releaseAsset = RELEASE_ASSET_NAMES[name];
  if (!releaseAsset) {
    throw new Error(
      `installer bundle has no release asset for ${relativePath}`,
    );
  }
  return releaseAsset;
}

function assetRecord(relativePath, role, bytes, releaseBaseUrl) {
  const releaseAsset = releaseAssetName(relativePath);
  return {
    path: relativePath,
    role,
    contentType: contentType(relativePath),
    size: bytes.length,
    digest: digest(bytes),
    releaseAsset,
    releaseUrl: `${releaseBaseUrl}/${releaseAsset}`,
  };
}

function listFiles(rootDirectory) {
  const result = [];
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path
        .relative(rootDirectory, absolute)
        .split(path.sep)
        .join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`installer bundle contains a symlink: ${relative}`);
      }
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) result.push(relative);
      else
        throw new Error(
          `installer bundle contains a special file: ${relative}`,
        );
    }
  };
  visit(rootDirectory);
  return result;
}

function expectedBundlePaths(publication) {
  const immutablePath = safeRelative(
    publication.immutablePath,
    'publication.immutablePath',
  );
  return new Map([
    ...REQUIRED_TOP_LEVEL,
    [`${immutablePath}/install.sh`, 'immutable-installer'],
    [`${immutablePath}/install.ps1`, 'immutable-installer'],
  ]);
}

export function verifyInstallerPublicationBundle({
  bundleRoot,
  expectedBundleRoot = '',
}) {
  const rootDirectory = path.resolve(bundleRoot);
  const bundleFile = readRegularFile(
    rootDirectory,
    'bundle.json',
    'bundle.json',
  );
  const bundle = json(bundleFile.bytes, 'bundle.json');
  if (bundle.schema !== INSTALLER_PUBLICATION_BUNDLE_SCHEMA) {
    throw new Error('unsupported installer publication bundle schema');
  }
  const declaredRoot = requiredRoot(bundle.bundleRoot, 'bundle.bundleRoot');
  const unsigned = Object.fromEntries(
    Object.entries(bundle).filter(([key]) => key !== 'bundleRoot'),
  );
  if (root(unsigned) !== declaredRoot) {
    throw new Error('installer publication bundle root mismatch');
  }
  if (expectedBundleRoot && declaredRoot !== expectedBundleRoot) {
    throw new Error(
      'installer publication bundle differs from the pinned root',
    );
  }
  if (
    bundle.package?.name !== '@kungfu-tech/site' ||
    typeof bundle.package?.version !== 'string'
  ) {
    throw new Error('installer publication bundle package identity is invalid');
  }
  if (
    !['alpha', 'stable'].includes(bundle.identity?.channel) ||
    !SHA_PATTERN.test(bundle.identity?.sourceCommit || '') ||
    !SHA_PATTERN.test(bundle.identity?.releaseSha || '') ||
    bundle.identity?.releaseTag !== `v${bundle.identity?.version}`
  ) {
    throw new Error('installer publication bundle release identity is invalid');
  }
  const expectedReleaseBase = `https://github.com/kungfu-systems/kungfu/releases/download/${bundle.identity.releaseTag}`;
  if (
    bundle.distribution?.repository !== 'kungfu-systems/kungfu' ||
    bundle.distribution?.releaseBaseUrl !== expectedReleaseBase ||
    bundle.distribution?.manifestAsset !==
      'kungfu-installer-publication-bundle.json'
  ) {
    throw new Error('installer publication bundle distribution is invalid');
  }
  for (const [value, label] of [
    [bundle.identity?.channelPayloadRoot, 'identity.channelPayloadRoot'],
    [bundle.identity?.channelFileDigest, 'identity.channelFileDigest'],
    [bundle.identity?.releasePassport?.root, 'identity.releasePassport.root'],
  ]) {
    requiredRoot(value, label);
  }
  if (
    bundle.cachePolicy?.friendly !== 'public,max-age=300,must-revalidate' ||
    bundle.cachePolicy?.immutable !== 'public,max-age=31536000,immutable'
  ) {
    throw new Error('installer publication bundle cache intent is invalid');
  }
  const publicationFile = readRegularFile(
    rootDirectory,
    'installer-publication.json',
    'installer-publication.json',
  );
  const publication = json(publicationFile.bytes, 'installer-publication.json');
  if (
    publication.schema !== PUBLICATION_SCHEMA ||
    publication.channel !== bundle.identity.channel ||
    publication.sourceCommit !== bundle.identity.sourceCommit ||
    publication.channelPayloadRoot !== bundle.identity.channelPayloadRoot ||
    publication.channelFileDigest !== bundle.identity.channelFileDigest ||
    publication.releasePassport?.root !== bundle.identity.releasePassport.root
  ) {
    throw new Error('installer publication and bundle authority differ');
  }
  const channel = readRegularFile(
    rootDirectory,
    'channel-index.json',
    'channel-index.json',
  );
  if (
    digest(channel.bytes) !== bundle.identity.channelFileDigest ||
    json(channel.bytes, 'channel-index.json').payloadRoot !==
      bundle.identity.channelPayloadRoot
  ) {
    throw new Error('signed channel bytes differ from bundle identity');
  }
  const expectedPaths = expectedBundlePaths(publication);
  const declaredPaths = new Set();
  if (
    !Array.isArray(bundle.assets) ||
    bundle.assets.length !== expectedPaths.size
  ) {
    throw new Error('installer publication bundle asset set is incomplete');
  }
  for (const asset of bundle.assets) {
    const relativePath = safeRelative(asset.path, 'bundle asset path');
    if (
      declaredPaths.has(relativePath) ||
      expectedPaths.get(relativePath) !== asset.role
    ) {
      throw new Error(`unexpected or duplicate bundle asset: ${relativePath}`);
    }
    declaredPaths.add(relativePath);
    const file = readRegularFile(rootDirectory, relativePath, relativePath);
    if (
      asset.size !== file.bytes.length ||
      asset.digest !== digest(file.bytes) ||
      asset.contentType !== contentType(relativePath) ||
      asset.releaseAsset !== releaseAssetName(relativePath) ||
      asset.releaseUrl !== `${expectedReleaseBase}/${asset.releaseAsset}`
    ) {
      throw new Error(`bundle asset metadata drifted: ${relativePath}`);
    }
  }
  const observedPaths = listFiles(rootDirectory);
  const allowedPaths = new Set(['bundle.json', ...expectedPaths.keys()]);
  if (
    observedPaths.length !== allowedPaths.size ||
    observedPaths.some((relativePath) => !allowedPaths.has(relativePath))
  ) {
    throw new Error('installer publication bundle is not closed-world');
  }
  const publicationAssets = new Map(
    publication.assets.map((asset) => [asset.name, asset]),
  );
  for (const name of ['install.sh', 'install.ps1']) {
    const friendly = readRegularFile(rootDirectory, name, name).bytes;
    const immutable = readRegularFile(
      rootDirectory,
      `${publication.immutablePath}/${name}`,
      `${publication.immutablePath}/${name}`,
    ).bytes;
    const declared = publicationAssets.get(name);
    if (
      !declared ||
      !friendly.equals(immutable) ||
      declared.size !== friendly.length ||
      declared.digest !== digest(friendly)
    ) {
      throw new Error(`friendly and immutable installer bytes differ: ${name}`);
    }
  }
  return { bundle, publication, bundleRoot: declaredRoot };
}

export function writeInstallerPublicationBundle({
  publicationRoot,
  channelIndexPath,
  trustedKeysPath,
  outputRoot,
  packageVersion,
  releaseSha,
  releaseTag,
}) {
  const destination = path.resolve(outputRoot);
  if (fs.existsSync(destination)) {
    throw new Error(
      'installer publication bundle output must not already exist',
    );
  }
  const source = path.resolve(publicationRoot);
  const publicationSource = readRegularFile(
    source,
    'installer-publication.json',
    'installer-publication.json',
  );
  const publication = json(
    publicationSource.bytes,
    'installer-publication.json',
  );
  if (publication.schema !== PUBLICATION_SCHEMA) {
    throw new Error('unsupported installer publication schema');
  }
  const expectedPaths = expectedBundlePaths(publication);
  const inputs = new Map([
    ['installer-publication.json', publicationSource.bytes],
    [
      'channel-index.json',
      readRegularFile(
        path.dirname(path.resolve(channelIndexPath)),
        path.basename(channelIndexPath),
        'channel index',
      ).bytes,
    ],
    [
      'trusted-keys.json',
      readRegularFile(
        path.dirname(path.resolve(trustedKeysPath)),
        path.basename(trustedKeysPath),
        'trusted keys',
      ).bytes,
    ],
    ['install.sh', readRegularFile(source, 'install.sh', 'install.sh').bytes],
    [
      'install.ps1',
      readRegularFile(source, 'install.ps1', 'install.ps1').bytes,
    ],
    [
      `${publication.immutablePath}/install.sh`,
      readRegularFile(
        source,
        `${publication.immutablePath}/install.sh`,
        'immutable install.sh',
      ).bytes,
    ],
    [
      `${publication.immutablePath}/install.ps1`,
      readRegularFile(
        source,
        `${publication.immutablePath}/install.ps1`,
        'immutable install.ps1',
      ).bytes,
    ],
  ]);
  const version = requiredString(packageVersion, 'packageVersion');
  const normalizedReleaseSha = requiredString(releaseSha, 'releaseSha');
  if (!SHA_PATTERN.test(normalizedReleaseSha)) {
    throw new Error('releaseSha must be an exact Git SHA');
  }
  const normalizedReleaseTag = requiredString(releaseTag, 'releaseTag');
  const productVersion = publication.entries?.[0]?.version;
  if (
    !productVersion ||
    publication.entries.some((entry) => entry.version !== productVersion) ||
    normalizedReleaseTag !== `v${productVersion}`
  ) {
    throw new Error('release tag and installer product version differ');
  }
  const releaseBaseUrl = `https://github.com/kungfu-systems/kungfu/releases/download/${normalizedReleaseTag}`;
  const assets = [...expectedPaths].map(([relativePath, role]) =>
    assetRecord(relativePath, role, inputs.get(relativePath), releaseBaseUrl),
  );
  const unsigned = {
    schema: INSTALLER_PUBLICATION_BUNDLE_SCHEMA,
    package: { name: '@kungfu-tech/site', version },
    identity: {
      channel: publication.channel,
      version: productVersion,
      sourceCommit: publication.sourceCommit,
      releaseSha: normalizedReleaseSha,
      releaseTag: normalizedReleaseTag,
      channelPayloadRoot: publication.channelPayloadRoot,
      channelFileDigest: publication.channelFileDigest,
      releasePassport: publication.releasePassport,
    },
    distribution: {
      repository: 'kungfu-systems/kungfu',
      releaseBaseUrl,
      manifestAsset: 'kungfu-installer-publication-bundle.json',
    },
    routes: {
      friendly: {
        'install.sh': publication.assets.find(
          (asset) => asset.name === 'install.sh',
        )?.friendlyUrl,
        'install.ps1': publication.assets.find(
          (asset) => asset.name === 'install.ps1',
        )?.friendlyUrl,
      },
      immutablePath: publication.immutablePath,
    },
    cachePolicy: {
      friendly: 'public,max-age=300,must-revalidate',
      immutable: 'public,max-age=31536000,immutable',
    },
    assets,
  };
  const bundle = { ...unsigned, bundleRoot: root(unsigned) };
  for (const [relativePath, bytes] of inputs) {
    const destinationFile = path.join(destination, relativePath);
    fs.mkdirSync(path.dirname(destinationFile), { recursive: true });
    fs.writeFileSync(destinationFile, bytes, { flag: 'wx' });
  }
  fs.writeFileSync(
    path.join(destination, 'bundle.json'),
    `${JSON.stringify(bundle, null, 2)}\n`,
    { flag: 'wx' },
  );
  verifyInstallerPublicationBundle({
    bundleRoot: destination,
    expectedBundleRoot: bundle.bundleRoot,
  });
  return bundle;
}
