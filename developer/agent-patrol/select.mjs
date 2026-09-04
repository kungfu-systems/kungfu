#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  LIGHT_REPOSITORY_WORK_FIXTURE_ID,
  REAL_MODULE_SNAPSHOT_FIXTURE_ID,
  SYNTHETIC_REPOSITORY_WORK_FIXTURES,
} from '../../tests/qualification/agent-repository-work/fixture-catalog.mjs';

export const DAILY_LIGHT_SCHEDULE = '0 18 * * 1-6';
export const WEEKLY_DEEP_SCHEDULE = '0 18 * * 0';
export const WEEKLY_REAL_SNAPSHOT_SCHEDULE = '0 20 * * 3';
export const MONTHLY_QUALIFICATION_SCHEDULE = '0 20 * * 0';

const MANUAL_MODES = new Set([
  'light',
  'deep',
  'real-snapshot',
  'qualification',
  'candidate',
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function jsonRoot(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;
}

function deepFixtures(rotationKey) {
  const ids = SYNTHETIC_REPOSITORY_WORK_FIXTURES.map(({ id }) => id);
  const start = (rotationKey - 1) % ids.length;
  return [ids[start], ids[(start + 1) % ids.length]];
}

export function selectPatrolPlan({
  eventName,
  schedule = '',
  manualMode = '',
  rotationKey,
  triggerAt = '',
}) {
  if (!Number.isInteger(rotationKey) || rotationKey < 1)
    throw new Error('rotation key must be a positive integer');
  let mode;
  if (eventName === 'schedule') {
    if (schedule === DAILY_LIGHT_SCHEDULE) mode = 'light';
    else if (schedule === WEEKLY_DEEP_SCHEDULE) mode = 'deep';
    else if (schedule === WEEKLY_REAL_SNAPSHOT_SCHEDULE) mode = 'real-snapshot';
    else if (schedule === MONTHLY_QUALIFICATION_SCHEDULE) {
      const instant = new Date(triggerAt);
      if (!triggerAt || Number.isNaN(instant.valueOf()))
        throw new Error('monthly qualification requires a UTC trigger time');
      const scheduledSunday = new Date(instant);
      scheduledSunday.setUTCDate(
        scheduledSunday.getUTCDate() - scheduledSunday.getUTCDay(),
      );
      mode =
        scheduledSunday.getUTCDate() <= 7 ? 'qualification' : 'monthly-skip';
    } else throw new Error(`unrecognized protected schedule: ${schedule}`);
  } else if (eventName === 'workflow_dispatch') {
    if (!MANUAL_MODES.has(manualMode))
      throw new Error(
        'manual mode must be light, deep, real-snapshot, qualification, or candidate',
      );
    mode = manualMode;
  } else if (eventName === 'push') {
    mode = 'candidate';
  } else {
    throw new Error(`untrusted Patrol event: ${eventName}`);
  }

  const realSnapshot = ['real-snapshot', 'qualification', 'candidate'].includes(
    mode,
  );
  const qualificationRequested = ['qualification', 'candidate'].includes(mode);
  const body = {
    schema: 'kungfu.agent-patrol.plan/v2',
    evidenceClass: 'bounded-experiment',
    mode,
    trigger: eventName,
    schedule: eventName === 'schedule' ? schedule : null,
    triggerAt: triggerAt || null,
    rotationKey,
    fixtures:
      mode === 'light'
        ? [LIGHT_REPOSITORY_WORK_FIXTURE_ID]
        : realSnapshot
          ? [REAL_MODULE_SNAPSHOT_FIXTURE_ID]
          : mode === 'deep'
            ? deepFixtures(rotationKey)
            : [],
    timeoutSeconds: mode === 'light' ? 600 : mode === 'monthly-skip' ? 0 : 900,
    trialsPerFixture: qualificationRequested
      ? 3
      : mode === 'monthly-skip'
        ? 0
        : 1,
    qualification: {
      requested: qualificationRequested,
      minimumTrials: 3,
      authority: qualificationRequested ? 'advisory-model-capability' : null,
    },
    advisoryModelQuality: true,
    protectedSourceRequired: true,
    skipReason:
      mode === 'monthly-skip' ? 'outside-first-utc-sunday-window' : null,
    issueAdmission: 'prohibited',
    requiredGate: false,
  };
  return { ...body, planRoot: jsonRoot(body) };
}

export function parseArgs(argv) {
  const result = {
    eventName: '',
    schedule: '',
    manualMode: '',
    rotationKey: null,
    triggerAt: '',
    output: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--event-name') result.eventName = argv[++index] || '';
    else if (arg === '--schedule') result.schedule = argv[++index] || '';
    else if (arg === '--manual-mode') result.manualMode = argv[++index] || '';
    else if (arg === '--rotation-key')
      result.rotationKey = Number.parseInt(argv[++index] || '', 10);
    else if (arg === '--trigger-at') result.triggerAt = argv[++index] || '';
    else if (arg === '--output') result.output = argv[++index] || '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!result.eventName) throw new Error('--event-name is required');
  if (!result.output) throw new Error('--output is required');
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const plan = selectPatrolPlan(options);
    const output = path.resolve(options.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({
        mode: plan.mode,
        fixtures: plan.fixtures,
        timeoutSeconds: plan.timeoutSeconds,
        planRoot: plan.planRoot,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 2;
  }
}
