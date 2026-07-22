// SPDX-License-Identifier: Apache-2.0

// Topology-neutral runtime values projected by Core. Consumers may display or
// transport these values, but must not infer readiness from process health.

export type RuntimeStreamPosition = {
  stream_id: string;
  container_epoch: string;
  sequence: string;
  frame_uid: string;
};

export type RuntimeError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type RuntimeReadiness = {
  schema: 'kungfu.runtime.readiness/v1';
  state:
    | 'starting'
    | 'recovering'
    | 'ready'
    | 'draining'
    | 'failed'
    | 'restarting'
    | 'stopped';
  durableCut: RuntimeStreamPosition | null;
  projectionCut: RuntimeStreamPosition | null;
  evidence: Array<{ kind: string; ref: string }>;
  observedAtNs: string;
};

export type RuntimeHandle = {
  schema: 'kungfu.runtime.handle/v1';
  runtimeId: string;
  requirementId: string;
  workspaceId: string;
  generation: string;
  state: RuntimeReadiness['state'];
  capabilities: string[];
  grantedAuthorities: string[];
  readiness: RuntimeReadiness;
  host: {
    kind: string;
    hostId: string;
    diagnostics: Record<string, unknown>;
  };
};

export type RuntimeLease = {
  schema: 'kungfu.runtime.lease/v1';
  leaseId: string;
  runtimeId: string;
  generation: string;
  holderId: string;
  capabilities: string[];
  issuedAtNs: string;
  expiresAtNs: string;
  state: 'active' | 'released' | 'expired';
};

type RuntimeProductStatusBase = {
  schema: 'kungfu.runtime.product-status/v1';
  workspaceId: string;
  availability: 'available';
  leases: { activeCount: number; items: RuntimeLease[] };
};

export type RuntimeProductStatus = RuntimeProductStatusBase &
  (
    | { liveState: 'inactive'; handle: null; error: null }
    | {
        liveState: Exclude<RuntimeReadiness['state'], 'failed'>;
        handle: RuntimeHandle;
        error: null;
      }
    | {
        liveState: 'failed';
        handle: RuntimeHandle | null;
        error: RuntimeError;
      }
  );

export type RuntimeOperation = {
  id: string;
  operationClass: 'storage-only' | 'live-optional' | 'live-required';
  requiredCapabilities: string[];
  requestedAuthorities: string[];
  recoveryGuidance: string;
};

export type RuntimeOperationCatalog = {
  schema: 'kungfu.runtime-operation-registry/v1';
  operations: RuntimeOperation[];
};
