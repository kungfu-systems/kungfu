import assert from 'node:assert/strict';
import test from 'node:test';

import { workLoopShellModel } from './work-loop-contribution.js';

test('TUI maps the shared Cut/Work receipts to a compact read-only model', () => {
  const model = workLoopShellModel(
    {
      schema: 'kungfu.work.inspect/v1',
      status: 'active',
      confidence: 'medium',
      cut: { cutRoot: 'sha256:cut' },
      cutStatus: 'current',
      work: { work_id: 'work-1' },
      openWork: [],
      gaps: ['initiative-binding-unavailable'],
      nextActions: ['checkpoint', 'complete'],
      authority: { projection: 'non-authoritative' },
    },
    {
      schema: 'kungfu.work.recovery-plan/v1',
      status: 'plan',
      code: 'work-current',
      workId: 'work-1',
      action: 'checkpoint',
      gaps: ['initiative-binding-unavailable'],
      writeOccurred: false,
    },
  );
  assert.equal(model.cutRoot, 'sha256:cut');
  assert.equal(model.workId, 'work-1');
  assert.equal(model.recoveryAction, 'checkpoint');
  assert.deepEqual(model.nextActions, ['checkpoint', 'complete']);
});
