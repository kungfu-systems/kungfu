// SPDX-License-Identifier: Apache-2.0

import {
  UPGRADE_GUIDE_URL,
  type UpgradeMessage,
  upgradeUserMessage,
} from './upgrade-message';

export type ReleaseManifest = {
  schema: 'kungfu.product-upgrade.manifest/v1';
  productVersion: string;
  runtimeBuildId: string;
  documentationUrl: string;
  [key: string]: unknown;
};

export type RuntimeUpgradePlan = {
  schema: 'kungfu.runtime-upgrade-plan/v1';
  planId: string;
  state: string;
  reasonCode: string;
  activeGeneration: string | null;
  impact: {
    activeWorkContinues: boolean;
    activationTiming: string;
    userActionRequired: boolean;
  };
  nextAction: string;
  [key: string]: unknown;
};

export type RuntimeUpgradeReceipt = {
  schema: 'kungfu.runtime-upgrade-receipt/v1';
  receiptId: string;
  planId: string;
  state: string;
  reasonCode: string;
  [key: string]: unknown;
};

export type DesktopUpdateInfo = {
  version: string;
  releaseManifest: ReleaseManifest;
  downloadedFile?: string;
};

export type DesktopUpdaterEvent =
  | { type: 'checking-for-update' }
  | { type: 'update-available'; info: DesktopUpdateInfo }
  | { type: 'update-not-available' }
  | { type: 'download-progress'; percent: number }
  | { type: 'update-downloaded'; info: DesktopUpdateInfo }
  | { type: 'error'; message: string };

export interface DesktopUpdater {
  subscribe(listener: (event: DesktopUpdaterEvent) => void): () => void;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  quitAndInstall(): void;
}

export interface RuntimeUpgradeBridge {
  installBundledRuntime(
    manifest: ReleaseManifest,
    bundledRuntimeRoot: string,
  ): Promise<Record<string, unknown>>;
  plan(manifest: ReleaseManifest): Promise<RuntimeUpgradePlan>;
  stage(plan: RuntimeUpgradePlan): Promise<RuntimeUpgradeReceipt>;
  reconcile(
    receipt: RuntimeUpgradeReceipt,
    readinessPassed: boolean,
  ): Promise<RuntimeUpgradeReceipt>;
}

export type DesktopUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installer-handoff'
  | 'reconciling'
  | 'deferred'
  | 'complete'
  | 'action-required'
  | 'error';

export type DesktopUpdateState = {
  schema: 'kungfu.desktop-update-state/v1';
  phase: DesktopUpdatePhase;
  version: string | null;
  manifest: ReleaseManifest | null;
  plan: RuntimeUpgradePlan | null;
  receipt: RuntimeUpgradeReceipt | null;
  progressPercent: number | null;
  reasonCode: string;
  nextAction: string;
  documentationUrl: string;
  error: string;
  message: UpgradeMessage | null;
  updatedAtMs: number;
};

export interface DesktopUpdateStateStore {
  load(): DesktopUpdateState | null;
  save(state: DesktopUpdateState): void;
}

type UpdateControllerDeps = {
  updater: DesktopUpdater;
  core: RuntimeUpgradeBridge;
  store: DesktopUpdateStateStore;
  now?: () => number;
};

const DOWNLOAD_STATES = new Set(['download-allowed', 'apply-now']);
const CHECK_START_PHASES = new Set<DesktopUpdatePhase>([
  'idle',
  'checking',
  'error',
]);
const TRANSPORT_EVENT_PHASES = new Set<DesktopUpdatePhase>([
  'checking',
  'available',
  'downloading',
  'downloaded',
  'installer-handoff',
  'error',
]);
const ACTIVE_TRANSPORT_PHASES = new Set<DesktopUpdatePhase>([
  'downloading',
  'installer-handoff',
]);
const RECONCILIATION_BLOCKED_PHASES = new Set<DesktopUpdatePhase>([
  ...ACTIVE_TRANSPORT_PHASES,
  'downloaded',
]);

function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (
      input === null ||
      typeof input === 'string' ||
      typeof input === 'boolean'
    ) {
      return input;
    }
    if (typeof input === 'number' && Number.isFinite(input)) {
      return input;
    }
    if (Array.isArray(input)) {
      return input.map(normalize);
    }
    if (typeof input === 'object') {
      const record = input as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, normalize(record[key])]),
      );
    }
    throw new Error('Release manifest contains a non-JSON value');
  };

  return JSON.stringify(normalize(value));
}

