#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
import { verifyUpgradePublicationPayloads } from './upgrade-publication-admission.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRUST_PATH = path.join(ROOT, 'product', 'release-channel-trust.json');
const CHANNEL_URL = 'https://kungfu.tech/.well-known/kungfu/alpha.json';
const CANONICAL_BASE_URL = 'https://kungfu.tech';
const SITE_REPOSITORY = 'kungfu-systems/site-kungfu-tech';

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
  sitePullRequest,
  priorUpgrade,
}) {
  return {
    schema: 'kungfu-buildchain-publication-commit-evidence/v1',
    status: 'passed',
    identity: { version, sourceSha, releaseSha, releaseTag },
    publication: {
      url: CHANNEL_URL,
      payloadRoot,
      sitePullRequest,
    },
    readback: {
      status: 'passed',
      url: CHANNEL_URL,
      payloadRoot,
      priorUpgrade,
    },
    recovery: {
      previousAuthority: previousPayloadRoot ? 'preserved' : 'none',
      rollbackReference: previousPayloadRoot || 'none:first-publication',
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

function sitePullRequest({
  token,
  prepared,
  version,
  sourceSha,
  temporaryRoot,
}) {
  const env = ghEnvironment(token);
  run('gh', ['auth', 'setup-git'], { env });
  const siteRoot = path.join(temporaryRoot, 'site');
  run(
    'gh',
    [
      'repo',
      'clone',
      SITE_REPOSITORY,
      siteRoot,
      '--',
      '--depth=1',
      '--branch=main',
    ],
    { env },
  );
  run('git', ['config', 'user.name', 'dongkeren'], {
    cwd: siteRoot,
    env,
  });
  run('git', ['config', 'user.email', 'dongkeren@users.noreply.github.com'], {
    cwd: siteRoot,
    env,
  });
  const rootShort = prepared.channelIndex.payloadRoot.slice(7, 23);
  const branch = `feature/release-alpha-${rootShort}`;
  const importArgs = [
    'scripts/import-bootstrap-publication.mjs',
    '--publication-root',
    prepared.publicationDir,
    '--channel-index',
    prepared.channelIndexPath,
    '--trusted-keys',
    prepared.trustedKeysPath,
    '--output-root',
    path.join(siteRoot, 'public'),
  ];
  const remoteBranch = run(
    'git',
    ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
    { cwd: siteRoot, env },
  );
  if (remoteBranch) {
    run('git', ['fetch', 'origin', branch], { cwd: siteRoot, env });
    run('git', ['switch', '-c', branch, '--track', `origin/${branch}`], {
      cwd: siteRoot,
      env,
    });
    run('node', importArgs, { cwd: siteRoot, env });
    if (run('git', ['status', '--short'], { cwd: siteRoot, env })) {
      throw new Error(
        `existing Site publication branch ${branch} does not contain the exact deterministic projection`,
      );
    }
    const existingPullRequest = run(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        SITE_REPOSITORY,
        '--state',
        'all',
        '--head',
        branch,
        '--json',
        'url',
        '--jq',
        '.[0].url // ""',
      ],
      { cwd: siteRoot, env },
    );
    if (!existingPullRequest) {
      throw new Error(
        `existing Site publication branch ${branch} has no pull request`,
      );
    }
    return existingPullRequest;
  }
  run('git', ['switch', '-c', branch], { cwd: siteRoot, env });
  run('node', importArgs, { cwd: siteRoot, env });
  const changes = run('git', ['status', '--short'], { cwd: siteRoot, env });
  if (!changes) return '';
  run('git', ['add', 'public'], { cwd: siteRoot, env });
  run(
    'git',
    ['commit', '-s', '-m', `release(site): publish Kungfu Alpha ${version}`],
    { cwd: siteRoot, env },
  );
  run('git', ['push', 'origin', `HEAD:${branch}`], {
    cwd: siteRoot,
    env,
  });
  return run(
    'gh',
    [
      'pr',
      'create',
      '--repo',
      SITE_REPOSITORY,
      '--base',
      'main',
      '--head',
      branch,
      '--title',
      `release(site): publish Kungfu Alpha ${version}`,
      '--body',
      [
        'Buildchain final publication commit.',
        '',
        `- Source: \`${sourceSha}\``,
        `- Channel root: \`${prepared.channelIndex.payloadRoot}\``,
        '- Immutable installers and channel snapshot are append-only.',
        '- Merge only after exact-head review; production deployment remains protected.',
      ].join('\n'),
    ],
    { cwd: siteRoot, env },
  );
}

async function waitForReadback(
  expected,
  {
    timeoutMs = Number(
      process.env.KUNGFU_PUBLICATION_READBACK_TIMEOUT_MS || 6 * 60 * 60 * 1000,
    ),
    intervalMs = Number(
      process.env.KUNGFU_PUBLICATION_READBACK_INTERVAL_MS || 30_000,
    ),
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = 'not observed';
  while (Date.now() < deadline) {
    try {
      const observed = await fetchChannel();
      if (observed?.equals(expected)) return observed;
      last = observed ? `sha256:${sha256(observed).slice(7)}` : 'HTTP 404';
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`canonical Alpha read-back timed out; last state: ${last}`);
}

async function provePriorUpgrade({ previous, current, temporaryRoot }) {
  if (!previous) return 'not-applicable:first-publication';
  const installerUrl =
    `${CANONICAL_BASE_URL}/installers/v1/alpha/` +
    `${previous.index.payloadRoot.slice(7, 23)}/install.sh`;
  const response = await fetch(installerUrl, {
    cache: 'no-store',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `previous immutable installer returned HTTP ${response.status}`,
    );
  }
  const script = path.join(temporaryRoot, 'previous-install.sh');
  fs.writeFileSync(script, Buffer.from(await response.arrayBuffer()), {
    mode: 0o700,
  });
  const home = path.join(temporaryRoot, 'prior-home');
  const install = path.join(home, 'product');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home };
  run(
    '/bin/sh',
    [
      script,
      '--install-dir',
      install,
      '--bin-dir',
      bin,
      '--no-path',
      '--yes',
      '--ci',
    ],
    { cwd: temporaryRoot, env },
  );
  const discovery = JSON.parse(
    run(path.join(bin, 'kungfu'), ['update', '--check', '--json'], {
      cwd: temporaryRoot,
      env,
    }),
  );
  if (
    discovery.plan?.targetVersion !==
      current.index.entries[0]?.manifest?.productVersion ||
    discovery.plan?.releasePayloadRoot !== current.index.payloadRoot
  ) {
    throw new Error(
      'previous immutable installer did not discover the exact new Alpha authority',
    );
  }
  return 'passed:previous-immutable-installer-to-current-channel';
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
    outputDir: path.join(temporaryRoot, 'prepared'),
    now: publicationTimestamp(
      readJson(environment.releasePassportPath, 'final release passport'),
    ),
  });
  ensureLauncherTag(environment);
  const pullRequest = sitePullRequest({
    ...environment,
    prepared,
    temporaryRoot,
  });
  await waitForReadback(prepared.channelBytes);
  const current = {
    bytes: prepared.channelBytes,
    index: prepared.channelIndex,
  };
  const priorUpgrade = await provePriorUpgrade({
    previous,
    current,
    temporaryRoot,
  });
  const evidence = publicationCommitEvidence({
    ...environment,
    payloadRoot: prepared.channelIndex.payloadRoot,
    previousPayloadRoot: previous?.index.payloadRoot,
    sitePullRequest: pullRequest || 'already-projected-on-site-main',
    priorUpgrade,
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
      sitePullRequest: evidence.publication.sitePullRequest,
      priorUpgrade,
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
