#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  LIGHT_REPOSITORY_WORK_FIXTURE_ID,
  REPOSITORY_WORK_FIXTURES,
} from '../../tests/qualification/agent-repository-work/fixture-catalog.mjs';

export const DAILY_LIGHT_SCHEDULE = '0 18 * * 1-6';
export const WEEKLY_DEEP_SCHEDULE = '0 18 * * 0';

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
  const ids = REPOSITORY_WORK_FIXTURES.map(({ id }) => id);
  const start = (rotationKey - 1) % ids.length;
  return [ids[start], ids[(start + 1) % ids.length]];
}

export function selectPatrolPlan({
  eventName,
  schedule = '',
  manualMode = '',
  rotationKey,
}) {
  if (!Number.isInteger(rotationKey) || rotationKey < 1)
    throw new Error('rotation key must be a positive integer');
  let mode;
  if (eventName === 'schedule') {
    if (schedule === DAILY_LIGHT_SCHEDULE) mode = 'light';
    else if (schedule === WEEKLY_DEEP_SCHEDULE) mode = 'deep';
    else throw new Error(`unrecognized protected schedule: ${schedule}`);
  } else if (eventName === 'workflow_dispatch') {
    if (!['light', 'deep'].includes(manualMode))
      throw new Error('manual mode must be light or deep');
    mode = manualMode;
  } else {
    throw new Error(`untrusted Patrol event: ${eventName}`);
  }

  const body = {
    schema: 'kungfu.agent-patrol.plan/v1',
    evidenceClass: 'bounded-experiment',
    mode,
    trigger: eventName,
    schedule: eventName === 'schedule' ? schedule : null,
    rotationKey,
    fixtures:
      mode === 'light'
        ? [LIGHT_REPOSITORY_WORK_FIXTURE_ID]
        : deepFixtures(rotationKey),
    timeoutSeconds: mode === 'light' ? 600 : 900,
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
