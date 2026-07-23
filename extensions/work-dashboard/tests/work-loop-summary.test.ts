import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeWorkLoop } from '../src/view/work-loop-summary.ts';

test('Work Dashboard projects the shared Cut/Work read model without mutation', () => {
  const summary = summarizeWorkLoop(
    {
      schema: 'kungfu.work.inspect/v1',
      status: 'blocked',
      confidence: 'medium',
      cut: { cutRoot: 'sha256:cut' },
      cutStatus: 'current',
      work: { work_id: 'work-1', status: 'blocked' },
      openWork: [],
      gaps: ['assignment-binding-unavailable'],
      nextActions: ['recover'],
      authority: { projection: 'non-authoritative' },
    },
    {
      schema: 'kungfu.work.recovery-plan/v1',
      status: 'plan',
      code: 'work-blocked',
      workId: 'work-1',
      action: 'resume',
      gaps: ['assignment-binding-unavailable'],
      writeOccurred: false,
    },
  );
  assert.deepEqual(summary, {
    status: 'blocked',
    confidence: 'medium',
    cutStatus: 'current',
    cutRoot: 'sha256:cut',
    workId: 'work-1',
    workStatus: 'blocked',
    gaps: ['assignment-binding-unavailable'],
    nextActions: ['recover'],
    recoveryAction: 'resume',
    recoveryCode: 'work-blocked',
  });
});
