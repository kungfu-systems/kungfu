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

export type AssignmentRuntimeRealm = {
  realmId: string;
  realmKind: 'local';
  generation: string;
};

export type AssignmentRuntimeRevision = {
  value: string;
  root: string;
  parentRoot: string | null;
};

export type AssignmentRuntimeCursor = {
  streamId: string;
  generation: string;
  sequence: string;
  eventRoot: string;
};

export type AssignmentRuntimeError = {
  code: string;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
};

export type AssignmentRuntimeRequest = {
  schema: 'kungfu.assignment-runtime.request/v1';
  requestId: string;
  realm: AssignmentRuntimeRealm;
  operation: string;
  client: {
    clientId: string;
    kind: 'gui';
    requestedCapabilities: string[];
  };
  payload: Record<string, unknown>;
  cursor?: AssignmentRuntimeCursor;
};

export type AssignmentRuntimeResponse<TResult = Record<string, unknown>> = {
  schema: 'kungfu.assignment-runtime.response/v1';
  requestId: string;
  realm: AssignmentRuntimeRealm;
  revision: AssignmentRuntimeRevision;
  capabilities: {
    supported: string[];
    selected: string[];
    unsupported: string[];
  };
  status: 'ok' | 'error';
  result: TResult | null;
  attempt: Record<string, unknown> | null;
  lease: Record<string, unknown> | null;
  warrant: Record<string, unknown> | null;
  factRefs: Array<Record<string, unknown>>;
  episodeRefs: Array<Record<string, unknown>>;
  receipts: Array<Record<string, unknown>>;
  diagnostics: Array<Record<string, unknown>>;
  cursor: AssignmentRuntimeCursor | null;
  error: AssignmentRuntimeError | null;
};

export type AssignmentRuntimeHostReady = {
  schema: 'kungfu.gui.assignment-runtime-host/v1';
  status: 'ready';
  protocol: 'kungfu.assignment-runtime/v1';
  profile: { id: 'kungfu.assignment-runtime.local'; version: string };
  realm: AssignmentRuntimeRealm;
  genesisCursor: AssignmentRuntimeCursor;
  error: null;
};

export type AssignmentRuntimeTransport = {
  connect: () => Promise<AssignmentRuntimeHostReady>;
  invoke: (
    request: AssignmentRuntimeRequest,
  ) => Promise<AssignmentRuntimeResponse>;
};

export type AssignmentRuntimeCommand = Record<string, unknown> & {
  schema: 'kungfu.assignment-runtime.command/v1';
  commandId: string;
  type: string;
  target: { initiativeId: string; assignmentId: string };
  expectedRevision: AssignmentRuntimeRevision;
  idempotencyKey: string;
};

export type AssignmentRuntime = {
  connect: () => Promise<AssignmentRuntimeHostReady>;
  discover: () => Promise<AssignmentRuntimeResponse>;
  snapshot: () => Promise<AssignmentRuntimeResponse>;
  list: (
    filters?: Record<string, unknown>,
  ) => Promise<AssignmentRuntimeResponse>;
  get: (
    initiativeId: string,
    assignmentId: string,
  ) => Promise<AssignmentRuntimeResponse>;
  query: (query: Record<string, unknown>) => Promise<AssignmentRuntimeResponse>;
  watch: (
    cursor?: AssignmentRuntimeCursor,
  ) => Promise<AssignmentRuntimeResponse>;
  submit: (
    command: AssignmentRuntimeCommand,
  ) => Promise<AssignmentRuntimeResponse>;
  inspectCommand: (identity: {
    commandId?: string;
    idempotencyKey?: string;
  }) => Promise<AssignmentRuntimeResponse>;
  diagnostics: () => Promise<AssignmentRuntimeResponse>;
  recoveryPlan: () => Promise<AssignmentRuntimeResponse>;
  recoveryExecute: (
    plan: Record<string, unknown>,
  ) => Promise<AssignmentRuntimeResponse>;
  cursor: () => AssignmentRuntimeCursor | null;
};

