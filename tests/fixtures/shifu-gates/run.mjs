// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';

const [mode = 'pass', id = 'fixture.unknown'] = process.argv.slice(2);
if (process.env.SHIFU_GATE_FIXTURE_LOG)
  fs.appendFileSync(process.env.SHIFU_GATE_FIXTURE_LOG, `${id}\n`);

if (mode === 'fail') process.exitCode = 7;
else if (mode === 'evidence') {
  if (!process.env.SHIFU_GATE_EVIDENCE_FILE)
    throw new Error('SHIFU_GATE_EVIDENCE_FILE is required');
  fs.writeFileSync(
    process.env.SHIFU_GATE_EVIDENCE_FILE,
    `${JSON.stringify({
      schema: 'fixture.evidence/v1',
      pointers: [{ id: 'fixture-report', ref: 'build/fixture/report.json' }],
    })}\n`,
  );
} else if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 2500));
