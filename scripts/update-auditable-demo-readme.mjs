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
const DEMO_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const EVIDENCE_CLASS_PATTERN = /^[a-z0-9][a-z0-9._/-]*\/v[1-9][0-9]*$/u;
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
  'demo-720p.mp4',
  'demo-720p.webm',
  'demo.gif',
  'demo.mp4',
  'demo.webm',
  'gate-receipt.json',
  'manifest.json',
  'media-inspection.json',
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

function optionalRenditionAuthority(value) {
  if (value === undefined) return null;
  const frameSets = value?.frameSets;
  if (
    value?.policy !== 'independent-native-frame-sets/v1' ||
    !Array.isArray(frameSets) ||
    frameSets.length !== 2 ||
    frameSets[0]?.role !== 'primary' ||
    frameSets[0]?.width !== 1920 ||
    frameSets[0]?.height !== 1080 ||
    !DIGEST_PATTERN.test(frameSets[0]?.captureRoot || '') ||
    frameSets[1]?.role !== 'responsive' ||
    frameSets[1]?.width !== 1280 ||
    frameSets[1]?.height !== 720 ||
    !DIGEST_PATTERN.test(frameSets[1]?.captureRoot || '') ||
    frameSets[0].captureRoot === frameSets[1].captureRoot
  ) {
    fail('native rendition authority is invalid');
  }
  return {
    policy: value.policy,
    frameSets: frameSets.map(({ role, width, height, captureRoot }) => ({
      role,
      width,
      height,
      captureRoot,
    })),
  };
}

