// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { stableJson, verifyPassport } from './auditable-demo-passport.mjs';

const START = '<!-- kungfu:auditable-demo:start -->';
const END = '<!-- kungfu:auditable-demo:end -->';
const INSERT_BEFORE = '## Kungfu in the Agent Supply Chain';
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const EVIDENCE_CLASS = 'exact-installed-artifact-agent-work-lab-autoplay/v1';
const REQUIRED_AUTHORIZATION_SOURCES = [
  'exact-release-passport',
  'core-policy',
  'work-or-warrant',
  'explicit-capability-grant',
  'runtime-isolation',
];
const NON_AUTHORITIES = [
  'first-party-identity',
  'system-identity',
  'kfd-compliance',
  'product-system-metadata',
  'local-bundle-presence',
  'package-metadata',
  'registry-history',
  'scan-output',
  'standalone-generation',
];
const MEDIA_MEMBERS = [
  'checksums.sha256',
  'complete-transcript.txt',
  'demo.gif',
  'demo.mp4',
  'demo.webm',
  'gate-receipt.json',
  'manifest.json',
  'media-probe.json',
  'media-receipt.json',
  'poster.png',
  'public-projection.json',
  'renderer-checksums.sha256',
  'scene.json',
];

function fail(message) {
  throw new Error(`auditable-demo README: ${message}`);
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function readRegular(filePath, label, maximum = 64 * 1024 * 1024) {
  const metadata = fs.lstatSync(filePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > maximum
  ) {
    fail(`${label} must be a bounded regular non-symlink file`);
  }
  return fs.readFileSync(filePath);
}

function requiredStringArray(value, expected, label) {
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function requiredString(value, label, pattern) {
  if (
    typeof value !== 'string' ||
    !value ||
    (pattern && !pattern.test(value))
  ) {
    fail(`${label} is missing or invalid`);
  }
  return value;
}

function exactArtifact(value, label) {
  if (!value || typeof value !== 'object') {
    fail(`${label} artifact is missing`);
  }
  const expiresAt = requiredString(value.expiresAt, `${label} artifact expiry`);
  const expiry = Date.parse(expiresAt);
  if (
    !Number.isFinite(expiry) ||
    expiry <= Date.parse('2020-01-01T00:00:00Z')
  ) {
    fail(`${label} artifact expiry is invalid`);
  }
  return {
    id: requiredString(value.id, `${label} artifact id`, /^[1-9][0-9]*$/u),
    name: requiredString(
      value.name,
      `${label} artifact name`,
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u,
    ),
    digest: requiredString(
      value.digest,
      `${label} artifact digest`,
      DIGEST_PATTERN,
    ),
    url: requiredString(
      value.url,
      `${label} artifact URL`,
      /^https:\/\/github\.com\/kungfu-systems\/kungfu\/actions\/runs\/[1-9][0-9]*\/artifacts\/[1-9][0-9]*$/u,
    ),
    expiresAt: new Date(expiry).toISOString(),
  };
}

export function validatePublicEvidence(value) {
  if (
    !value ||
    value.schema !== 'kungfu.auditable-demo.public-evidence/v1' ||
    value.status !== 'qualified'
  ) {
    fail('public evidence schema or status is invalid');
  }
  const sourceSha = requiredString(value.sourceSha, 'source SHA', SHA_PATTERN);
  const workflowUrl = requiredString(
    value.workflowUrl,
    'workflow URL',
    /^https:\/\/github\.com\/kungfu-systems\/kungfu\/actions\/runs\/[1-9][0-9]*$/u,
  );
  const buildchainSha = requiredString(
    value.buildchainSha,
    'Buildchain SHA',
    SHA_PATTERN,
  );
  const rendererImage = requiredString(
    value.rendererImage,
    'renderer image',
    /^ghcr\.io\/kungfu-systems\/build-images\/demo-renderer@sha256:[0-9a-f]{64}$/u,
  );
  const gateRoot = requiredString(
    value.gate?.root,
    'Gate root',
    DIGEST_PATTERN,
  );
  const mediaRoot = requiredString(
    value.media?.root,
    'media root',
    DIGEST_PATTERN,
  );
  const passportRoot = requiredString(
    value.passport?.root,
    'Passport root',
    DIGEST_PATTERN,
  );
  const gateArtifact = exactArtifact(value.gate?.artifact, 'Gate');
  const mediaArtifact = exactArtifact(value.media?.artifact, 'media');
  const passportArtifact = exactArtifact(value.passport?.artifact, 'Passport');
  const evidenceClass = requiredString(value.evidenceClass, 'evidence class');
  if (evidenceClass !== EVIDENCE_CLASS) {
    fail('evidence class is invalid');
  }
  if (
    !Array.isArray(value.claims) ||
    value.claims.length < 1 ||
    value.claims.some((claim) => typeof claim !== 'string' || !claim)
  ) {
    fail('claims are invalid');
  }
  if (
    !Array.isArray(value.nonClaims) ||
    value.nonClaims.length < 1 ||
    value.nonClaims.some((claim) => typeof claim !== 'string' || !claim)
  ) {
    fail('non-claims are invalid');
  }
  if (value.authorization?.status !== 'not-granted-by-demo') {
    fail('authorization status is invalid');
  }
  const authorization = {
    status: value.authorization.status,
    requiredSources: requiredStringArray(
      value.authorization.requiredSources,
      REQUIRED_AUTHORIZATION_SOURCES,
      'authorization sources',
    ),
    nonAuthorities: requiredStringArray(
      value.authorization.nonAuthorities,
      NON_AUTHORITIES,
      'authorization non-authorities',
    ),
  };
  const readmeMedia = {
    path: requiredString(
      value.readmeMedia?.path,
      'README media path',
      /^docs\/qualification\/evidence\/auditable-demo\/[0-9a-f]{64}\/demo\.gif$/u,
    ),
    digest: requiredString(
      value.readmeMedia?.digest,
      'README media digest',
      DIGEST_PATTERN,
    ),
  };
  const expectedMediaPath = `docs/qualification/evidence/auditable-demo/${passportRoot.slice(7)}/demo.gif`;
  if (readmeMedia.path !== expectedMediaPath) {
    fail('README media path is not bound to the Passport root');
  }
  const workflowRunPrefix = `${workflowUrl}/artifacts/`;
  for (const artifact of [gateArtifact, mediaArtifact, passportArtifact]) {
    if (!artifact.url.startsWith(workflowRunPrefix)) {
      fail('all artifacts must belong to the exact qualified workflow run');
    }
  }
  return {
    sourceSha,
    workflowUrl,
    buildchainSha,
    rendererImage,
    gate: { root: gateRoot, artifact: gateArtifact },
    media: { root: mediaRoot, artifact: mediaArtifact },
    passport: { root: passportRoot, artifact: passportArtifact },
    evidenceClass,
    claims: value.claims,
    nonClaims: value.nonClaims,
    authorization,
    readmeMedia,
  };
}

function verifyMediaBundle(mediaDirectory, passport) {
  const members = fs
    .readdirSync(mediaDirectory, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        fail(`unexpected media member: ${entry.name}`);
      }
      return entry.name;
    })
    .sort();
  if (JSON.stringify(members) !== JSON.stringify(MEDIA_MEMBERS)) {
    fail('media bundle member set is not exact');
  }
  const checksums = readRegular(
    path.join(mediaDirectory, 'checksums.sha256'),
    'media checksums',
  );
  if (sha256(checksums) !== passport.media.root) {
    fail('media root does not match the Passport');
  }
  const declared = [];
  for (const row of checksums.toString('utf8').trimEnd().split('\n')) {
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/u.exec(row);
    if (!match || match[2] === 'checksums.sha256') {
      fail(`invalid media checksum row: ${row}`);
    }
    if (declared.includes(match[2])) {
      fail(`duplicate media checksum member: ${match[2]}`);
    }
    declared.push(match[2]);
    if (
      sha256(readRegular(path.join(mediaDirectory, match[2]), match[2])).slice(
        7,
      ) !== match[1]
    ) {
      fail(`media checksum mismatch: ${match[2]}`);
    }
  }
  if (
    JSON.stringify(declared.sort()) !==
    JSON.stringify(MEDIA_MEMBERS.filter((name) => name !== 'checksums.sha256'))
  ) {
    fail('media checksums do not cover every member exactly once');
  }
  const receipt = JSON.parse(
    readRegular(
      path.join(mediaDirectory, 'media-receipt.json'),
      'media receipt',
    ).toString('utf8'),
  );
  if (
    receipt.schema !== 'buildchain.auditable-demo-media/v1' ||
    receipt.status !== 'passed' ||
    receipt.sourceSha !== passport.source.sha ||
    receipt.qualifiedGateRoot !== passport.gate.root ||
    receipt.rendererImage !== passport.toolchain.rendererImage
  ) {
    fail('media receipt does not bind the Passport');
  }
  const manifest = JSON.parse(
    readRegular(
      path.join(mediaDirectory, 'manifest.json'),
      'renderer manifest',
    ).toString('utf8'),
  );
  if (
    manifest.schema !== 'build-images.auditable-demo-render/v1' ||
    manifest.renderer?.image !== passport.toolchain.rendererImage ||
    manifest.policy?.evidenceClass !== passport.authority.evidenceClass ||
    manifest.policy?.visualClassification !== 'bounded-pty-replay' ||
    manifest.policy?.runtimeTextAuthority !== 'terminal-capture.json' ||
    !DIGEST_PATTERN.test(manifest.inputs?.terminalCapture?.root || '')
  ) {
    fail('renderer manifest does not prove the qualified PTY replay');
  }
  return readRegular(
    path.join(mediaDirectory, 'demo.gif'),
    'README GIF',
    10 * 1024 * 1024,
  );
}

