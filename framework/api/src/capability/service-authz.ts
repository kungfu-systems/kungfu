// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import type { KfxHostContribution } from './kfx-host.js';
import type { SandboxProfile } from './sandbox-launcher.js';

export type ServiceAuthorization = KfxHostContribution['authorization'];

export type ServiceLanding =
  | { tier: 'co-resident' }
  | { tier: 'sandbox'; profile: SandboxProfile; networkConsent: boolean };

function rooted(value: string | null): value is string {
  return value?.startsWith('sha256:') === true;
}

// Runtime placement is a projection of the exact Core authorization. Package
// identity, install origin and host-local settings are deliberately absent.
export function resolveServiceLanding(
  authorization: ServiceAuthorization,
): ServiceLanding {
  const complete =
    authorization.schema === 'kungfu.kfx.host-authorization/v2' &&
    authorization.executionAllowed === true &&
    rooted(authorization.authorizationRoot) &&
    rooted(authorization.packageRoot) &&
    rooted(authorization.manifestRoot) &&
    rooted(authorization.ownerProviderRoot) &&
    rooted(authorization.trustRoot) &&
    rooted(authorization.corePolicyRoot) &&
    rooted(authorization.requestedPolicyRoot) &&
    rooted(authorization.policyRoot) &&
    rooted(authorization.authorizationPlanRoot) &&
    rooted(authorization.capabilityDeclarationRoot) &&
    rooted(authorization.capabilityGrantRoot) &&
    rooted(authorization.warrantRoot) &&
    rooted(authorization.cutRoot) &&
    authorization.requiredCapabilities.every((capability) =>
      authorization.grantedCapabilities.includes(capability),
    );
  if (!complete || authorization.runtimeTier === 'metadata-only') {
    throw new Error(
      'KF_KFX_HOST_NOT_AUTHORIZED: exact Core authorization required',
    );
  }
  if (authorization.runtimeTier === 'integrated-explicit') {
    return { tier: 'co-resident' };
  }
  return {
    tier: 'sandbox',
    profile: {
      base: 'restrictive',
      denyNetwork: !authorization.grantedCapabilities.includes('network'),
      denyWrite: !authorization.grantedCapabilities.includes('storage'),
    },
    networkConsent: authorization.grantedCapabilities.includes('network'),
  };
}

export const KFX_SERVICE_HOST_SCHEMA = 'kungfu.kfx.service-host/v1' as const;
export const KFX_SERVICE_RECEIPT_SCHEMA =
  'kungfu.kfx.service-host-receipt/v1' as const;

export type KfxServiceLifecycleState =
  | 'installed'
  | 'dormant'
  | 'starting'
  | 'ready'
  | 'draining'
  | 'stopped'
  | 'crashed'
  | 'deactivated'
  | 'uninstalled';

export type KfxServiceDiagnosticCode =
  | 'KF_KFX_SERVICE_CONTRACT_UNSUPPORTED'
  | 'KF_KFX_SERVICE_LIFECYCLE_INVALID'
  | 'KF_KFX_SERVICE_UNQUALIFIED'
  | 'KF_KFX_SERVICE_UNAUTHORIZED'
  | 'KF_KFX_SERVICE_DEPENDENCY_DORMANT'
  | 'KF_KFX_LISTENER_DISABLED'
  | 'KF_KFX_LISTENER_POLICY_REJECTED'
  | 'KF_KFX_WEBHOOK_METHOD_UNSUPPORTED'
  | 'KF_KFX_WEBHOOK_PATH_UNSUPPORTED'
  | 'KF_KFX_WEBHOOK_UNSIGNED'
  | 'KF_KFX_WEBHOOK_AUTHENTICATION_FAILED'
  | 'KF_KFX_WEBHOOK_REPLAYED'
  | 'KF_KFX_WEBHOOK_OVERSIZED'
  | 'KF_KFX_WEBHOOK_RATE_EXCEEDED'
  | 'KF_KFX_WEBHOOK_QUEUE_FULL'
  | 'KF_KFX_WEBHOOK_TIMEOUT'
  | 'KF_KFX_WEBHOOK_NORMALIZATION_FAILED';

