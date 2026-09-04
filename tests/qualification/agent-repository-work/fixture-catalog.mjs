// SPDX-License-Identifier: Apache-2.0

import { INCIDENT_BOARD_REFERENCE_REPAIR } from './incident-board-replay-v1-reference.mjs';
import { INCIDENT_BOARD_FIXTURE } from './incident-board-replay-v1.mjs';

const FULL_FIXTURE_ID = 'incident-board-replay-v1';
const LEASE_FIXTURE_ID = 'incident-board-lease-v1';
const REPLAY_FIXTURE_ID = 'incident-board-recovery-v1';
export const REAL_MODULE_SNAPSHOT_FIXTURE_ID =
  'kungfu-agent-patrol-real-module-snapshot-v1';

function subset(value, paths) {
  return Object.freeze(
    Object.fromEntries(paths.map((relative) => [relative, value[relative]])),
  );
}

function derivedFixture({
  id,
  title,
  defectId,
  expectedFailures,
  writablePaths,
  preRepairedPaths = [],
  remainingObligation,
  nextAction,
}) {
  const files = {
    ...INCIDENT_BOARD_FIXTURE.files,
    ...Object.fromEntries(
      preRepairedPaths.map((relative) => [
        relative,
        INCIDENT_BOARD_REFERENCE_REPAIR[relative],
      ]),
    ),
  };
  return Object.freeze({
    ...INCIDENT_BOARD_FIXTURE,
    id,
    defect: {
      ...INCIDENT_BOARD_FIXTURE.defect,
      id: defectId,
    },
    task: {
      ...INCIDENT_BOARD_FIXTURE.task,
      title,
    },
    warrants: {
      agentA: {
        mode: 'investigation-only',
        writablePaths: [],
      },
      agentB: {
        mode: 'bounded-repair',
        writablePaths: [...writablePaths],
      },
    },
    investigation: {
      expectedFailures: [...expectedFailures],
      remainingObligation,
      nextAction,
    },
    referenceRepair: subset(INCIDENT_BOARD_REFERENCE_REPAIR, writablePaths),
    files: Object.freeze(files),
  });
}

const combined = derivedFixture({
  id: FULL_FIXTURE_ID,
  title: INCIDENT_BOARD_FIXTURE.task.title,
  defectId: INCIDENT_BOARD_FIXTURE.defect.id,
  expectedFailures: [
    'test_expired_lease_cannot_complete',
    'test_legacy_duplicate_log_has_stable_restart_summary',
  ],
  writablePaths: INCIDENT_BOARD_FIXTURE.warrants.agentB.writablePaths,
  remainingObligation: 'implement-and-verify-bounded-repair',
  nextAction: 'repair-seeded-completion-idempotency',
});

const lease = derivedFixture({
  id: LEASE_FIXTURE_ID,
  title: 'Repair expired-lease completion authorization',
  defectId: 'expired-lease-completion-authorization',
  expectedFailures: ['test_expired_lease_cannot_complete'],
  writablePaths: ['incident_board/lease.py'],
  preRepairedPaths: ['incident_board/commands.py', 'incident_board/replay.py'],
  remainingObligation: 'implement-and-verify-expired-lease-authorization',
  nextAction: 'repair-expired-lease-authorization',
});

const replay = derivedFixture({
  id: REPLAY_FIXTURE_ID,
  title: 'Repair duplicate-completion restart replay',
  defectId: 'duplicate-completion-restart-replay-divergence',
  expectedFailures: ['test_legacy_duplicate_log_has_stable_restart_summary'],
  writablePaths: ['incident_board/replay.py'],
  preRepairedPaths: ['incident_board/commands.py', 'incident_board/lease.py'],
  remainingObligation: 'implement-and-verify-restart-replay-idempotency',
  nextAction: 'repair-duplicate-completion-replay',
});

const realModuleSnapshot = Object.freeze({
  id: REAL_MODULE_SNAPSHOT_FIXTURE_ID,
  kind: 'real-module-snapshot',
  defect: {
    id: 'agent-patrol-volatile-numeric-fingerprint-regression',
  },
  task: {
    title: 'Restore stable Agent Patrol Finding fingerprints',
  },
  warrants: {
    agentA: {
      mode: 'investigation-only',
      writablePaths: [],
    },
    agentB: {
      mode: 'bounded-repair',
      writablePaths: ['developer/agent-patrol/classify.mjs'],
    },
  },
  investigation: {
    expectedFailures: [
      'volatile numeric failure identifiers share one Finding identity',
    ],
    remainingObligation:
      'implement-and-verify-stable-fingerprint-normalization',
    nextAction: 'repair-volatile-numeric-fingerprint-normalization',
  },
  verification: {
    visibleCommand: [
      'node',
      '--test',
      '--test-name-pattern',
      'volatile numeric failure identifiers share one Finding identity',
      'scripts/agent-patrol.test.mjs',
    ],
  },
});

export const DEFAULT_REPOSITORY_WORK_FIXTURE_ID = FULL_FIXTURE_ID;
export const LIGHT_REPOSITORY_WORK_FIXTURE_ID = LEASE_FIXTURE_ID;

export const SYNTHETIC_REPOSITORY_WORK_FIXTURES = Object.freeze([
  lease,
  replay,
  combined,
]);

export const REPOSITORY_WORK_FIXTURES = Object.freeze([
  ...SYNTHETIC_REPOSITORY_WORK_FIXTURES,
  realModuleSnapshot,
]);

export function getRepositoryWorkFixture(id) {
  const fixture = REPOSITORY_WORK_FIXTURES.find(
    (candidate) => candidate.id === id,
  );
  if (!fixture)
    throw new Error(
      `unknown repository-work fixture: ${id}; expected one of ${REPOSITORY_WORK_FIXTURES.map(
        (candidate) => candidate.id,
      ).join(', ')}`,
    );
  return fixture;
}
