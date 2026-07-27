// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';
import { serializeWorkflowAuthority } from './kungfu-workflow-authority.mjs';

test('workflow authority serialization keeps external action inventories compact and lossless', () => {
  const document = {
    schema: 'kungfu.workflow-authority/v1',
    workflowRoot: '.github/workflows',
    workflows: [
      {
        path: '.github/workflows/example.yml',
        jobs: [
          {
            externalActions: ['actions/checkout@immutable', 'local/action@v1'],
            steps: [],
          },
        ],
      },
    ],
  };
  const serialized = serializeWorkflowAuthority(document);
  assert.deepEqual(JSON.parse(serialized), document);
  assert.match(
    serialized,
    /"externalActions": \["actions\/checkout@immutable","local\/action@v1"\],/,
  );
  assert.doesNotMatch(serialized, /"externalActions": \[\n/);
});