export type KfxServiceHostDeclaration = {
  schema: typeof KFX_SERVICE_HOST_SCHEMA;
  contractVersion: 1;
  lifecycle: {
    restartPolicy: 'never' | 'on-failure';
    readinessTimeoutMs: number;
    drainTimeoutMs: number;
    shutdownTimeoutMs: number;
  };
  webhook: {
    listener: {
      mode: 'disabled' | 'loopback' | 'explicit';
      bindAddress?: string;
      port?: number;
      path: string;
      methods: Array<'POST' | 'PUT'>;
    };
    credentials: Array<{
      handle: string;
      purpose: 'webhook-signature-verification';
      algorithms: Array<'hmac-sha256' | 'ed25519'>;
    }>;
    intake: {
      maxPayloadBytes: number;
      maxQueueDepth: number;
      maxInflight: number;
      maxRequestsPerWindow: number;
      rateWindowMs: number;
      handlerTimeoutMs: number;
      replayWindowMs: number;
    };
  };
};

export type KfxServiceDependencyEvidence = {
  providerId: string;
  version: string;
  installed: boolean;
  qualified: boolean;
  authorized: boolean;
  compatible: boolean;
};

export type KfxServiceAuthorityEvidence = {
  packageKey: string;
  packageVersion: string;
  kfdRoot: string | null;
  warrantRoot: string | null;
  passportRoot: string | null;
  authorizationRoot: string | null;
  capabilityGrantRoot: string | null;
  dependencyRoot: string | null;
  qualified: boolean;
  authorized: boolean;
  grantedCapabilities: string[];
  dependencies: KfxServiceDependencyEvidence[];
};

export type KfxWebhookRequest = {
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  signature: string | null;
  replayKey: string | null;
};

export type KfxCredentialVerifyRequest = {
  handle: string;
  algorithm: 'hmac-sha256' | 'ed25519';
  body: Uint8Array;
  signature: string;
  headers: Readonly<Record<string, string>>;
};

export type KfxCredentialBroker = {
  verify(request: KfxCredentialVerifyRequest): Promise<boolean>;
};

export type KfxWebhookHandler<Event> = {
  credentialHandle: string;
  algorithm: 'hmac-sha256' | 'ed25519';
  normalize(request: {
    method: string;
    path: string;
    headers: Readonly<Record<string, string>>;
    body: Uint8Array;
  }): Promise<Event>;
  onEvent(event: Event): Promise<void>;
};

export type KfxServiceReceipt = {
  schema: typeof KFX_SERVICE_RECEIPT_SCHEMA;
  sequence: number;
  operation: string;
  outcome: 'applied' | 'refused';
  state: KfxServiceLifecycleState;
  generation: number;
  packageVersion: string;
  code: KfxServiceDiagnosticCode | null;
  evidence: {
    kfdRoot: string | null;
    warrantRoot: string | null;
    passportRoot: string | null;
    authorizationRoot: string | null;
    capabilityGrantRoot: string | null;
    dependencyRoot: string | null;
  };
  details: Record<string, boolean | number | string | null>;
  receiptRoot: string;
};

export type KfxWebhookIntakeResult<Event> = {
  accepted: boolean;
  event?: Event;
  receipt: KfxServiceReceipt;
};

type Clock = { now(): number };

