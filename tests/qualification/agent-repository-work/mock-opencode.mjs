#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';

import { INCIDENT_BOARD_REFERENCE_REPAIR } from './incident-board-replay-v1-reference.mjs';

const args = process.argv.slice(2);
const agentIndex = args.indexOf('--agent');
const agent = agentIndex >= 0 ? args[agentIndex + 1] : '';
const prompt = args.at(-1) || '';

if (agent === 'build' && prompt.includes('Investigate the repository defect')) {
  const claim = {
    schema: 'kungfu.agent-repository-work.investigation-claim/v1',
    investigationComplete: true,
    failingTests: [
      'test_expired_lease_cannot_complete',
      'test_legacy_duplicate_log_has_stable_restart_summary',
    ],
    repairPaths: [
      'incident_board/commands.py',
      'incident_board/lease.py',
      'incident_board/replay.py',
    ],
    remainingObligation: 'implement-and-verify-bounded-repair',
    nextAction: 'repair-seeded-completion-idempotency',
  };
  process.stdout.write(
    `${JSON.stringify({
      type: 'text',
      sessionID: 'mock-investigation-session',
      part: { text: JSON.stringify(claim) },
    })}\n`,
  );
} else if (agent === 'build') {
  const repair = args.some((arg) => arg.includes('mock-incomplete'))
    ? {
        'incident_board/lease.py':
          INCIDENT_BOARD_REFERENCE_REPAIR['incident_board/lease.py'],
      }
    : INCIDENT_BOARD_REFERENCE_REPAIR;
  for (const [relative, content] of Object.entries(repair))
    fs.writeFileSync(path.join(process.cwd(), relative), content);
  process.stdout.write(
    `${JSON.stringify({
      type: 'text',
      sessionID: 'mock-repair-session',
      part: {
        text: 'Recovered the admitted continuation and completed the bounded repair.',
      },
    })}\n`,
  );
} else {
  process.stderr.write(`unsupported mock agent: ${agent}\n`);
  process.exitCode = 2;
}
