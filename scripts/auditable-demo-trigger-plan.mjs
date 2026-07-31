#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SCHEMA = 'kungfu.auditable-demo.trigger-plan/v1';
const DEFAULT_DEMO_ID = 'agent-work-lab';
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DEMO_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PROMOTION_REF_PATTERN =
  /^(alpha|release)\/v[1-9][0-9]*\/v[1-9][0-9]*\.[0-9]+$/u;

function fail(message) {
  throw new Error(`auditable-demo trigger plan: ${message}`);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function root(value) {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`;
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
    schema: SCHEMA,
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
  return { ...body, planRoot: root(body) };
}

export function verifyAuditableDemoTriggerPlan(plan) {
  const { planRoot, ...body } = plan || {};
  if (planRoot !== root(body)) fail('plan root mismatch');
  if (
    plan.schema !== SCHEMA ||
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

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      fail(`invalid option ${flag || '<missing>'}`);
    }
    options[flag.slice(2)] = value;
  }
  return { command, options };
}

function writeOutputs(outputPath, plan) {
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
  const { command, options } = parse(argv);
  if (command === 'write') {
    if (!options.output) fail('--output is required');
    const plan = buildAuditableDemoTriggerPlan({
      eventName: env.GITHUB_EVENT_NAME || '',
      baseRef: env.AUDITABLE_DEMO_BASE_REF || '',
      sourceSha: env.AUDITABLE_DEMO_SOURCE_SHA || '',
      requestedDemoId: env.AUDITABLE_DEMO_ID || '',
      requestedRenderMedia: env.AUDITABLE_DEMO_RENDER_MEDIA || '',
    });
    verifyAuditableDemoTriggerPlan(plan);
    fs.writeFileSync(options.output, stableJson(plan));
    writeOutputs(env.GITHUB_OUTPUT, plan);
    return;
  }
  if (command === 'verify') {
    if (!options.input) fail('--input is required');
    verifyAuditableDemoTriggerPlan(
      JSON.parse(fs.readFileSync(options.input, 'utf8')),
    );
    return;
  }
  fail(`unsupported command ${command || '<missing>'}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
