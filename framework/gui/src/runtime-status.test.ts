// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type RuntimeStatusResult,
  deriveWorkspaceRuntimePresentation,
} from './runtime-status';

function status(payload: RuntimeStatusResult['payload']): RuntimeStatusResult {
  return { ok: true, payload, error: '', updatedAt: 1 };
}

test('daemonless product status keeps the durable workspace available', () => {
  const result = deriveWorkspaceRuntimePresentation(
    status({
      product: {
        schema: 'kungfu.runtime.product-status/v1',
        workspaceId: 'workspace-test',
        availability: 'available',
        liveState: 'inactive',
        handle: null,
        leases: { activeCount: 0, items: [] },
        error: null,
      },
      lifecycle: { state: 'stopped', healthy: false },
      supervisor: { running: false },
      coordinator: { running: false },
    }),
  );
  assert.equal(result.state, 'available');
  assert.equal(result.label, 'Workspace available');
  assert.doesNotMatch(result.detail, /start|coordinator|supervisor/i);
});

test('shared semantic readiness wins over process diagnostics', () => {
  const result = deriveWorkspaceRuntimePresentation(
    status({
      product: {
        schema: 'kungfu.runtime.product-status/v1',
        workspaceId: 'workspace-test',
        availability: 'available',
        liveState: 'ready',
        handle: {
          schema: 'kungfu.runtime.handle/v1',
          runtimeId: 'runtime-test',
          requirementId: 'request-test',
          workspaceId: 'workspace-test',
          generation: '1',
          state: 'ready',
          capabilities: ['runtime.assessment-scheduling'],
          grantedAuthorities: ['runtime.capability-use'],
          readiness: {
            schema: 'kungfu.runtime.readiness/v1',
            state: 'ready',
            durableCut: {
              stream_id: '1',
              container_epoch: '1',
              sequence: '1',
              frame_uid: '1',
            },
            projectionCut: null,
            evidence: [{ kind: 'durability-receipt', ref: 'receipt:test' }],
            observedAtNs: '1',
          },
          host: {
            kind: 'process',
            hostId: 'process-test',
            diagnostics: {},
          },
        },
        leases: { activeCount: 0, items: [] },
        error: null,
      },
      lifecycle: { state: 'orphan-coordinator', healthy: false },
      supervisor: { running: false },
      coordinator: { running: true },
    }),
  );
  assert.equal(result.state, 'ready');
  assert.equal(result.label, 'Workspace ready');
});

test('process health alone reports online rather than continuity-ready', () => {
  const result = deriveWorkspaceRuntimePresentation(
    status({
      lifecycle: { state: 'running', healthy: true },
      supervisor: { running: true },
      coordinator: { running: true },
    }),
  );
  assert.equal(result.state, 'online');
  assert.equal(result.label, 'Workspace online');
  assert.match(result.detail, /continuity is not yet reported/);
});

test('current continuity evidence upgrades an online runtime to ready', () => {
  const result = deriveWorkspaceRuntimePresentation(
    status({
      lifecycle: { state: 'running', healthy: true },
      continuity: { state: 'ready' },
      supervisor: { running: true },
      coordinator: { running: true },
    }),
  );
  assert.equal(result.state, 'ready');
  assert.equal(result.severity, 'ok');
});

test('surviving sessions can render reconnecting while processes are live', () => {
  const result = deriveWorkspaceRuntimePresentation(
    status({
      lifecycle: { state: 'running', healthy: true },
      continuity: {
        state: 'reconnecting',
        reason: '2 agents are joining the current generation.',
      },
      supervisor: { running: true },
      coordinator: { running: true },
    }),
  );
  assert.equal(result.state, 'reconnecting');
  assert.equal(result.detail, '2 agents are joining the current generation.');
});

test('a supervised coordinator outage renders starting', () => {
  const result = deriveWorkspaceRuntimePresentation(
    status({
      lifecycle: { state: 'degraded', healthy: false },
      supervisor: { running: true },
      coordinator: { running: false },
    }),
  );
  assert.equal(result.state, 'starting');
});

test('authority failures cannot be overridden by stale ready evidence', () => {
  const result = deriveWorkspaceRuntimePresentation(
    status({
      lifecycle: { state: 'orphan-coordinator', healthy: false },
      continuity: { state: 'ready' },
      supervisor: { running: false },
      coordinator: { running: true },
    }),
  );
  assert.equal(result.state, 'needs-attention');
  assert.equal(result.severity, 'error');
});

test('stopped processes render one workspace-level offline state', () => {
  const result = deriveWorkspaceRuntimePresentation(
    status({
      lifecycle: { state: 'stopped', healthy: false },
      supervisor: { running: false },
      coordinator: { running: false },
    }),
  );
  assert.equal(result.state, 'offline');
  assert.equal(result.label, 'Workspace offline');
});

test('status transport failure is visible without exposing process vocabulary', () => {
  const result = deriveWorkspaceRuntimePresentation({
    ok: false,
    payload: null,
    error: 'status timed out',
    updatedAt: 1,
  });
  assert.equal(result.state, 'needs-attention');
  assert.equal(result.label, 'Workspace unavailable');
  assert.equal(result.detail, 'status timed out');
});
