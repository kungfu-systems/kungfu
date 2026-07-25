// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ID_PATTERN = /^[1-9][0-9]*$/u;
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RENDERER_PATTERN =
  /^[a-z0-9][a-z0-9./_-]*@[sS][hH][aA]256:[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(`auditable-demo passport: ${message}`);
}

function required(env, name, pattern, label = name) {
  const value = env[name] || '';
  if (!value || (pattern && !pattern.test(value))) {
    fail(`${label} is missing or invalid`);
  }
  return value;
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function exactArtifact(
  env,
  prefix,
  repository,
  runId,
  requiredArtifact = true,
) {
  const values = {
    id: env[`${prefix}_ARTIFACT_ID`] || '',
    name: env[`${prefix}_ARTIFACT_NAME`] || '',
    digest: env[`${prefix}_ARTIFACT_DIGEST`] || '',
    url: env[`${prefix}_ARTIFACT_URL`] || '',
    expiresAt: env[`${prefix}_ARTIFACT_EXPIRES_AT`] || '',
  };
  const present = Object.values(values).filter(Boolean).length;
  if (!requiredArtifact && present === 0) {
    return null;
  }
  if (present !== Object.keys(values).length) {
    fail(`${prefix.toLowerCase()} artifact coordinate is partial`);
  }
  if (!ID_PATTERN.test(values.id)) {
    fail(`${prefix.toLowerCase()} artifact id is invalid`);
  }
  if (!ARTIFACT_NAME_PATTERN.test(values.name)) {
    fail(`${prefix.toLowerCase()} artifact name is invalid`);
  }
  if (!DIGEST_PATTERN.test(values.digest)) {
    fail(`${prefix.toLowerCase()} artifact digest is invalid`);
  }
  const expectedUrl = `https://github.com/${repository}/actions/runs/${runId}/artifacts/${values.id}`;
  if (values.url !== expectedUrl) {
    fail(
      `${prefix.toLowerCase()} artifact URL is not bound to the exact run and id`,
    );
  }
  const expiry = Date.parse(values.expiresAt);
  if (
    !Number.isFinite(expiry) ||
    expiry <= Date.parse('2020-01-01T00:00:00Z')
  ) {
    fail(`${prefix.toLowerCase()} artifact expiry is not an RFC3339 timestamp`);
  }
  return {
    ...values,
    expiresAt: new Date(expiry).toISOString(),
  };
}

function exactRoot(env, name, requiredRoot = true) {
  const value = env[name] || '';
  if (!requiredRoot && !value) {
    return null;
  }
  if (!DIGEST_PATTERN.test(value)) {
    fail(`${name.toLowerCase()} is invalid`);
  }
  return value;
}

export function buildPassport(env = process.env) {
  const repository = required(
    env,
    'GITHUB_REPOSITORY',
    REPOSITORY_PATTERN,
    'GitHub repository',
  );
  const runId = required(env, 'GITHUB_RUN_ID', ID_PATTERN, 'GitHub run id');
  const runAttempt = required(
    env,
    'GITHUB_RUN_ATTEMPT',
    ID_PATTERN,
    'GitHub run attempt',
  );
  const sourceSha = required(env, 'SOURCE_SHA', SHA_PATTERN, 'source SHA');
  const source = exactArtifact(env, 'SOURCE', repository, runId);
  const expectedSourceName = `kungfu-linux-x64-${sourceSha}`;
  if (source.name !== expectedSourceName) {
    fail(`source artifact name must equal ${expectedSourceName}`);
  }

  const gate = exactArtifact(env, 'GATE', repository, runId);
  const gateRoot = exactRoot(env, 'GATE_ROOT');
  if (
    !gate.name.startsWith(
      `auditable-demo-gate-${sourceSha.slice(0, 12)}-${gateRoot.slice(7, 23)}`,
    )
  ) {
    fail('Gate artifact name is not bound to the source SHA and Gate root');
  }

  const media = exactArtifact(env, 'MEDIA', repository, runId, false);
  const mediaRoot = exactRoot(env, 'MEDIA_ROOT', false);
  if (Boolean(media) !== Boolean(mediaRoot)) {
    fail('media artifact and media root must be present or absent together');
  }
  if (
    media &&
    !media.name.startsWith(
      `auditable-demo-media-${sourceSha.slice(0, 12)}-${mediaRoot.slice(7, 23)}`,
    )
  ) {
    fail('media artifact name is not bound to the source SHA and media root');
  }

  const buildchainSha = required(
    env,
    'BUILDCHAIN_SHA',
    SHA_PATTERN,
    'Buildchain SHA',
  );
  const rendererImage = required(
    env,
    'RENDERER_IMAGE',
    RENDERER_PATTERN,
    'renderer image',
  );
  const workflowUrl = `https://github.com/${repository}/actions/runs/${runId}`;

  const payload = {
    schema: 'kungfu.auditable-demo.release-passport/v1',
    status: 'qualified',
    source: {
      repository,
      sha: sourceSha,
      artifact: source,
    },
    gate: {
      status: 'passed',
      root: gateRoot,
      artifact: gate,
    },
    media: media
      ? {
          status: 'rendered',
          root: mediaRoot,
          artifact: media,
        }
      : {
          status: 'not-requested',
          root: null,
          artifact: null,
        },
    workflow: {
      repository,
      runId,
      runAttempt,
      url: workflowUrl,
    },
    toolchain: {
      buildchainSha,
      rendererImage,
    },
    authority: {
      evidenceClass: 'exact-installed-artifact-agent-brief/v1',
      publication: 'github-artifacts-only',
      productionDeployment: false,
      claims: [
        'The exact retained Linux artifact executed its installed kungfu launcher.',
        'The exact transcript, public projection, and scene passed the Buildchain Gate.',
      ],
      nonClaims: [
        'cross-run continuity',
        'provider migration',
        'macOS execution',
        'durability',
        'performance',
        'FO10',
      ],
    },
  };
  const payloadText = stableJson(payload);
  return {
    ...payload,
    root: {
      algorithm: 'sha256',
      profile: 'sorted-object-json-utf8-lf/v1',
      value: sha256(payloadText),
    },
  };
}

export function verifyPassport(passport) {
  if (
    !passport ||
    passport.schema !== 'kungfu.auditable-demo.release-passport/v1' ||
    passport.status !== 'qualified' ||
    !passport.root ||
    passport.root.algorithm !== 'sha256' ||
    passport.root.profile !== 'sorted-object-json-utf8-lf/v1' ||
    !DIGEST_PATTERN.test(passport.root.value || '')
  ) {
    fail('document schema, status, or root coordinate is invalid');
  }
  const { root, ...payload } = passport;
  if (root.value !== sha256(stableJson(payload))) {
    fail('document root does not match the canonical payload');
  }
  return passport;
}

function parseCli(argv) {
  const [command, flag, value, ...rest] = argv;
  if (
    !['write', 'check'].includes(command) ||
    flag !== (command === 'write' ? '--output' : '--input') ||
    !value ||
    rest.length
  ) {
    fail(
      'usage: auditable-demo-passport.mjs write --output PATH | check --input PATH',
    );
  }
  return { command, file: path.resolve(value) };
}

function main(argv = process.argv.slice(2)) {
  const { command, file } = parseCli(argv);
  if (command === 'write') {
    const passport = verifyPassport(buildPassport());
    fs.writeFileSync(file, stableJson(passport), { flag: 'wx', mode: 0o644 });
    process.stdout.write(
      stableJson({ status: 'written', path: file, root: passport.root.value }),
    );
    return;
  }
  const passport = JSON.parse(fs.readFileSync(file, 'utf8'));
  verifyPassport(passport);
  process.stdout.write(
    stableJson({ status: 'valid', path: file, root: passport.root.value }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