function exactServiceRooted(value: string | null): value is string {
  return /^sha256:[0-9a-f]{64}$/.test(value ?? '');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function receiptRoot(receipt: Omit<KfxServiceReceipt, 'receiptRoot'>): string {
  return `sha256:${createHash('sha256').update(canonical(receipt)).digest('hex')}`;
}

function isLoopback(address: string): boolean {
  return (
    address === 'localhost' || address === '127.0.0.1' || address === '::1'
  );
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function validateKfxServiceHostDeclaration(
  declaration: KfxServiceHostDeclaration,
): void {
  if (
    declaration.schema !== KFX_SERVICE_HOST_SCHEMA ||
    declaration.contractVersion !== 1
  ) {
    throw new Error(
      'KF_KFX_SERVICE_CONTRACT_UNSUPPORTED: service host contract v1 required',
    );
  }
  const lifecycle = declaration.lifecycle;
  if (
    !positiveInteger(lifecycle.readinessTimeoutMs) ||
    !positiveInteger(lifecycle.drainTimeoutMs) ||
    !positiveInteger(lifecycle.shutdownTimeoutMs)
  ) {
    throw new Error(
      'KF_KFX_SERVICE_CONTRACT_UNSUPPORTED: lifecycle deadlines must be positive integers',
    );
  }
  const { listener, credentials, intake } = declaration.webhook;
  if (
    !listener.path.startsWith('/') ||
    listener.path.includes('..') ||
    listener.methods.length === 0 ||
    new Set(listener.methods).size !== listener.methods.length
  ) {
    throw new Error(
      'KF_KFX_SERVICE_CONTRACT_UNSUPPORTED: webhook route is invalid',
    );
  }
  if (listener.mode === 'disabled') {
    if (listener.bindAddress !== undefined || listener.port !== undefined) {
      throw new Error(
        'KF_KFX_LISTENER_POLICY_REJECTED: disabled listener cannot declare an address or port',
      );
    }
  } else {
    const port = listener.port;
    if (!listener.bindAddress || !positiveInteger(port ?? 0)) {
      throw new Error(
        'KF_KFX_LISTENER_POLICY_REJECTED: enabled listener requires an address and port',
      );
    }
    if ((port ?? 0) > 65535) {
      throw new Error(
        'KF_KFX_LISTENER_POLICY_REJECTED: listener port is out of range',
      );
    }
    if (listener.mode === 'loopback' && !isLoopback(listener.bindAddress)) {
      throw new Error(
        'KF_KFX_LISTENER_POLICY_REJECTED: loopback mode requires a loopback address',
      );
    }
    if (listener.mode === 'explicit' && isLoopback(listener.bindAddress)) {
      throw new Error(
        'KF_KFX_LISTENER_POLICY_REJECTED: explicit mode is reserved for non-loopback addresses',
      );
    }
  }
  const handles = new Set<string>();
  for (const credential of credentials) {
    if (
      !/^credential:[A-Za-z0-9._/-]+$/.test(credential.handle) ||
      handles.has(credential.handle) ||
      credential.algorithms.length === 0 ||
      new Set(credential.algorithms).size !== credential.algorithms.length
    ) {
      throw new Error(
        'KF_KFX_SERVICE_CONTRACT_UNSUPPORTED: credential handles must be opaque and unique',
      );
    }
    handles.add(credential.handle);
  }
  if (
    !positiveInteger(intake.maxPayloadBytes) ||
    !positiveInteger(intake.maxQueueDepth) ||
    !positiveInteger(intake.maxInflight) ||
    intake.maxInflight > intake.maxQueueDepth ||
    !positiveInteger(intake.maxRequestsPerWindow) ||
    !positiveInteger(intake.rateWindowMs) ||
    !positiveInteger(intake.handlerTimeoutMs) ||
    !positiveInteger(intake.replayWindowMs)
  ) {
    throw new Error(
      'KF_KFX_SERVICE_CONTRACT_UNSUPPORTED: intake limits must be finite positive integers',
    );
  }
}

function dependencyEligible(dependency: KfxServiceDependencyEvidence): boolean {
  return (
    dependency.installed &&
    dependency.qualified &&
    dependency.authorized &&
    dependency.compatible
  );
}

export class KfxServiceWebhookHost<Event> {
  private stateValue: KfxServiceLifecycleState;
  private version: string;
  private generationValue = 0;
  private sequence = 0;
  private inflight = 0;
  private readonly replay = new Map<string, number>();
  private readonly rate = new Array<number>();

  public constructor(
    private readonly declaration: KfxServiceHostDeclaration,
    private evidence: KfxServiceAuthorityEvidence,
    private readonly broker: KfxCredentialBroker,
    private readonly handler: KfxWebhookHandler<Event>,
    private readonly clock: Clock = Date,
  ) {
    validateKfxServiceHostDeclaration(declaration);
    this.version = evidence.packageVersion;
    this.stateValue = this.dependenciesEligible() ? 'installed' : 'dormant';
  }

  public get state(): KfxServiceLifecycleState {
    return this.stateValue;
  }

  public get generation(): number {
    return this.generationValue;
  }

  private receipt(
    operation: string,
    outcome: 'applied' | 'refused',
    code: KfxServiceDiagnosticCode | null,
    details: Record<string, boolean | number | string | null> = {},
  ): KfxServiceReceipt {
    const base: Omit<KfxServiceReceipt, 'receiptRoot'> = {
      schema: KFX_SERVICE_RECEIPT_SCHEMA,
      sequence: ++this.sequence,
      operation,
      outcome,
      state: this.stateValue,
      generation: this.generationValue,
      packageVersion: this.version,
      code,
      evidence: {
        kfdRoot: this.evidence.kfdRoot,
        warrantRoot: this.evidence.warrantRoot,
        passportRoot: this.evidence.passportRoot,
        authorizationRoot: this.evidence.authorizationRoot,
        capabilityGrantRoot: this.evidence.capabilityGrantRoot,
        dependencyRoot: this.evidence.dependencyRoot,
      },
      details,
    };
    return { ...base, receiptRoot: receiptRoot(base) };
  }

  private refuse(
    operation: string,
    code: KfxServiceDiagnosticCode,
    details: Record<string, boolean | number | string | null> = {},
  ): KfxServiceReceipt {
    return this.receipt(operation, 'refused', code, details);
  }

  private dependenciesEligible(): boolean {
    return this.evidence.dependencies.every(dependencyEligible);
  }

  private authorityCode(): KfxServiceDiagnosticCode | null {
    if (
      !this.evidence.qualified ||
      !exactServiceRooted(this.evidence.kfdRoot)
    ) {
      return 'KF_KFX_SERVICE_UNQUALIFIED';
    }
    if (
      !this.evidence.authorized ||
      !exactServiceRooted(this.evidence.warrantRoot) ||
      !exactServiceRooted(this.evidence.passportRoot) ||
      !exactServiceRooted(this.evidence.authorizationRoot) ||
      !exactServiceRooted(this.evidence.capabilityGrantRoot) ||
      !exactServiceRooted(this.evidence.dependencyRoot)
    ) {
      return 'KF_KFX_SERVICE_UNAUTHORIZED';
    }
    if (!this.dependenciesEligible()) {
      return 'KF_KFX_SERVICE_DEPENDENCY_DORMANT';
    }
    return null;
  }

  private listenerCode(): KfxServiceDiagnosticCode | null {
    const listener = this.declaration.webhook.listener;
    if (listener.mode === 'disabled') return 'KF_KFX_LISTENER_DISABLED';
    const granted = new Set(this.evidence.grantedCapabilities);
    if (!granted.has('network.listen')) {
      return 'KF_KFX_LISTENER_POLICY_REJECTED';
    }
    if (
      listener.mode === 'explicit' &&
      !granted.has('network.listen.non-loopback')
    ) {
      return 'KF_KFX_LISTENER_POLICY_REJECTED';
    }
    if (!granted.has('credential.verify')) {
      return 'KF_KFX_SERVICE_UNAUTHORIZED';
    }
    return null;
  }

  public start(): KfxServiceReceipt {
    if (!['installed', 'stopped', 'dormant'].includes(this.stateValue)) {
      return this.refuse('start', 'KF_KFX_SERVICE_LIFECYCLE_INVALID');
    }
    const authority = this.authorityCode();
    if (authority) {
      this.stateValue =
        authority === 'KF_KFX_SERVICE_DEPENDENCY_DORMANT'
          ? 'dormant'
          : this.stateValue;
      return this.refuse('start', authority);
    }
    const listener = this.listenerCode();
    if (listener && listener !== 'KF_KFX_LISTENER_DISABLED') {
      return this.refuse('start', listener);
    }
    this.generationValue += 1;
    this.stateValue = 'starting';
    return this.receipt('start', 'applied', null, {
      listenerEnabled: listener === null,
    });
  }

  public ready(): KfxServiceReceipt {
    if (this.stateValue !== 'starting') {
      return this.refuse('ready', 'KF_KFX_SERVICE_LIFECYCLE_INVALID');
    }
    this.stateValue = 'ready';
    return this.receipt('ready', 'applied', null);
  }

  public drain(): KfxServiceReceipt {
    if (this.stateValue !== 'ready') {
      return this.refuse('drain', 'KF_KFX_SERVICE_LIFECYCLE_INVALID');
    }
    this.stateValue = 'draining';
    return this.receipt('drain', 'applied', null, { inflight: this.inflight });
  }

  public stop(): KfxServiceReceipt {
    if (!['starting', 'draining', 'crashed'].includes(this.stateValue)) {
      return this.refuse('stop', 'KF_KFX_SERVICE_LIFECYCLE_INVALID');
    }
    if (this.inflight > 0) {
      return this.refuse('stop', 'KF_KFX_SERVICE_LIFECYCLE_INVALID', {
        inflight: this.inflight,
      });
    }
    this.stateValue = 'stopped';
    return this.receipt('stop', 'applied', null);
  }

  public crash(): KfxServiceReceipt {
    if (!['starting', 'ready', 'draining'].includes(this.stateValue)) {
      return this.refuse('crash', 'KF_KFX_SERVICE_LIFECYCLE_INVALID');
    }
    this.stateValue = 'crashed';
    return this.receipt('crash', 'applied', null);
  }

  public restart(): KfxServiceReceipt {
    if (!['stopped', 'crashed'].includes(this.stateValue)) {
      return this.refuse('restart', 'KF_KFX_SERVICE_LIFECYCLE_INVALID');
    }
    const authority = this.authorityCode();
    if (authority) return this.refuse('restart', authority);
    this.generationValue += 1;
    this.stateValue = 'starting';
    return this.receipt('restart', 'applied', null);
  }

  public upgrade(
    nextVersion: string,
    evidence: KfxServiceAuthorityEvidence,
  ): KfxServiceReceipt {
    if (!['installed', 'stopped', 'deactivated'].includes(this.stateValue)) {
      return this.refuse('upgrade', 'KF_KFX_SERVICE_LIFECYCLE_INVALID');
    }
    if (!nextVersion || evidence.packageVersion !== nextVersion) {
      return this.refuse('upgrade', 'KF_KFX_SERVICE_CONTRACT_UNSUPPORTED');
    }
    this.evidence = evidence;
    const authority = this.authorityCode();
    if (authority) return this.refuse('upgrade', authority);
    const previousVersion = this.version;
    this.version = nextVersion;
    this.stateValue = 'installed';
    return this.receipt('upgrade', 'applied', null, { previousVersion });
  }

  public rollback(
    previousVersion: string,
    evidence: KfxServiceAuthorityEvidence,
  ): KfxServiceReceipt {
    if (!['installed', 'stopped', 'deactivated'].includes(this.stateValue)) {
      return this.refuse('rollback', 'KF_KFX_SERVICE_LIFECYCLE_INVALID');
    }
    if (!previousVersion || evidence.packageVersion !== previousVersion) {
      return this.refuse('rollback', 'KF_KFX_SERVICE_CONTRACT_UNSUPPORTED');
    }
    this.evidence = evidence;
    const authority = this.authorityCode();
    if (authority) return this.refuse('rollback', authority);
    const replacedVersion = this.version;
    this.version = previousVersion;
    this.stateValue = 'installed';
    return this.receipt('rollback', 'applied', null, { replacedVersion });
  }

  public deactivate(): KfxServiceReceipt {
    if (!['installed', 'stopped', 'dormant'].includes(this.stateValue)) {
      return this.refuse('deactivate', 'KF_KFX_SERVICE_LIFECYCLE_INVALID');
    }
    this.stateValue = 'deactivated';
    this.replay.clear();
    this.rate.length = 0;
    return this.receipt('deactivate', 'applied', null);
  }

  public uninstall(): KfxServiceReceipt {
    if (
      !['installed', 'stopped', 'deactivated', 'dormant'].includes(
        this.stateValue,
      )
    ) {
      return this.refuse('uninstall', 'KF_KFX_SERVICE_LIFECYCLE_INVALID');
    }
    this.stateValue = 'uninstalled';
    this.replay.clear();
    this.rate.length = 0;
    return this.receipt('uninstall', 'applied', null);
  }

  public updateDependencies(
    dependencies: KfxServiceDependencyEvidence[],
    dependencyRoot: string | null,
  ): KfxServiceReceipt {
    this.evidence = { ...this.evidence, dependencies, dependencyRoot };
    if (!this.dependenciesEligible()) {
      this.stateValue = 'dormant';
      return this.receipt(
        'dependencies',
        'applied',
        'KF_KFX_SERVICE_DEPENDENCY_DORMANT',
      );
    }
    if (this.stateValue === 'dormant') this.stateValue = 'installed';
    return this.receipt('dependencies', 'applied', null);
  }

  private pruneWindows(now: number): void {
    const { rateWindowMs, replayWindowMs } = this.declaration.webhook.intake;
    while (this.rate[0] !== undefined && this.rate[0] <= now - rateWindowMs) {
      this.rate.shift();
    }
    for (const [key, observed] of this.replay) {
      if (observed <= now - replayWindowMs) this.replay.delete(key);
    }
  }

  public async intake(
    request: KfxWebhookRequest,
  ): Promise<KfxWebhookIntakeResult<Event>> {
    const operation = 'webhook-intake';
    if (this.stateValue !== 'ready') {
      return {
        accepted: false,
        receipt: this.refuse(operation, 'KF_KFX_SERVICE_LIFECYCLE_INVALID'),
      };
    }
    const authority = this.authorityCode();
    if (authority) {
      return { accepted: false, receipt: this.refuse(operation, authority) };
    }
    const listener = this.listenerCode();
    if (listener) {
      return { accepted: false, receipt: this.refuse(operation, listener) };
    }
    const policy = this.declaration.webhook;
    if (!policy.listener.methods.includes(request.method as 'POST' | 'PUT')) {
      return {
        accepted: false,
        receipt: this.refuse(operation, 'KF_KFX_WEBHOOK_METHOD_UNSUPPORTED'),
      };
    }
    if (request.path !== policy.listener.path) {
      return {
        accepted: false,
        receipt: this.refuse(operation, 'KF_KFX_WEBHOOK_PATH_UNSUPPORTED'),
      };
    }
    if (request.body.byteLength > policy.intake.maxPayloadBytes) {
      return {
        accepted: false,
        receipt: this.refuse(operation, 'KF_KFX_WEBHOOK_OVERSIZED', {
          payloadBytes: request.body.byteLength,
        }),
      };
    }
    const now = this.clock.now();
    this.pruneWindows(now);
    if (this.rate.length >= policy.intake.maxRequestsPerWindow) {
      return {
        accepted: false,
        receipt: this.refuse(operation, 'KF_KFX_WEBHOOK_RATE_EXCEEDED'),
      };
    }
    if (!request.replayKey || this.replay.has(request.replayKey)) {
      return {
        accepted: false,
        receipt: this.refuse(operation, 'KF_KFX_WEBHOOK_REPLAYED'),
      };
    }
    if (
      this.inflight >= policy.intake.maxInflight ||
      this.inflight >= policy.intake.maxQueueDepth
    ) {
      return {
        accepted: false,
        receipt: this.refuse(operation, 'KF_KFX_WEBHOOK_QUEUE_FULL'),
      };
    }
    if (!request.signature) {
      return {
        accepted: false,
        receipt: this.refuse(operation, 'KF_KFX_WEBHOOK_UNSIGNED'),
      };
    }
    const credential = policy.credentials.find(
      (candidate) => candidate.handle === this.handler.credentialHandle,
    );
    if (
      !credential ||
      !credential.algorithms.includes(this.handler.algorithm)
    ) {
      return {
        accepted: false,
        receipt: this.refuse(operation, 'KF_KFX_SERVICE_UNAUTHORIZED'),
      };
    }

    this.rate.push(now);
    this.replay.set(request.replayKey, now);
    this.inflight += 1;
    const admittedGeneration = this.generationValue;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const expired = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('handler-timeout')),
          policy.intake.handlerTimeoutMs,
        );
      });
      let verified = false;
      try {
        verified = await Promise.race([
          this.broker.verify({
            handle: credential.handle,
            algorithm: this.handler.algorithm,
            body: request.body,
            signature: request.signature,
            headers: request.headers,
          }),
          expired,
        ]);
      } catch (error) {
        // Broker failures are intentionally collapsed to one stable diagnostic;
        // provider errors and credential material never enter receipts or logs.
        if (error instanceof Error && error.message === 'handler-timeout') {
          return {
            accepted: false,
            receipt: this.refuse(operation, 'KF_KFX_WEBHOOK_TIMEOUT'),
          };
        }
      }
      if (!verified) {
        return {
          accepted: false,
          receipt: this.refuse(
            operation,
            'KF_KFX_WEBHOOK_AUTHENTICATION_FAILED',
          ),
        };
      }
      try {
        const event = await Promise.race([
          this.handler.normalize({
            method: request.method,
            path: request.path,
            headers: request.headers,
            body: request.body,
          }),
          expired,
        ]);
        const currentAuthority = this.authorityCode();
        if (currentAuthority) {
          return {
            accepted: false,
            receipt: this.refuse(operation, currentAuthority),
          };
        }
        if (
          !['ready', 'draining'].includes(this.stateValue) ||
          this.generationValue !== admittedGeneration
        ) {
          return {
            accepted: false,
            receipt: this.refuse(operation, 'KF_KFX_SERVICE_LIFECYCLE_INVALID'),
          };
        }
        await Promise.race([this.handler.onEvent(event), expired]);
        return {
          accepted: true,
          event,
          receipt: this.receipt(operation, 'applied', null, {
            payloadBytes: request.body.byteLength,
          }),
        };
      } catch (error) {
        const code =
          error instanceof Error && error.message === 'handler-timeout'
            ? 'KF_KFX_WEBHOOK_TIMEOUT'
            : 'KF_KFX_WEBHOOK_NORMALIZATION_FAILED';
        return { accepted: false, receipt: this.refuse(operation, code) };
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      this.inflight -= 1;
    }
  }
}
