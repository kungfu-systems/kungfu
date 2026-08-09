// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { writeShifuGateEvidence } from './shifu-gate-evidence.mjs';

test('writes repository-relative, digest-bound Gate evidence', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-gate-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = path.join(root, 'product', 'release', 'report.json');
  const evidence = path.join(root, '.gate', 'evidence.json');
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, '{"status":"passing"}\n');

  assert.equal(
    writeShifuGateEvidence({
      schema: 'kungfu.test.gate-evidence/v1',
      pointers: [{ id: 'report', file: report }],
      root,
      evidenceFile: evidence,
    }),
    true,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(evidence, 'utf8')), {
    schema: 'kungfu.test.gate-evidence/v1',
    pointers: [
      {
        id: 'report',
        ref: 'product/release/report.json',
        digest:
          'sha256:dd14c1d6ce8110f7131449e20be2bfb7cbde2e257367d73a190ccaa468cc46a9',
      },
    ],
  });
});

test('does nothing outside a Gate executor', () => {
  assert.equal(
    writeShifuGateEvidence({
      schema: 'kungfu.test.gate-evidence/v1',
      pointers: [{ id: 'unused', file: '/does/not/exist' }],
      evidenceFile: '',
    }),
    false,
  );
});