function stagedRecovery(
  state: DesktopUpdateState,
  manifest: ReleaseManifest,
): {
  plan: RuntimeUpgradePlan;
  receipt: RuntimeUpgradeReceipt;
} | null {
  if (
    state.version !== manifest.productVersion ||
    !state.manifest ||
    !state.plan ||
    state.plan.state !== 'apply-now' ||
    !state.receipt ||
    state.receipt.state !== 'reconciling' ||
    state.receipt.planId !== state.plan.planId
  ) {
    return null;
  }
  try {
    if (canonicalJson(state.manifest) !== canonicalJson(manifest)) return null;
  } catch {
    return null;
  }
  return { plan: state.plan, receipt: state.receipt };
}

function initialState(now: number): DesktopUpdateState {
  return {
    schema: 'kungfu.desktop-update-state/v1',
    phase: 'idle',
    version: null,
    manifest: null,
    plan: null,
    receipt: null,
    progressPercent: null,
    reasonCode: '',
    nextAction: '',
    documentationUrl: '',
    error: '',
    message: null,
    updatedAtMs: now,
  };
}

function desktopUpdaterFailureState(
  now: number,
  error: string,
): DesktopUpdateState {
  const reasonCode = 'desktop-updater-error';
  const message = upgradeUserMessage(reasonCode, UPGRADE_GUIDE_URL);
  return {
    ...initialState(now),
    phase: 'error',
    reasonCode,
    nextAction: message.userAction,
    documentationUrl: message.documentationUrl,
    error,
    message,
  };
}

function persistenceFailureState(now: number): DesktopUpdateState {
  return desktopUpdaterFailureState(
    now,
    'Desktop update state could not be saved. No updater action was started.',
  );
}

function recoverRestoredState(
  restored: DesktopUpdateState,
  now: number,
): DesktopUpdateState {
  const state = { ...restored, message: restored.message ?? null };
  if (state.phase === 'checking') return initialState(now);
  if (state.phase === 'installer-handoff') {
    return desktopUpdaterFailureState(
      now,
      'The previous desktop installer handoff did not prove that the new frontend started. Check for updates again; no installer action was replayed.',
    );
  }
  if (
    state.phase === 'available' ||
    state.phase === 'downloading' ||
    state.phase === 'downloaded'
  ) {
    return desktopUpdaterFailureState(
      now,
      'The previous desktop updater transport was interrupted by a process restart. Check for updates again; no saved updater handle can authorize a download or install.',
    );
  }
  return state;
}

export class UpdateController {
  private readonly updater: DesktopUpdater;
  private readonly core: RuntimeUpgradeBridge;
  private readonly store: DesktopUpdateStateStore;
  private readonly now: () => number;
  private state: DesktopUpdateState;
  private unsubscribe: (() => void) | null = null;
  private eventQueue: Promise<void> = Promise.resolve();
  private transportEpoch = 0;
  private activeReconciliation: {
    identity: string;
    promise: Promise<DesktopUpdateState>;
  } | null = null;

