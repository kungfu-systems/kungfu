// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const START = '<!-- kungfu:auditable-demo:start -->';
const END = '<!-- kungfu:auditable-demo:end -->';
const INSERT_BEFORE = '## Kungfu in the Agent Supply Chain';
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(`auditable-demo README: ${message}`);
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
    expiresAt: requiredString(value.expiresAt, `${label} artifact expiry`),
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
  };
}

export function renderAuditableDemoBlock(value) {
  const evidence = validatePublicEvidence(value);
  const shortSource = evidence.sourceSha.slice(0, 12);
  return [
    START,
    '### Auditable exact-output demo',
    '',
    'A selectively rendered demo now comes from one exact retained Linux build artifact:',
    'the installed `kungfu` launcher produced the transcript, the required Buildchain Gate',
    'qualified it, and full media rendered only from that passing Gate.',
    '',
    `[Open the demo and evidence](https://kungfu.tech/#auditable-demo) · [source \`${shortSource}\`](https://github.com/kungfu-systems/kungfu/commit/${evidence.sourceSha}) · [workflow run](${evidence.workflowUrl})`,
    '',
    `[Gate bundle](${evidence.gate.artifact.url}) \`${evidence.gate.root}\` · [media bundle](${evidence.media.artifact.url}) \`${evidence.media.root}\` · [Release Passport](${evidence.passport.artifact.url}) \`${evidence.passport.root}\``,
    '',
    'This proves exact installed-artifact execution and the named Gate/render path only.',
    'It is not a continuity, provider-migration, macOS, durability, performance, FO10,',
    'or production-deployment claim.',
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
  const mode = values.has('--write')
    ? 'write'
    : values.has('--check')
      ? 'check'
      : '';
  const readme = values.get('--readme');
  const evidence = values.get('--evidence');
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
  const current = fs.readFileSync(options.readme, 'utf8');
  const evidence = JSON.parse(fs.readFileSync(options.evidence, 'utf8'));
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
