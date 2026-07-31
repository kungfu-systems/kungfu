// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_CATALOG_PATH,
  loadAuditableDemo,
} from '../framework/auditable-demo/catalog.mjs';

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ID_PATTERN = /^[1-9][0-9]*$/u;
const ARTIFACT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RENDERER_PATTERN =
  /^[a-z0-9][a-z0-9./_-]*@[sS][hH][aA]256:[0-9a-f]{64}$/u;
const DEMO_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const EVIDENCE_CLASS_PATTERN = /^[a-z0-9][a-z0-9._/-]*\/v[1-9][0-9]*$/u;
const MEDIA_PROFILE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$/u;
const TRIGGER_PLAN_SCHEMA = 'kungfu.auditable-demo.trigger-plan/v1';
const DEFAULT_DEMO_ID = 'agent-work-lab';
const PROMOTION_REF_PATTERN =
  /^(alpha|release)\/v[1-9][0-9]*\/v[1-9][0-9]*\.[0-9]+$/u;
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

function exactString(value, pattern, label) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || !pattern.test(normalized)) fail(`${label} is invalid`);
  return normalized;
}

function boolean(value, label) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false' || value === '' || value === undefined) return false;
  fail(`${label} must be true or false`);
}

export function buildAuditableDemoTriggerPlan({
  eventName,
  baseRef = '',
  sourceSha,
  requestedDemoId = '',
  requestedRenderMedia = false,
}) {
  const exactSourceSha = exactString(sourceSha, SHA_PATTERN, 'source SHA');
  const demoId = exactString(
    requestedDemoId || DEFAULT_DEMO_ID,
    DEMO_ID_PATTERN,
    'demo id',
  );
  const manualRender = boolean(
    requestedRenderMedia,
    'requested render-media value',
  );

  let triggerClass;
  let renderMedia;
  if (eventName === 'workflow_dispatch') {
    if (baseRef) fail('manual dispatch must not declare a promotion base ref');
    triggerClass = 'manual';
    renderMedia = manualRender;
  } else if (eventName === 'pull_request') {
    const match = PROMOTION_REF_PATTERN.exec(baseRef);
    if (!match)
      fail('pull request base ref is not an Alpha or Release channel');
    if (requestedDemoId) {
      fail('promotion events must use the catalog default demo selection');
    }
    if (manualRender) {
      fail('promotion events must not carry a manual render request');
    }
    triggerClass = match[1];
    renderMedia = true;
  } else {
    fail(`unsupported event ${eventName || '<missing>'}`);
  }

  const body = {
    schema: TRIGGER_PLAN_SCHEMA,
    status: 'planned',
    sourceSha: exactSourceSha,
    triggerClass,
    demoId,
    renderMedia,
    refreshRequired: renderMedia,
    executionContract:
      'exact-artifact-capture-gate-passport-and-optional-media/v1',
    publicationAuthority: false,
  };
  return { ...body, planRoot: sha256(stableJson(body)) };
}