  constructor(deps: UpdateControllerDeps) {
    this.updater = deps.updater;
    this.core = deps.core;
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    const restored = deps.store.load();
    this.state = restored
      ? recoverRestoredState(restored, this.now())
      : initialState(this.now());
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.updater.subscribe((event) => {
      this.eventQueue = this.eventQueue
        .then(() => this.handleEvent(event))
        .catch((error: unknown) => {
          try {
            this.commit({
              phase: 'error',
              error: error instanceof Error ? error.message : String(error),
            });
          } catch {
            // `commit` already installed a fail-closed in-memory state. Keep
            // the event queue usable even while persistence remains offline.
          }
        });
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  snapshot(): DesktopUpdateState {
    return structuredClone(this.state);
  }

  async whenIdle(): Promise<void> {
    await this.eventQueue;
  }

  async checkForUpdates(): Promise<void> {
    if (this.activeReconciliation || this.state.phase === 'reconciling') {
      throw new Error(
        'Cannot check for desktop updates while runtime reconciliation is active',
      );
    }
    if (ACTIVE_TRANSPORT_PHASES.has(this.state.phase)) {
      throw new Error(
        'Cannot check for desktop updates while an update transport action is active',
      );
    }
    this.transportEpoch += 1;
    this.commit({
      phase: 'checking',
      version: null,
      manifest: null,
      plan: null,
      receipt: null,
      progressPercent: null,
      reasonCode: '',
      nextAction: '',
      documentationUrl: '',
      error: '',
      message: null,
    });
    try {
      await this.updater.checkForUpdates();
      await this.whenIdle();
    } catch (error) {
      this.failTransport(error, 'Desktop update check failed');
    }
  }

  async downloadUpdate(): Promise<void> {
    if (
      this.state.phase !== 'available' ||
      !this.state.plan ||
      !DOWNLOAD_STATES.has(this.state.plan.state)
    ) {
      throw new Error('No available desktop update is ready to download');
    }
    this.commit({ phase: 'downloading', progressPercent: 0, error: '' });
    try {
      await this.updater.downloadUpdate();
      await this.whenIdle();
    } catch (error) {
      this.failTransport(error, 'Desktop update download failed');
    }
  }

  async applyDownloadedUpdate(): Promise<DesktopUpdateState> {
    if (
      this.state.phase !== 'downloaded' ||
      !this.state.plan ||
      !this.state.manifest
    ) {
      throw new Error('No planned desktop update is ready to install');
    }
    const plannedVersion = this.state.version;
    const plannedManifest = this.state.manifest;
    const freshPlan = await this.core.plan(plannedManifest);
    if (
      this.state.phase !== 'downloaded' ||
      this.state.version !== plannedVersion ||
      !this.state.manifest ||
      canonicalJson(this.state.manifest) !== canonicalJson(plannedManifest)
    ) {
      throw new Error('Downloaded update changed while Core replanned handoff');
    }
    this.commit({
      plan: freshPlan,
      reasonCode: freshPlan.reasonCode,
      nextAction: freshPlan.nextAction,
    });
    if (!DOWNLOAD_STATES.has(freshPlan.state)) {
      this.commit({
        phase: freshPlan.impact.userActionRequired
          ? 'action-required'
          : 'deferred',
      });
      return this.snapshot();
    }
    this.commit({
      phase: 'installer-handoff',
      reasonCode: freshPlan.reasonCode,
      nextAction:
        'Restart into the downloaded desktop build, then reconcile its bundled runtime through Core.',
    });
    try {
      this.updater.quitAndInstall();
    } catch (error) {
      this.failTransport(error, 'Desktop installer handoff failed');
    }
    return this.snapshot();
  }

  reconcileBundledRuntime(
    manifest: ReleaseManifest,
    bundledRuntimeRoot: string,
    readinessProbe: () => Promise<boolean>,
  ): Promise<DesktopUpdateState> {
    const identity = canonicalJson({ manifest, bundledRuntimeRoot });
    if (this.activeReconciliation) {
      if (this.activeReconciliation.identity === identity) {
        return this.activeReconciliation.promise;
      }
      return Promise.reject(
        new Error(
          'Runtime reconciliation is already active for a different release or runtime root',
        ),
      );
    }
    if (RECONCILIATION_BLOCKED_PHASES.has(this.state.phase)) {
      return Promise.reject(
        new Error(
          'Runtime reconciliation cannot start while desktop update transport is active',
        ),
      );
    }

    let resolveRun!: (state: DesktopUpdateState) => void;
    let rejectRun!: (reason?: unknown) => void;
    const result = new Promise<DesktopUpdateState>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    const guarded = result.finally(() => {
      if (this.activeReconciliation?.promise === guarded) {
        this.activeReconciliation = null;
      }
    });
    this.activeReconciliation = { identity, promise: guarded };
    void this.reconcileBundledRuntimeOnce(
      manifest,
      bundledRuntimeRoot,
      readinessProbe,
    ).then(resolveRun, rejectRun);
    return guarded;
  }

  private async reconcileBundledRuntimeOnce(
    manifest: ReleaseManifest,
    bundledRuntimeRoot: string,
    readinessProbe: () => Promise<boolean>,
  ): Promise<DesktopUpdateState> {
    const recovery = stagedRecovery(this.state, manifest);
    this.commit({
      phase: 'reconciling',
      version: manifest.productVersion,
      manifest,
      plan: recovery?.plan ?? null,
      receipt: recovery?.receipt ?? null,
      progressPercent: null,
      reasonCode: recovery?.plan.reasonCode ?? '',
      nextAction: recovery?.plan.nextAction ?? '',
      documentationUrl: manifest.documentationUrl,
      error: '',
      message: null,
    });
    try {
      await this.core.installBundledRuntime(manifest, bundledRuntimeRoot);
      if (recovery) {
        return await this.reconcileReceipt(recovery.receipt, readinessProbe);
      }
      const plan = await this.core.plan(manifest);
      this.commit({
        plan,
        reasonCode: plan.reasonCode,
        nextAction: plan.nextAction,
      });
      if (plan.state === 'complete') {
        this.commit({ phase: 'complete' });
        return this.snapshot();
      }
      if (plan.state !== 'apply-now') {
        this.commit({
          phase: plan.impact.userActionRequired
            ? 'action-required'
            : 'deferred',
        });
        return this.snapshot();
      }
      const receipt = await this.core.stage(plan);
      this.commit({ receipt });
      return await this.reconcileReceipt(receipt, readinessProbe);
    } catch (error) {
      if (this.state.phase !== 'error') {
        const reasonCode = 'desktop-updater-error';
        const message = upgradeUserMessage(
          reasonCode,
          manifest.documentationUrl || UPGRADE_GUIDE_URL,
        );
        this.commit({
          phase: 'error',
          reasonCode,
          nextAction: message.userAction,
          documentationUrl: message.documentationUrl,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  private async reconcileReceipt(
    receipt: RuntimeUpgradeReceipt,
    readinessProbe: () => Promise<boolean>,
  ): Promise<DesktopUpdateState> {
    let readinessPassed = false;
    try {
      readinessPassed = await readinessProbe();
    } catch {
      // Core owns rollback and the durable failure receipt for readiness faults.
    }
    const reconciled = await this.core.reconcile(receipt, readinessPassed);
    this.commit({
      receipt: reconciled,
      phase: reconciled.state === 'complete' ? 'complete' : 'action-required',
      reasonCode: reconciled.reasonCode,
    });
    return this.snapshot();
  }

  private failTransport(error: unknown, context: string): never {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      this.commit(
        desktopUpdaterFailureState(this.now(), `${context}: ${detail}`),
      );
    } catch {
      // `commit` installed the persistence fail-closed state in memory.
    }
    throw error;
  }

  private async handleEvent(event: DesktopUpdaterEvent): Promise<void> {
    switch (event.type) {
      case 'checking-for-update':
        if (!CHECK_START_PHASES.has(this.state.phase)) return;
        if (this.state.phase !== 'checking') this.transportEpoch += 1;
        this.commit({ phase: 'checking', error: '' });
        return;
      case 'update-not-available':
        if (!TRANSPORT_EVENT_PHASES.has(this.state.phase)) return;
        this.commit({
          phase: 'idle',
          version: null,
          manifest: null,
          plan: null,
          receipt: null,
          progressPercent: null,
          reasonCode: '',
          nextAction: '',
          documentationUrl: '',
          error: '',
          message: null,
        });
        return;
      case 'download-progress':
        if (this.state.phase !== 'downloading') return;
        this.commit({
          phase: 'downloading',
          progressPercent: Math.max(0, Math.min(100, event.percent)),
        });
        return;
      case 'error':
        if (!TRANSPORT_EVENT_PHASES.has(this.state.phase)) return;
        this.commit(
          desktopUpdaterFailureState(
            this.now(),
            `Desktop updater event failed: ${event.message}`,
          ),
        );
        return;
      case 'update-available': {
        if (this.state.phase !== 'checking') return;
        const transportEpoch = this.transportEpoch;
        let plan: RuntimeUpgradePlan;
        try {
          plan = await this.core.plan(event.info.releaseManifest);
        } catch (error) {
          if (
            this.state.phase !== 'checking' ||
            this.transportEpoch !== transportEpoch
          ) {
            return;
          }
          throw error;
        }
        if (
          this.state.phase !== 'checking' ||
          this.transportEpoch !== transportEpoch
        ) {
          return;
        }
        this.commit({
          phase: 'available',
          version: event.info.version,
          manifest: event.info.releaseManifest,
          plan,
          receipt: null,
          progressPercent: null,
          reasonCode: plan.reasonCode,
          nextAction: plan.nextAction,
          documentationUrl: event.info.releaseManifest.documentationUrl,
          error: '',
        });
        return;
      }
      case 'update-downloaded':
        if (this.state.phase !== 'downloading') {
          this.commit({
            phase: 'error',
            error: 'Downloaded update arrived outside an active download',
          });
          return;
        }
        if (
          !this.state.manifest ||
          this.state.version !== event.info.version ||
          canonicalJson(this.state.manifest) !==
            canonicalJson(event.info.releaseManifest)
        ) {
          this.commit({
            phase: 'error',
            error: 'Downloaded update does not match the current Core plan',
          });
          return;
        }
        this.commit({
          phase: 'downloaded',
          version: event.info.version,
          progressPercent: 100,
        });
    }
  }

  private commit(patch: Partial<DesktopUpdateState>): void {
    const next: DesktopUpdateState = {
      ...this.state,
      ...patch,
      schema: 'kungfu.desktop-update-state/v1',
      updatedAtMs: this.now(),
    };
    const messageReasonCode =
      patch.phase === 'error' ? 'desktop-updater-error' : next.reasonCode;
    if (messageReasonCode) {
      next.message = upgradeUserMessage(
        messageReasonCode,
        next.documentationUrl || UPGRADE_GUIDE_URL,
        (next.plan?.impact ?? {}) as Record<string, unknown>,
      );
    }
    this.state = next;
    try {
      this.store.save(this.snapshot());
    } catch (error) {
      this.state = persistenceFailureState(this.now());
      throw error;
    }
  }
}