export function buildPublicEvidence({
  passport,
  passportArtifact,
  mediaDirectory,
}) {
  verifyPassport(passport);
  if (passport.media?.status !== 'rendered') {
    fail('Passport does not contain rendered media');
  }
  const exactPassportArtifact = exactArtifact(passportArtifact, 'Passport');
  const expectedName =
    `kungfu-auditable-demo-passport-${passport.source.sha}-` +
    `${passport.workflow.runId}-${passport.workflow.runAttempt}`;
  if (
    exactPassportArtifact.name !== expectedName ||
    exactPassportArtifact.url !==
      `${passport.workflow.url}/artifacts/${exactPassportArtifact.id}`
  ) {
    fail('Passport artifact is not bound to the exact workflow run');
  }
  const gif = verifyMediaBundle(mediaDirectory, passport);
  const rootName = passport.root.value.slice(7);
  return {
    evidence: {
      schema: 'kungfu.auditable-demo.public-evidence/v1',
      status: 'qualified',
      sourceSha: passport.source.sha,
      workflowUrl: passport.workflow.url,
      buildchainSha: passport.toolchain.buildchainSha,
      rendererImage: passport.toolchain.rendererImage,
      gate: passport.gate,
      media: passport.media,
      passport: {
        root: passport.root.value,
        artifact: exactPassportArtifact,
      },
      evidenceClass: passport.authority.evidenceClass,
      claims: passport.authority.claims,
      nonClaims: passport.authority.nonClaims,
      authorization: passport.authority.authorization,
      readmeMedia: {
        path: `docs/qualification/evidence/auditable-demo/${rootName}/demo.gif`,
        digest: sha256(gif),
      },
    },
    gif,
  };
}