export function validatePublicEvidence(value) {
  const version =
    value?.schema === 'kungfu.auditable-demo.public-evidence/v2' ? 2 : 1;
  if (
    !value ||
    ![
      'kungfu.auditable-demo.public-evidence/v1',
      'kungfu.auditable-demo.public-evidence/v2',
    ].includes(value.schema) ||
    value.status !== 'qualified'
  ) {
    fail('public evidence schema or status is invalid');
  }
  const demo =
    version === 2
      ? {
          id: requiredString(value.demo?.id, 'demo id', DEMO_ID_PATTERN),
          catalogRoot: requiredString(
            value.demo?.catalogRoot,
            'demo catalog root',
            DIGEST_PATTERN,
          ),
          descriptorRoot: requiredString(
            value.demo?.descriptorRoot,
            'demo descriptor root',
            DIGEST_PATTERN,
          ),
          commandLabel: requiredString(
            value.demo?.commandLabel,
            'demo command label',
            /^kungfu [^\r\n]+$/u,
          ),
          evidenceClass: requiredString(
            value.demo?.evidenceClass,
            'demo evidence class',
            EVIDENCE_CLASS_PATTERN,
          ),
          sceneId: requiredString(
            value.demo?.sceneId,
            'demo scene id',
            DEMO_ID_PATTERN,
          ),
          publication: {
            readmeFeatured: value.demo?.publication?.readmeFeatured,
            siteSlug: requiredString(
              value.demo?.publication?.siteSlug,
              'demo site slug',
              DEMO_ID_PATTERN,
            ),
          },
        }
      : {
          id: 'agent-work-lab',
          catalogRoot: null,
          descriptorRoot: null,
          commandLabel: 'kungfu agent-work-lab autoplay',
          evidenceClass: 'exact-installed-artifact-agent-work-lab-autoplay/v1',
          sceneId: 'kungfu-agent-work-lab-autoplay',
          publication: {
            readmeFeatured: true,
            siteSlug: 'agent-work-lab',
          },
        };
  if (
    typeof demo.publication.readmeFeatured !== 'boolean' ||
    (version === 2 && demo.evidenceClass !== value.evidenceClass)
  ) {
    fail('demo publication or evidence-class binding is invalid');
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
  const mediaProfile = requiredString(
    value.media?.profile,
    'media profile',
    /^responsive-web-delivery-v1$/u,
  );
  const mediaQualificationRoot = requiredString(
    value.media?.qualificationRoot,
    'media qualification root',
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
  const evidenceClass = requiredString(
    value.evidenceClass,
    'evidence class',
    EVIDENCE_CLASS_PATTERN,
  );
  if (evidenceClass !== demo.evidenceClass) {
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
  const renditionAuthority = optionalRenditionAuthority(
    value.renditionAuthority,
  );
  const readmeMedia = {
    path: requiredString(
      value.readmeMedia?.path,
      'README media path',
      /^docs\/qualification\/evidence\/auditable-demo\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[0-9a-f]{64}\/demo\.gif$/u,
    ),
    digest: requiredString(
      value.readmeMedia?.digest,
      'README media digest',
      DIGEST_PATTERN,
    ),
  };
  const mediaPrefix =
    demo.id === 'agent-work-lab' && demo.publication.readmeFeatured
      ? ''
      : `${demo.publication.siteSlug}/`;
  const expectedMediaPath =
    `docs/qualification/evidence/auditable-demo/${mediaPrefix}` +
    `${passportRoot.slice(7)}/demo.gif`;
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
    media: {
      root: mediaRoot,
      artifact: mediaArtifact,
      profile: mediaProfile,
      qualificationRoot: mediaQualificationRoot,
    },
    passport: { root: passportRoot, artifact: passportArtifact },
    demo,
    evidenceClass,
    claims: value.claims,
    nonClaims: value.nonClaims,
    authorization,
    renditionAuthority,
    readmeMedia,
  };
}

export function verifyMediaBundle(mediaDirectory, passport) {
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
    receipt.schema !== 'buildchain.auditable-demo-media/v2' ||
    receipt.status !== 'passed' ||
    receipt.sourceSha !== passport.source.sha ||
    receipt.qualifiedGateRoot !== passport.gate.root ||
    receipt.rendererImage !== passport.toolchain.rendererImage ||
    receipt.qualification?.profile?.id !== passport.media.profile ||
    receipt.qualificationRoot !== passport.media.qualificationRoot ||
    receipt.qualification?.qualificationRoot !== receipt.qualificationRoot
  ) {
    fail('media receipt does not bind the Passport');
  }
  const { qualificationRoot, ...qualificationBody } = receipt.qualification;
  if (
    qualificationRoot !== sha256(Buffer.from(stableJson(qualificationBody)))
  ) {
    fail('media qualification root does not verify');
  }
  const renditions = receipt.qualification.renditions;
  if (!Array.isArray(renditions)) {
    fail('media qualification renditions are missing');
  }
  const roles = new Map();
  for (const rendition of renditions) {
    if (
      !rendition ||
      typeof rendition.role !== 'string' ||
      typeof rendition.path !== 'string' ||
      !MEDIA_MEMBERS.includes(rendition.path) ||
      rendition.path === 'checksums.sha256' ||
      roles.has(rendition.role) ||
      !DIGEST_PATTERN.test(rendition.root || '')
    ) {
      fail('media qualification role mapping is invalid');
    }
    const bytes = readRegular(
      path.join(mediaDirectory, rendition.path),
      rendition.role,
    );
    if (rendition.root !== sha256(bytes) || rendition.bytes !== bytes.length) {
      fail(`media qualification drifted for role ${rendition.role}`);
    }
    roles.set(rendition.role, { ...rendition, bytes });
  }
  const readmeRendition = roles.get('readme-compatibility');
  if (
    !readmeRendition ||
    readmeRendition.mimeType !== 'image/gif' ||
    readmeRendition.width !== 1280 ||
    readmeRendition.height !== 720 ||
    readmeRendition.dimensionPolicy !== 'exact-downscale-same-aspect'
  ) {
    fail('README compatibility rendition is not qualified at 1280x720');
  }
  const manifest = JSON.parse(
    readRegular(
      path.join(mediaDirectory, 'manifest.json'),
      'renderer manifest',
    ).toString('utf8'),
  );
  const nativeInputs = manifest.inputs?.renditions;
  const nativeFrameSets = manifest.derivation?.sourceFrameSets;
  if (
    manifest.schema !== 'build-images.auditable-demo-render/v1' ||
    manifest.renderer?.image !== passport.toolchain.rendererImage ||
    manifest.policy?.evidenceClass !== passport.authority.evidenceClass ||
    manifest.policy?.visualClassification !== 'bounded-pty-replay' ||
    manifest.policy?.runtimeTextAuthority !== 'rendition-set.json' ||
    manifest.inputs?.renditionSet?.schema !==
      'kungfu.auditable-demo.rendition-set/v1' ||
    !DIGEST_PATTERN.test(manifest.inputs?.renditionSet?.root || '') ||
    manifest.derivation?.authority !== 'rendition-set.json' ||
    manifest.derivation?.policy !== 'independent-native-frame-sets/v1'
  ) {
    fail('renderer manifest does not prove the qualified native PTY replay');
  }
  if (
    !Array.isArray(nativeInputs) ||
    nativeInputs.length !== 2 ||
    nativeInputs[0]?.role !== 'primary' ||
    nativeInputs[0]?.terminalCapture?.dimensions?.columns !== 150 ||
    nativeInputs[0]?.terminalCapture?.dimensions?.rows !== 36 ||
    !DIGEST_PATTERN.test(nativeInputs[0]?.terminalCapture?.root || '') ||
    nativeInputs[1]?.role !== 'responsive' ||
    nativeInputs[1]?.terminalCapture?.dimensions?.columns !== 100 ||
    nativeInputs[1]?.terminalCapture?.dimensions?.rows !== 28 ||
    !DIGEST_PATTERN.test(nativeInputs[1]?.terminalCapture?.root || '') ||
    nativeInputs[0].terminalCapture.root ===
      nativeInputs[1].terminalCapture.root
  ) {
    fail('renderer inputs do not bind two distinct native terminal captures');
  }
  if (
    !Array.isArray(nativeFrameSets) ||
    nativeFrameSets.length !== 2 ||
    nativeFrameSets[0]?.role !== 'primary' ||
    nativeFrameSets[0]?.width !== 1920 ||
    nativeFrameSets[0]?.height !== 1080 ||
    nativeFrameSets[0]?.captureRoot !== nativeInputs[0].terminalCapture.root ||
    nativeFrameSets[1]?.role !== 'responsive' ||
    nativeFrameSets[1]?.width !== 1280 ||
    nativeFrameSets[1]?.height !== 720 ||
    nativeFrameSets[1]?.captureRoot !== nativeInputs[1].terminalCapture.root
  ) {
    fail('renderer derivation does not bind the required native frame sets');
  }
  for (const rendition of roles.values()) {
    const derivation = manifest.derivation?.renditions?.[rendition.path];
    if (
      !derivation ||
      derivation.width !== rendition.width ||
      derivation.height !== rendition.height ||
      derivation.operation !== 'native-frame-set-encode'
    ) {
      fail(`renderer derivation is invalid for role ${rendition.role}`);
    }
  }
  return {
    gif: readmeRendition.bytes,
    nativeFrameSets: nativeFrameSets.map(
      ({ role, width, height, captureRoot }) => ({
        role,
        width,
        height,
        captureRoot,
      }),
    ),
  };
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
  const passportNamePrefix =
    passport.demo.id === 'agent-work-lab'
      ? 'kungfu-auditable-demo-passport'
      : `kungfu-auditable-demo-passport-${passport.demo.id}`;
  const expectedName =
    `${passportNamePrefix}-${passport.source.sha}-` +
    `${passport.workflow.runId}-${passport.workflow.runAttempt}`;
  if (
    exactPassportArtifact.name !== expectedName ||
    exactPassportArtifact.url !==
      `${passport.workflow.url}/artifacts/${exactPassportArtifact.id}`
  ) {
    fail('Passport artifact is not bound to the exact workflow run');
  }
  const { gif, nativeFrameSets } = verifyMediaBundle(mediaDirectory, passport);
  const rootName = passport.root.value.slice(7);
  const mediaPrefix =
    passport.demo.id === 'agent-work-lab' &&
    passport.demo.publication.readmeFeatured
      ? ''
      : `${passport.demo.publication.siteSlug}/`;
  return {
    evidence: {
      schema: 'kungfu.auditable-demo.public-evidence/v2',
      status: 'qualified',
      demo: passport.demo,
      sourceSha: passport.source.sha,
      workflowUrl: passport.workflow.url,
      buildchainSha: passport.toolchain.buildchainSha,
      rendererImage: passport.toolchain.rendererImage,
      gate: passport.gate,
      media: passport.media,
      renditionAuthority: {
        policy: 'independent-native-frame-sets/v1',
        frameSets: nativeFrameSets,
      },
      passport: {
        root: passport.root.value,
        artifact: exactPassportArtifact,
      },
      evidenceClass: passport.authority.evidenceClass,
      claims: passport.authority.claims,
      nonClaims: passport.authority.nonClaims,
      authorization: passport.authority.authorization,
      readmeMedia: {
        path:
          `docs/qualification/evidence/auditable-demo/${mediaPrefix}` +
          `${rootName}/demo.gif`,
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
  const directory = path.dirname(
    path.resolve(repoRoot, projected.evidence.readmeMedia.path),
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
  if (!evidence.demo.publication.readmeFeatured) {
    fail('only the catalog-selected README demo can update the managed block');
  }
  const shortSource = evidence.sourceSha.slice(0, 12);
  const nativeRenditionLine =
    evidence.renditionAuthority?.policy === 'independent-native-frame-sets/v1'
      ? 'The 1080p and 720p renditions come from independent native PTY captures, not scaling.'
      : '';
  return [
    START,
    '## See a fresh Agent continue the same Work',
    '',
    '**One Work. Two fresh Agent processes. No copied chat.**',
    '',
    'Session 1 stops with a partial result. Session 2 starts without the previous',
    'conversation, recovers what was done and what remains, then finishes the same Work.',
    '',
    `[![Kungfu Agent Work Lab showing a fresh Agent continuing the same Work without copied chat](${evidence.readmeMedia.path})](docs/qualification/auditable-demo-artifact-pipeline.md)`,
    '',
    '<details>',
    '<summary>How this exact installed-artifact demo was verified</summary>',
    '',
    'This selectively rendered demo comes from one exact retained Linux build artifact.',
    `The installed \`${evidence.demo.commandLabel}\` command ran in a bounded PTY, the`,
    'required Buildchain Gate qualified its exact capture, and full media rendered only',
    'from that passing Gate.',
    ...(nativeRenditionLine ? [nativeRenditionLine] : []),
    '',
    `[Method and evidence](docs/qualification/auditable-demo-artifact-pipeline.md) · [source \`${shortSource}\`](https://github.com/kungfu-systems/kungfu/commit/${evidence.sourceSha}) · [workflow run](${evidence.workflowUrl})`,
    '',
    `[Gate bundle](${evidence.gate.artifact.url}) \`${evidence.gate.root}\` · [media bundle](${evidence.media.artifact.url}) \`${evidence.media.root}\` · [Release Passport](${evidence.passport.artifact.url}) \`${evidence.passport.root}\``,
    '',
    `Evidence class: \`${evidence.evidenceClass}\`. This proves only the exact`,
    'installed-artifact autoplay and named Gate/render path. The demo grants no',
    'authorization from first-party/System identity, KFD compliance, Product System',
    'metadata, local bundle presence, package metadata, registry history, scan output,',
    'or standalone generation, and makes no production-deployment claim.',
    '',
    '</details>',
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
