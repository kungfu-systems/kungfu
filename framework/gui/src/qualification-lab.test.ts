// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { QualificationLabReport } from '@kungfu-tech/api/capability';
import {
  QUALIFICATION_MODES,
  qualificationBehaviorFindings,
  qualificationModeNeeds,
  qualificationSessionStories,
} from './renderer/src/qualification-lab';

const qualifiedReport = {
  status: 'qualified',
  events: [
    { step: 'session-1', status: 'ended-partial' },
    { step: 'session-2', status: 'ended-complete' },
  ],
  assessment: {
    oracleChecks: [
      {
        id: 'second-attempt-recognized-partial-state',
        passed: true,
      },
    ],
    residualRisks: [],
  },
} as unknown as QualificationLabReport;

test('the Lab exposes one explicit selector for all three experiment modes', () => {
  assert.deepEqual(
    QUALIFICATION_MODES.map(({ id }) => id),
    ['offline-demo', 'same-agent', 'cross-agent'],
  );
  assert.deepEqual(qualificationModeNeeds('offline-demo'), {
    source: false,
    target: false,
  });
  assert.deepEqual(qualificationModeNeeds('same-agent'), {
    source: true,
    target: false,
  });
  assert.deepEqual(qualificationModeNeeds('cross-agent'), {
    source: true,
    target: true,
  });
});

test('the two session stories distinguish bounded progress from continuation', () => {
  const [first, second] = qualificationSessionStories(
    'cross-agent',
    false,
    qualifiedReport,
  );

  assert.equal(first.title, 'Session 1');
  assert.equal(first.subtitle, 'Source local agent');
  assert.equal(first.milestones[0]?.status, 'correct');
  assert.match(first.milestones[0]?.title ?? '', /partial result/);

  assert.equal(second.title, 'Session 2');
  assert.equal(second.subtitle, 'Target local agent');
  assert.equal(second.milestones[0]?.status, 'correct');
  assert.match(second.milestones[1]?.title ?? '', /recorded state/);
});

test('an in-flight atomic report never fabricates Session 2 progress', () => {
  const [first, second] = qualificationSessionStories('same-agent', true, null);

  assert.equal(first.milestones[0]?.status, 'running');
  assert.equal(second.milestones[0]?.status, 'waiting');
  assert.match(
    second.milestones[0]?.detail ?? '',
    /waits rather than guessing/,
  );
});

test('canonical oracle failures and residuals stay visually distinct', () => {
  const report = {
    ...qualifiedReport,
    status: 'qualified-with-residuals',
    assessment: {
      oracleChecks: [
        {
          id: 'second-attempt-recognized-partial-state',
          passed: false,
        },
      ],
      residualRisks: [
        'Provider confinement remains to be independently proven.',
      ],
    },
  } as QualificationLabReport;
  const findings = qualificationBehaviorFindings(report);

  assert.deepEqual(
    findings.map(({ status }) => status),
    ['undesirable', 'warning'],
  );
});

test('the shell keeps navigation outside the Lab content branch', () => {
  const source = readFileSync(
    new URL('./renderer/src/main.tsx', import.meta.url),
    'utf8',
  );
  const body = source.slice(
    source.indexOf('<div style={chromeBodyStyle}>'),
    source.indexOf('{notificationToasts}'),
  );

  assert.ok(body.indexOf('<nav') >= 0);
  assert.ok(body.indexOf('{labOpen ?') >= 0);
  assert.ok(body.indexOf('<nav') < body.indexOf('{labOpen ?'));
});

test('the visual contract is accessible and remains a responsive two-column comparison', () => {
  const source = readFileSync(
    new URL('./renderer/src/qualification-lab.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /aria-label="Test mode"/);
  assert.match(source, /aria-label="Session 1 agent"/);
  assert.match(source, /aria-label="Session 2 agent"/);
  assert.match(source, /<output[\s\S]*aria-label=\{meta\.label\}/);
  assert.match(source, /repeat\(auto-fit, minmax\(min\(100%, 360px\), 1fr\)\)/);
});