export function verifyAuditableDemoTriggerPlan(plan) {
  const { planRoot, ...body } = plan || {};
  if (planRoot !== sha256(stableJson(body))) fail('plan root mismatch');
  if (
    plan.schema !== TRIGGER_PLAN_SCHEMA ||
    plan.status !== 'planned' ||
    !SHA_PATTERN.test(plan.sourceSha || '') ||
    !DEMO_ID_PATTERN.test(plan.demoId || '') ||
    !['manual', 'alpha', 'release'].includes(plan.triggerClass) ||
    typeof plan.renderMedia !== 'boolean' ||
    plan.refreshRequired !== plan.renderMedia ||
    plan.executionContract !==
      'exact-artifact-capture-gate-passport-and-optional-media/v1' ||
    plan.publicationAuthority !== false
  ) {
    fail('plan fields are invalid');
  }
  if (
    (plan.triggerClass === 'alpha' || plan.triggerClass === 'release') &&
    (!plan.renderMedia || plan.demoId !== DEFAULT_DEMO_ID)
  ) {
    fail('promotion plan does not require the default demo media refresh');
  }
  return plan;
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

export function buildPassport(
  env = process.env,
  {
    catalogPath = DEFAULT_CATALOG_PATH,
    demoId = env.AUDITABLE_DEMO_ID || '',
  } = {},
) {
  const selection = loadAuditableDemo({ catalogPath, demoId });
  const demo = selection.demo;
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
  const mediaProfile = media
    ? required(env, 'MEDIA_PROFILE', MEDIA_PROFILE_PATTERN, 'media profile')
    : null;
  const mediaQualificationRoot = media
    ? exactRoot(env, 'MEDIA_QUALIFICATION_ROOT')
    : null;
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
    schema: 'kungfu.auditable-demo.release-passport/v2',
    status: 'qualified',
    demo: {
      id: demo.id,
      catalogRoot: selection.catalogRoot,
      descriptorRoot: selection.descriptorRoot,
      commandLabel: demo.commandLabel,
      evidenceClass: demo.evidenceClass,
      sceneId: demo.scene.id,
      publication: demo.publication,
    },
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
          profile: mediaProfile,
          qualificationRoot: mediaQualificationRoot,
        }
      : {
          status: 'not-requested',
          root: null,
          artifact: null,
          profile: null,
          qualificationRoot: null,
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
      evidenceClass: demo.evidenceClass,
      publication: 'github-artifacts-only',
      productionDeployment: false,
      authorization: {
        status: 'not-granted-by-demo',
        requiredSources: REQUIRED_AUTHORIZATION_SOURCES,
        nonAuthorities: NON_AUTHORITIES,
      },
      claims: demo.claims,
      nonClaims: demo.nonClaims,
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
    passport.schema !== 'kungfu.auditable-demo.release-passport/v2' ||
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
  if (
    !passport.demo ||
    !DEMO_ID_PATTERN.test(passport.demo.id || '') ||
    !DIGEST_PATTERN.test(passport.demo.catalogRoot || '') ||
    !DIGEST_PATTERN.test(passport.demo.descriptorRoot || '') ||
    typeof passport.demo.commandLabel !== 'string' ||
    !passport.demo.commandLabel.startsWith('kungfu ') ||
    passport.demo.evidenceClass !== passport.authority?.evidenceClass ||
    !DEMO_ID_PATTERN.test(passport.demo.sceneId || '') ||
    typeof passport.demo.publication?.readmeFeatured !== 'boolean' ||
    !DEMO_ID_PATTERN.test(passport.demo.publication?.siteSlug || '') ||
    !EVIDENCE_CLASS_PATTERN.test(passport.authority?.evidenceClass || '') ||
    (passport.media?.status === 'rendered' &&
      (!MEDIA_PROFILE_PATTERN.test(passport.media.profile || '') ||
        !DIGEST_PATTERN.test(passport.media.qualificationRoot || ''))) ||
    (passport.media?.status === 'not-requested' &&
      (passport.media.profile !== null ||
        passport.media.qualificationRoot !== null)) ||
    passport.authority?.publication !== 'github-artifacts-only' ||
    passport.authority?.productionDeployment !== false ||
    passport.authority?.authorization?.status !== 'not-granted-by-demo' ||
    JSON.stringify(passport.authority.authorization.requiredSources) !==
      JSON.stringify(REQUIRED_AUTHORIZATION_SOURCES) ||
    JSON.stringify(passport.authority.authorization.nonAuthorities) !==
      JSON.stringify(NON_AUTHORITIES) ||
    !Array.isArray(passport.authority.claims) ||
    passport.authority.claims.length < 1 ||
    !Array.isArray(passport.authority.nonClaims) ||
    passport.authority.nonClaims.length < 1
  ) {
    fail('authority boundary is invalid');
  }
  return passport;
}

function parseCli(argv) {
  const [command, flag, value, ...rest] = argv;
  const outputCommands = ['write', 'plan-write'];
  const inputCommands = ['check', 'plan-verify'];
  if (
    ![...outputCommands, ...inputCommands].includes(command) ||
    flag !== (outputCommands.includes(command) ? '--output' : '--input') ||
    !value ||
    rest.length
  ) {
    fail(
      'usage: auditable-demo-passport.mjs write|plan-write --output PATH | check|plan-verify --input PATH',
    );
  }
  return { command, file: path.resolve(value) };
}

function writeTriggerPlanOutputs(outputPath, plan) {
  if (!outputPath) return;
  fs.appendFileSync(
    outputPath,
    [
      `demo-id=${plan.demoId}`,
      `render-media=${String(plan.renderMedia)}`,
      `refresh-required=${String(plan.refreshRequired)}`,
      `trigger-class=${plan.triggerClass}`,
      `plan-root=${plan.planRoot}`,
      '',
    ].join('\n'),
  );
}

function main(argv = process.argv.slice(2), env = process.env) {
  const { command, file } = parseCli(argv);
  if (command === 'plan-write') {
    const plan = verifyAuditableDemoTriggerPlan(
      buildAuditableDemoTriggerPlan({
        eventName: env.GITHUB_EVENT_NAME || '',
        baseRef: env.AUDITABLE_DEMO_BASE_REF || '',
        sourceSha: env.AUDITABLE_DEMO_SOURCE_SHA || '',
        requestedDemoId: env.AUDITABLE_DEMO_ID || '',
        requestedRenderMedia: env.AUDITABLE_DEMO_RENDER_MEDIA || '',
      }),
    );
    fs.writeFileSync(file, stableJson(plan), { flag: 'wx', mode: 0o644 });
    writeTriggerPlanOutputs(env.GITHUB_OUTPUT, plan);
    return;
  }
  if (command === 'plan-verify') {
    verifyAuditableDemoTriggerPlan(JSON.parse(fs.readFileSync(file, 'utf8')));
    return;
  }
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