function writeExclusiveOrEqual(filePath, bytes, label) {
  if (fs.existsSync(filePath)) {
    if (!readRegular(filePath, label).equals(bytes)) {
      fail(`${label} already exists with different bytes`);
    }
    return;
  }
  fs.writeFileSync(filePath, bytes, { flag: 'wx', mode: 0o644 });
}

export function materializePublicEvidence({
  repoRoot,
  passportPath,
  passportArtifactPath,
  mediaDirectory,
}) {
  const passport = JSON.parse(
    readRegular(passportPath, 'Passport').toString('utf8'),
  );
  const passportArtifact = JSON.parse(
    readRegular(passportArtifactPath, 'Passport artifact coordinate').toString(
      'utf8',
    ),
  );
  const projected = buildPublicEvidence({
    passport,
    passportArtifact,
    mediaDirectory,
  });
  const directory = path.resolve(
    repoRoot,
    'docs/qualification/evidence/auditable-demo',
    passport.root.value.slice(7),
  );
  if (!directory.startsWith(`${path.resolve(repoRoot)}${path.sep}`)) {
    fail('content-addressed evidence path escapes the repository');
  }
  fs.mkdirSync(directory, { recursive: true });
  const gifPath = path.join(directory, 'demo.gif');
  const evidencePath = path.join(directory, 'public-evidence.json');
  writeExclusiveOrEqual(gifPath, projected.gif, 'README GIF');
  writeExclusiveOrEqual(
    evidencePath,
    Buffer.from(stableJson(projected.evidence)),
    'public evidence',
  );
  return { gifPath, evidencePath, evidence: projected.evidence };
}

export function verifyReadmeMediaFile(repoRoot, value) {
  const evidence = validatePublicEvidence(value);
  const mediaPath = path.resolve(repoRoot, evidence.readmeMedia.path);
  if (!mediaPath.startsWith(`${repoRoot}${path.sep}`)) {
    fail('README media path escapes the repository');
  }
  const metadata = fs.lstatSync(mediaPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 10 * 1024 * 1024
  ) {
    fail('README media must be a bounded regular non-symlink file');
  }
  const digest = sha256(fs.readFileSync(mediaPath));
  if (digest !== evidence.readmeMedia.digest) {
    fail('README media digest does not match public evidence');
  }
  return evidence;
}