const CAPABILITY_BY_OPERATION: Record<string, string> = {
  'capabilities.discover': 'assignment.capabilities.discover',
  'assignment.snapshot': 'assignment.snapshot.read',
  'assignment.list': 'assignment.list.read',
  'assignment.get': 'assignment.get.read',
  'assignment.query': 'assignment.query.read',
  'events.watch': 'assignment.events.watch',
  'command.submit': 'assignment.command.submit',
  'command.get': 'assignment.command.inspect',
  'diagnostics.get': 'assignment.diagnostics.read',
  'recovery.plan': 'assignment.recovery.plan',
  'recovery.execute': 'assignment.recovery.execute',
};

export function openAssignmentRuntime(options: {
  transport: AssignmentRuntimeTransport;
  clientId?: string;
}): AssignmentRuntime {
  const clientId = options.clientId ?? 'gui.work-dashboard';
  let ready: AssignmentRuntimeHostReady | null = null;
  let sequence = 0;
  let currentCursor: AssignmentRuntimeCursor | null = null;

  const connect = async () => {
    const connected = await options.transport.connect();
    if (
      connected.schema !== 'kungfu.gui.assignment-runtime-host/v1' ||
      connected.status !== 'ready' ||
      connected.protocol !== 'kungfu.assignment-runtime/v1'
    ) {
      throw new Error('Assignment Runtime host did not establish R1 readiness');
    }
    ready = connected;
    currentCursor ??= connected.genesisCursor;
    return connected;
  };

  const invoke = async (
    operation: string,
    payload: Record<string, unknown> = {},
    cursor?: AssignmentRuntimeCursor,
  ): Promise<AssignmentRuntimeResponse> => {
    const connected = ready ?? (await connect());
    const capability = CAPABILITY_BY_OPERATION[operation];
    if (!capability)
      throw new Error(`Unsupported Runtime operation: ${operation}`);
    sequence += 1;
    const request: AssignmentRuntimeRequest = {
      schema: 'kungfu.assignment-runtime.request/v1',
      requestId: `${clientId}:${sequence}`,
      realm: connected.realm,
      operation,
      client: {
        clientId,
        kind: 'gui',
        requestedCapabilities: [capability],
      },
      payload,
      ...(cursor ? { cursor } : {}),
    };
    const send = async () => options.transport.invoke(request);
    let response: AssignmentRuntimeResponse;
    try {
      response = await send();
    } catch {
      // A lost response is safe to replay: writes carry exact idempotency and
      // revision fences, and the Runtime returns the original durable receipt.
      ready = null;
      await connect();
      response = await send();
    }
    if (
      response.schema !== 'kungfu.assignment-runtime.response/v1' ||
      response.requestId !== request.requestId
    ) {
      throw new Error('Assignment Runtime returned an unrelated response');
    }
    if (
      response.realm.realmId !== request.realm.realmId ||
      response.realm.realmKind !== request.realm.realmKind ||
      (response.realm.generation !== request.realm.generation &&
        response.error?.code !== 'generation-fenced')
    ) {
      throw new Error('Assignment Runtime returned a mismatched realm');
    }
    if (response.cursor) currentCursor = response.cursor;
    return response;
  };

  return {
    connect,
    discover: () => invoke('capabilities.discover'),
    snapshot: () => invoke('assignment.snapshot'),
    list: (filters = {}) => invoke('assignment.list', filters),
    get: (initiativeId, assignmentId) =>
      invoke('assignment.get', { initiativeId, assignmentId }),
    query: (query) => invoke('assignment.query', query),
    watch: async (cursor) => {
      const connected = ready ?? (await connect());
      return invoke(
        'events.watch',
        {},
        cursor ?? currentCursor ?? connected.genesisCursor,
      );
    },
    submit: (command) => invoke('command.submit', command),
    inspectCommand: (identity) => invoke('command.get', identity),
    diagnostics: () => invoke('diagnostics.get'),
    recoveryPlan: () => invoke('recovery.plan'),
    recoveryExecute: (plan) => invoke('recovery.execute', plan),
    cursor: () => currentCursor,
  };
}