export function renderAuditableDemoBlock(value) {
  const evidence = validatePublicEvidence(value);
  const shortSource = evidence.sourceSha.slice(0, 12);
  return [
    START,
    '## Auditable exact-output demo',
    '',
    'A selectively rendered demo now comes from one exact retained Linux build artifact:',
    'the installed `kungfu agent-work-lab autoplay` command ran in a bounded PTY,',
    'the required Buildchain Gate qualified its exact capture, and full media rendered',
    'only from that passing Gate.',
    '',
    `[![Animated Kungfu terminal demo produced from the exact installed Linux artifact](${evidence.readmeMedia.path})](docs/qualification/auditable-demo-artifact-pipeline.md)`,
    '',
    `[Read the method and evidence](docs/qualification/auditable-demo-artifact-pipeline.md) · [source \`${shortSource}\`](https://github.com/kungfu-systems/kungfu/commit/${evidence.sourceSha}) · [workflow run](${evidence.workflowUrl})`,
    '',
    `[Gate bundle](${evidence.gate.artifact.url}) \`${evidence.gate.root}\` · [media bundle](${evidence.media.artifact.url}) \`${evidence.media.root}\` · [Release Passport](${evidence.passport.artifact.url}) \`${evidence.passport.root}\``,
    '',
    `Evidence class: \`${evidence.evidenceClass}\`. This proves only the exact`,
    'installed-artifact autoplay and named Gate/render path. The demo grants no',
    'authorization from first-party/System identity, KFD compliance, Product System',
    'metadata, local bundle presence, package metadata, registry history, scan output,',
    'or standalone generation, and makes no production-deployment claim.',
    END,
  ].join('\n');
}

export function updateReadme(readme, value) {
  const block = renderAuditableDemoBlock(value);
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start >= 0 !== end >= 0 || (start >= 0 && end < start)) {
    fail('managed block markers are malformed');
  }
  if (start >= 0) {
    const after = end + END.length;
    if (readme.indexOf(START, start + START.length) >= 0) {
      fail('managed block appears more than once');
    }
    return `${readme.slice(0, start)}${block}${readme.slice(after)}`;
  }
  const insertion = readme.indexOf(INSERT_BEFORE);
  if (insertion < 0) {
    fail(`README insertion heading is missing: ${INSERT_BEFORE}`);
  }
  return `${readme.slice(0, insertion)}${block}\n\n${readme.slice(insertion)}`;
}

function parseCli(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    values.set(argv[index], argv[index + 1]);
  }
  const mode = values.has('--materialize')
    ? 'materialize'
    : values.has('--write')
      ? 'write'
      : values.has('--check')
        ? 'check'
        : '';
  const readme = values.get('--readme');
  const evidence = values.get('--evidence');
  if (mode === 'materialize') {
    if (
      values.size !== 5 ||
      values.get('--materialize') !== 'true' ||
      !values.get('--repo-root') ||
      !values.get('--passport') ||
      !values.get('--passport-artifact') ||
      !values.get('--media-bundle')
    ) {
      fail(
        'usage: update-auditable-demo-readme.mjs --materialize true --repo-root PATH --passport PATH --passport-artifact PATH --media-bundle DIR',
      );
    }
    return {
      mode,
      repoRoot: path.resolve(values.get('--repo-root')),
      passport: path.resolve(values.get('--passport')),
      passportArtifact: path.resolve(values.get('--passport-artifact')),
      mediaBundle: path.resolve(values.get('--media-bundle')),
    };
  }
  if (
    !mode ||
    !readme ||
    !evidence ||
    values.size !== 3 ||
    values.get(`--${mode}`) !== 'true'
  ) {
    fail(
      'usage: update-auditable-demo-readme.mjs --readme PATH --evidence PATH --write true | --check true',
    );
  }
  return {
    mode,
    readme: path.resolve(readme),
    evidence: path.resolve(evidence),
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.mode === 'materialize') {
    const result = materializePublicEvidence({
      repoRoot: options.repoRoot,
      passportPath: options.passport,
      passportArtifactPath: options.passportArtifact,
      mediaDirectory: options.mediaBundle,
    });
    process.stdout.write(
      `auditable-demo public evidence materialized: ${result.evidencePath}\n`,
    );
    return;
  }
  const current = fs.readFileSync(options.readme, 'utf8');
  const evidence = JSON.parse(fs.readFileSync(options.evidence, 'utf8'));
  verifyReadmeMediaFile(path.dirname(options.readme), evidence);
  const expected = updateReadme(current, evidence);
  if (options.mode === 'check') {
    if (expected !== current) {
      fail('managed block is stale');
    }
    process.stdout.write('auditable-demo README block is current\n');
    return;
  }
  fs.writeFileSync(options.readme, expected);
  process.stdout.write('auditable-demo README block updated\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
