// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type DesktopUpdateInfo,
  type DesktopUpdateState,
  type DesktopUpdaterEvent,
  type ReleaseManifest,
  type RuntimeUpgradePlan,
  type RuntimeUpgradeReceipt,
  UpdateController,
} from './update-controller';

const manifest: ReleaseManifest = {
  schema: 'kungfu.product-upgrade.manifest/v1',
  productVersion: '4.0.0-alpha.1',
  runtimeBuildId: 'runtime-b',
  frontendBuildId: 'frontend-b',
  sourceCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  documentationUrl: 'https://www.kungfu.tech/docs/guides/upgrading',
};

const updateInfo: DesktopUpdateInfo = {
  version: manifest.productVersion,
  releaseManifest: manifest,
  downloadedFile: '/tmp/update.zip',
};

function plan(state: string, userActionRequired = false): RuntimeUpgradePlan {
  const reasonCode = {
    'apply-now': 'workspace-idle',
    'defer-until-idle': 'active-work-incompatible',
  }[state];
  return {
    schema: 'kungfu.runtime-upgrade-plan/v1',
    planId: `plan-${state}`,
    state,
    reasonCode: reasonCode ?? 'target-not-installed',
    activeGeneration: '7',
    impact: {
      activeWorkContinues: state !== 'apply-now',
      activationTiming: state === 'apply-now' ? 'now' : 'after-safe-point',
      userActionRequired,
    },
    nextAction: `Core next action for ${state}`,
  };
}

function receipt(state = 'reconciling'): RuntimeUpgradeReceipt {
  return {
    schema: 'kungfu.runtime-upgrade-receipt/v1',
    receiptId: 'receipt-1',
    planId: 'plan-apply-now',
    state,
    reasonCode: state === 'complete' ? 'workspace-idle' : 'readiness-failed',
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function desktopState(
  phase: DesktopUpdateState['phase'],
  overrides: Partial<DesktopUpdateState> = {},
): DesktopUpdateState {
  const downloadPlan = plan('download-allowed');
  return {
    schema: 'kungfu.desktop-update-state/v1',
    phase,
    version: manifest.productVersion,
    manifest,
    plan: downloadPlan,
    receipt: null,
    progressPercent: phase === 'downloaded' ? 100 : 50,
    reasonCode: downloadPlan.reasonCode,
    nextAction: downloadPlan.nextAction,
    documentationUrl: manifest.documentationUrl,
    error: '',
    message: null,
    updatedAtMs: 122,
    ...overrides,
  };
}

function fixture(
  plans: RuntimeUpgradePlan[],
  options: {
    save?: (value: DesktopUpdateState) => void;
    load?: DesktopUpdateState | null;
    checkForUpdates?: () => void | Promise<void>;
    downloadUpdate?: () => void | Promise<void>;
    quitAndInstall?: () => void;
    installBundledRuntime?: () => void | Promise<void>;
    reconcile?: () => void | Promise<void>;
    plan?: (
      manifest: ReleaseManifest,
    ) => RuntimeUpgradePlan | Promise<RuntimeUpgradePlan>;
  } = {},
) {
  let listener: ((event: DesktopUpdaterEvent) => void) | null = null;
  let quitAndInstallCalls = 0;
  let downloadUpdateCalls = 0;
  const saved: unknown[] = [];
  const staged: RuntimeUpgradePlan[] = [];
  const reconciled: boolean[] = [];
  const controller = new UpdateController({
    updater: {
      subscribe(next) {
        listener = next;
        return () => {
          listener = null;
        };
      },
      async checkForUpdates() {
        await options.checkForUpdates?.();
      },
      async downloadUpdate() {
        downloadUpdateCalls += 1;
        await options.downloadUpdate?.();
      },
      quitAndInstall() {
        quitAndInstallCalls += 1;
        options.quitAndInstall?.();
      },
    },
    core: {
      async installBundledRuntime() {
        await options.installBundledRuntime?.();
        return { state: 'verified' };
      },
      async plan(value) {
        if (options.plan) return await options.plan(value);
        const planned = plans.shift();
        assert.ok(planned, 'fixture exhausted its Core plans');
        return planned;
      },
      async stage(value) {
        staged.push(value);
        return receipt();
      },
      async reconcile(_receipt, readinessPassed) {
        await options.reconcile?.();
        reconciled.push(readinessPassed);
        return receipt(readinessPassed ? 'complete' : 'failed-rolled-back');
      },
    },
    store: {
      load: () => options.load ?? null,
      save: (value) =>
        options.save ? options.save(value) : void saved.push(value),
    },
    now: () => 123,
  });
  controller.start();
  return {
    controller,
    announceUpdate(info: DesktopUpdateInfo = updateInfo) {
      assert.ok(listener);
      listener({ type: 'checking-for-update' });
      listener({ type: 'update-available', info });
    },
    emit(event: DesktopUpdaterEvent) {
      assert.ok(listener);
      listener(event);
    },
    quitAndInstallCalls: () => quitAndInstallCalls,
    downloadUpdateCalls: () => downloadUpdateCalls,
    saved,
    staged,
    reconciled,
  };
}

test('desktop installer handoff requires a Core download plan', async () => {
  const f = fixture([plan('download-allowed'), plan('download-allowed')]);
  f.announceUpdate();
  await f.controller.whenIdle();
  await f.controller.downloadUpdate();
  f.emit({ type: 'update-downloaded', info: updateInfo });
  await f.controller.whenIdle();

  assert.equal(f.quitAndInstallCalls(), 0);
  await f.controller.applyDownloadedUpdate();
  assert.equal(f.quitAndInstallCalls(), 1);
  assert.equal(f.controller.snapshot().phase, 'installer-handoff');
  assert.equal(f.controller.snapshot().plan?.planId, 'plan-download-allowed');
});

test('installer handoff replans after download before restarting the app', async () => {
  const f = fixture([plan('download-allowed'), plan('defer-until-idle')]);
  f.announceUpdate();
  await f.controller.whenIdle();
  await f.controller.downloadUpdate();
  f.emit({ type: 'update-downloaded', info: updateInfo });
  await f.controller.whenIdle();

  await f.controller.applyDownloadedUpdate();

  assert.equal(f.quitAndInstallCalls(), 0);
  assert.equal(f.controller.snapshot().phase, 'deferred');
  assert.equal(f.controller.snapshot().plan?.state, 'defer-until-idle');
  assert.equal(f.controller.snapshot().reasonCode, 'active-work-incompatible');
});

test('update-not-available revokes stale download authority', async () => {
  const f = fixture([plan('download-allowed')]);
  f.announceUpdate();
  await f.controller.whenIdle();
  f.emit({ type: 'update-not-available' });
  await f.controller.whenIdle();

  await assert.rejects(
    f.controller.downloadUpdate(),
    /available desktop update/i,
  );
  assert.equal(f.controller.snapshot().phase, 'idle');
  assert.equal(f.controller.snapshot().manifest, null);
  assert.equal(f.controller.snapshot().plan, null);
  assert.equal(f.controller.snapshot().message, null);
});

test('an unsolicited available event cannot grant transport authority', async () => {
  const plans = [plan('download-allowed')];
  const f = fixture(plans);

  f.emit({ type: 'update-available', info: updateInfo });
  await f.controller.whenIdle();

  assert.equal(f.controller.snapshot().phase, 'idle');
  assert.equal(f.controller.snapshot().manifest, null);
  assert.equal(f.controller.snapshot().plan, null);
  assert.equal(plans.length, 1);
});

test('a stale available event cannot replace an active download', async () => {
  const plans = [plan('download-allowed'), plan('download-allowed')];
  const f = fixture(plans);
  f.announceUpdate();
  await f.controller.whenIdle();
  await f.controller.downloadUpdate();

  f.emit({
    type: 'update-available',
    info: {
      ...updateInfo,
      version: '4.0.0-alpha.2',
      releaseManifest: {
        ...manifest,
        productVersion: '4.0.0-alpha.2',
        sourceCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    },
  });
  await f.controller.whenIdle();

  const state = f.controller.snapshot();
  assert.equal(state.phase, 'downloading');
  assert.equal(state.version, manifest.productVersion);
  assert.deepEqual(state.manifest, manifest);
  assert.equal(plans.length, 1);
});

test('a delayed available plan cannot replace Core reconciliation', async () => {
  const availablePlan = deferred<RuntimeUpgradePlan>();
  const install = deferred<void>();
  const planStarted = deferred<void>();
  let planCalls = 0;
  const f = fixture([], {
    plan() {
      planCalls += 1;
      if (planCalls === 1) {
        planStarted.resolve(undefined);
        return availablePlan.promise;
      }
      return plan('complete');
    },
    installBundledRuntime: () => install.promise,
  });
  f.announceUpdate();
  await planStarted.promise;

  const reconciliation = f.controller.reconcileBundledRuntime(
    manifest,
    '/app/Resources/kungfu',
    async () => true,
  );
  availablePlan.resolve(plan('download-allowed'));
  await f.controller.whenIdle();
  const phaseWhileInstallPending = f.controller.snapshot().phase;
  install.resolve(undefined);
  const reconciled = await reconciliation;

  assert.equal(phaseWhileInstallPending, 'reconciling');
  assert.equal(reconciled.phase, 'complete');
});

test('a delayed available-plan failure cannot erase Core reconciliation', async () => {
  const availablePlan = deferred<RuntimeUpgradePlan>();
  const install = deferred<void>();
  const planStarted = deferred<void>();
  let planCalls = 0;
  const f = fixture([], {
    plan() {
      planCalls += 1;
      if (planCalls === 1) {
        planStarted.resolve(undefined);
        return availablePlan.promise;
      }
      return plan('complete');
    },
    installBundledRuntime: () => install.promise,
  });
  f.announceUpdate();
  await planStarted.promise;

  const reconciliation = f.controller.reconcileBundledRuntime(
    manifest,
    '/app/Resources/kungfu',
    async () => true,
  );
  availablePlan.reject(new Error('stale plan failed'));
  await f.controller.whenIdle();
  const phaseWhileInstallPending = f.controller.snapshot().phase;
  install.resolve(undefined);
  const reconciled = await reconciliation;

  assert.equal(phaseWhileInstallPending, 'reconciling');
  assert.equal(reconciled.phase, 'complete');
});

test('a second check invalidates an earlier pending available plan', async () => {
  const availablePlan = deferred<RuntimeUpgradePlan>();
  const planStarted = deferred<void>();
  const f = fixture([], {
    plan() {
      planStarted.resolve(undefined);
      return availablePlan.promise;
    },
  });
  f.announceUpdate();
  await planStarted.promise;

  const secondCheck = f.controller.checkForUpdates();
  availablePlan.resolve(plan('download-allowed'));
  await secondCheck;

  assert.equal(f.controller.snapshot().phase, 'checking');
  assert.equal(f.controller.snapshot().manifest, null);
  assert.equal(f.controller.snapshot().plan, null);
});

test('an unsolicited downloaded event cannot grant installer authority', async () => {
  const f = fixture([plan('download-allowed')]);
  f.announceUpdate();
  await f.controller.whenIdle();

  f.emit({ type: 'update-downloaded', info: updateInfo });
  await f.controller.whenIdle();

  assert.equal(f.controller.snapshot().phase, 'error');
  assert.equal(f.quitAndInstallCalls(), 0);
});

test('stale progress cannot revive a revoked download', async () => {
  const f = fixture([plan('download-allowed')]);
  f.announceUpdate();
  await f.controller.whenIdle();
  await f.controller.downloadUpdate();
  f.emit({ type: 'update-not-available' });
  await f.controller.whenIdle();

  f.emit({ type: 'download-progress', percent: 50 });
  await f.controller.whenIdle();

  assert.equal(f.controller.snapshot().phase, 'idle');
  assert.equal(f.controller.snapshot().progressPercent, null);
});

test('a failed update check clears previous transport authority', async () => {
  const f = fixture([plan('download-allowed')], {
    checkForUpdates() {
      throw new Error('update feed unavailable');
    },
  });
  f.announceUpdate();
  await f.controller.whenIdle();

  await assert.rejects(
    f.controller.checkForUpdates(),
    /update feed unavailable/i,
  );

  const state = f.controller.snapshot();
  assert.equal(state.phase, 'error');
  assert.equal(state.manifest, null);
  assert.equal(state.plan, null);
  assert.equal(state.receipt, null);
});

test('a failed updater download revokes transport authority', async () => {
  const f = fixture([plan('download-allowed')], {
    downloadUpdate() {
      throw new Error('download transport failed');
    },
  });
  f.announceUpdate();
  await f.controller.whenIdle();

  await assert.rejects(
    f.controller.downloadUpdate(),
    /download transport failed/i,
  );

  const state = f.controller.snapshot();
  assert.equal(state.phase, 'error');
  assert.equal(state.manifest, null);
  assert.equal(state.plan, null);
  assert.equal(state.receipt, null);
});

test('an updater error event revokes transport authority', async () => {
  const f = fixture([plan('download-allowed')]);
  f.announceUpdate();
  await f.controller.whenIdle();

  f.emit({ type: 'error', message: 'updater event failed' });
  await f.controller.whenIdle();

  const state = f.controller.snapshot();
  assert.equal(state.phase, 'error');
  assert.equal(state.manifest, null);
  assert.equal(state.plan, null);
  assert.equal(state.receipt, null);
  assert.match(state.error, /updater event failed/i);
});

test('stale updater events cannot erase an active Core receipt', async () => {
  const stagedPlan = plan('apply-now');
  const stagedReceipt = receipt();
  const staleEvents: DesktopUpdaterEvent[] = [
    { type: 'checking-for-update' },
    { type: 'update-not-available' },
    { type: 'error', message: 'late updater transport error' },
  ];

  for (const event of staleEvents) {
    const f = fixture([], {
      load: desktopState('reconciling', {
        plan: stagedPlan,
        receipt: stagedReceipt,
        progressPercent: null,
        reasonCode: stagedPlan.reasonCode,
        nextAction: stagedPlan.nextAction,
      }),
    });

    f.emit(event);
    await f.controller.whenIdle();

    const state = f.controller.snapshot();
    assert.equal(state.phase, 'reconciling');
    assert.deepEqual(state.plan, stagedPlan);
    assert.deepEqual(state.receipt, stagedReceipt);
  }
});

test('a failed installer handoff revokes transport authority', async () => {
  const f = fixture([plan('download-allowed'), plan('download-allowed')], {
    quitAndInstall() {
      throw new Error('installer handoff failed');
    },
  });
  f.announceUpdate();
  await f.controller.whenIdle();
  await f.controller.downloadUpdate();
  f.emit({ type: 'update-downloaded', info: updateInfo });
  await f.controller.whenIdle();

  await assert.rejects(
    f.controller.applyDownloadedUpdate(),
    /installer handoff failed/i,
  );

  const state = f.controller.snapshot();
  assert.equal(state.phase, 'error');
  assert.equal(state.manifest, null);
  assert.equal(state.plan, null);
  assert.equal(state.receipt, null);
});

test('a restarted check returns to idle without stale authority', () => {
  const f = fixture([], { load: desktopState('checking') });

  const state = f.controller.snapshot();
  assert.equal(state.phase, 'idle');
  assert.equal(state.version, null);
  assert.equal(state.manifest, null);
  assert.equal(state.plan, null);
  assert.equal(state.receipt, null);
});

test('a restarted downloaded update must re-enter the updater download path', async () => {
  const f = fixture([plan('download-allowed'), plan('download-allowed')], {
    load: desktopState('downloaded'),
  });

  const restored = f.controller.snapshot();
  assert.equal(restored.phase, 'error');
  assert.equal(restored.progressPercent, null);
  assert.match(restored.error, /interrupted/i);
  assert.equal(f.downloadUpdateCalls(), 0);
  await assert.rejects(
    f.controller.applyDownloadedUpdate(),
    /ready to install/i,
  );
  await assert.rejects(f.controller.downloadUpdate(), /ready to download/i);

  const checking = f.controller.checkForUpdates();
  f.emit({ type: 'update-available', info: updateInfo });
  await checking;
  assert.equal(f.controller.snapshot().phase, 'available');

  await f.controller.downloadUpdate();
  assert.equal(f.downloadUpdateCalls(), 1);
  f.emit({ type: 'update-downloaded', info: updateInfo });
  await f.controller.whenIdle();
  await f.controller.applyDownloadedUpdate();
  assert.equal(f.quitAndInstallCalls(), 1);
});

test('a restarted in-progress download becomes an explicit retry', () => {
  const f = fixture([], { load: desktopState('downloading') });

  const restored = f.controller.snapshot();
  assert.equal(restored.phase, 'error');
  assert.equal(restored.progressPercent, null);
  assert.match(restored.error, /check for updates again/i);
  assert.equal(f.downloadUpdateCalls(), 0);
  assert.equal(f.quitAndInstallCalls(), 0);
});

test('a persisted available update requires a fresh updater check', async () => {
  const f = fixture([], { load: desktopState('available') });

  const restored = f.controller.snapshot();
  assert.equal(restored.phase, 'error');
  assert.equal(restored.manifest, null);
  assert.equal(restored.plan, null);
  await assert.rejects(f.controller.downloadUpdate(), /ready to download/i);
});

test('an incoherent restarted download fails closed', () => {
  const f = fixture([], {
    load: desktopState('downloading', { plan: null }),
  });

  const state = f.controller.snapshot();
  assert.equal(state.phase, 'error');
  assert.equal(state.manifest, null);
  assert.equal(state.plan, null);
  assert.equal(state.receipt, null);
  assert.equal(state.message?.messageReasonCode, 'action-required');
});

test('an interrupted installer handoff is never replayed automatically', async () => {
  const f = fixture([], { load: desktopState('installer-handoff') });

  const state = f.controller.snapshot();
  assert.equal(state.phase, 'error');
  assert.match(state.error, /installer handoff/i);
  assert.equal(state.plan, null);
  assert.equal(f.quitAndInstallCalls(), 0);
  await assert.rejects(
    f.controller.applyDownloadedUpdate(),
    /ready to install/i,
  );
});

test('event persistence failure becomes a recoverable in-memory error', async () => {
  let failSave = true;
  const persisted: DesktopUpdateState[] = [];
  const f = fixture([], {
    save(value) {
      if (failSave) throw new Error('disk full');
      persisted.push(value);
    },
  });

  f.emit({ type: 'checking-for-update' });
  await f.controller.whenIdle();
  assert.equal(f.controller.snapshot().phase, 'error');
  assert.equal(f.controller.snapshot().plan, null);
  assert.equal(
    f.controller.snapshot().message?.messageReasonCode,
    'action-required',
  );

  failSave = false;
  f.emit({ type: 'update-not-available' });
  await f.controller.whenIdle();

  assert.equal(f.controller.snapshot().phase, 'idle');
  assert.equal(persisted.at(-1)?.phase, 'idle');
});

test('download does not start when its state cannot be persisted', async () => {
  let failSave = false;
  const f = fixture([plan('download-allowed')], {
    save() {
      if (failSave) throw new Error('disk full');
    },
  });
  f.announceUpdate();
  await f.controller.whenIdle();
  failSave = true;

  await assert.rejects(f.controller.downloadUpdate(), /disk full/i);

  assert.equal(f.downloadUpdateCalls(), 0);
  assert.equal(f.controller.snapshot().phase, 'error');
  assert.equal(f.controller.snapshot().plan, null);
});

test('concurrent reconciliation of one release stages only once', async () => {
  const install = deferred<void>();
  const plans = [plan('apply-now'), plan('apply-now')];
  let installCalls = 0;
  const f = fixture(plans, {
    installBundledRuntime() {
      installCalls += 1;
      return install.promise;
    },
  });

  const first = f.controller.reconcileBundledRuntime(
    manifest,
    '/app/Resources/kungfu',
    async () => true,
  );
  const second = f.controller.reconcileBundledRuntime(
    manifest,
    '/app/Resources/kungfu',
    async () => true,
  );
  install.resolve(undefined);
  const [firstState, secondState] = await Promise.all([first, second]);

  assert.equal(firstState.phase, 'complete');
  assert.equal(secondState.phase, 'complete');
  assert.equal(installCalls, 1);
  assert.equal(f.staged.length, 1);
  assert.deepEqual(f.reconciled, [true]);
  assert.equal(plans.length, 1);
});

test('concurrent reconciliation rejects a different release identity', async () => {
  const install = deferred<void>();
  const plans = [plan('complete'), plan('complete')];
  let installCalls = 0;
  const f = fixture(plans, {
    installBundledRuntime() {
      installCalls += 1;
      return install.promise;
    },
  });
  const otherManifest: ReleaseManifest = {
    ...manifest,
    productVersion: '4.0.0-alpha.2',
    sourceCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };

  const first = f.controller.reconcileBundledRuntime(
    manifest,
    '/app/Resources/kungfu',
    async () => true,
  );
  const second = f.controller.reconcileBundledRuntime(
    otherManifest,
    '/app/Resources/kungfu-next',
    async () => true,
  );
  const manifestWhilePending = f.controller.snapshot().manifest;
  install.resolve(undefined);
  const [firstResult, secondResult] = await Promise.allSettled([first, second]);

  assert.deepEqual(manifestWhilePending, manifest);
  assert.equal(firstResult.status, 'fulfilled');
  assert.equal(secondResult.status, 'rejected');
  if (secondResult.status === 'rejected') {
    assert.match(String(secondResult.reason), /different release/i);
  }
  assert.equal(installCalls, 1);
  assert.equal(plans.length, 1);
});

test('reentrant reconciliation during install joins the active release', async () => {
  const plans = [plan('apply-now'), plan('apply-now')];
  let installCalls = 0;
  let reentered = false;
  let nested: Promise<DesktopUpdateState> | null = null;
  const f = fixture(plans, {
    installBundledRuntime() {
      installCalls += 1;
      if (!reentered) {
        reentered = true;
        nested = f.controller.reconcileBundledRuntime(
          manifest,
          '/app/Resources/kungfu',
          async () => true,
        );
      }
    },
  });

  const first = f.controller.reconcileBundledRuntime(
    manifest,
    '/app/Resources/kungfu',
    async () => true,
  );
  const firstState = await first;
  assert.ok(nested);
  const nestedState = await (nested as Promise<DesktopUpdateState>);

  assert.equal(firstState.phase, 'complete');
  assert.equal(nestedState.phase, 'complete');
  assert.equal(installCalls, 1);
  assert.equal(f.staged.length, 1);
  assert.equal(plans.length, 1);
});

test('an update check cannot replace active runtime reconciliation', async () => {
  const install = deferred<void>();
  let checkCalls = 0;
  const f = fixture([plan('complete')], {
    installBundledRuntime: () => install.promise,
    checkForUpdates() {
      checkCalls += 1;
    },
  });
  const reconciliation = f.controller.reconcileBundledRuntime(
    manifest,
    '/app/Resources/kungfu',
    async () => true,
  );

  const [checkResult] = await Promise.allSettled([
    f.controller.checkForUpdates(),
  ]);
  const phaseWhileInstallPending = f.controller.snapshot().phase;
  install.resolve(undefined);
  const reconciled = await reconciliation;

  assert.equal(checkResult.status, 'rejected');
  if (checkResult.status === 'rejected') {
    assert.match(String(checkResult.reason), /runtime reconciliation/i);
  }
  assert.equal(phaseWhileInstallPending, 'reconciling');
  assert.equal(checkCalls, 0);
  assert.equal(reconciled.phase, 'complete');
});

test('an update check cannot overlap an active download', async () => {
  const download = deferred<void>();
  let checkCalls = 0;
  const f = fixture([plan('download-allowed')], {
    downloadUpdate: () => download.promise,
    checkForUpdates() {
      checkCalls += 1;
    },
  });
  f.announceUpdate();
  await f.controller.whenIdle();
  const downloading = f.controller.downloadUpdate();

  const [checkResult] = await Promise.allSettled([
    f.controller.checkForUpdates(),
  ]);
  const phaseWhileDownloadPending = f.controller.snapshot().phase;
  download.resolve(undefined);
  await downloading;
  f.emit({ type: 'update-not-available' });
  await f.controller.whenIdle();

  assert.equal(checkResult.status, 'rejected');
  if (checkResult.status === 'rejected') {
    assert.match(String(checkResult.reason), /update transport/i);
  }
  assert.equal(phaseWhileDownloadPending, 'downloading');
  assert.equal(checkCalls, 0);
});

test('runtime reconciliation cannot overlap an active download', async () => {
  const download = deferred<void>();
  const plans = [plan('download-allowed'), plan('complete')];
  let installCalls = 0;
  const f = fixture(plans, {
    downloadUpdate: () => download.promise,
    installBundledRuntime() {
      installCalls += 1;
    },
  });
  f.announceUpdate();
  await f.controller.whenIdle();
  const downloading = f.controller.downloadUpdate();

  const [reconciliationResult] = await Promise.allSettled([
    f.controller.reconcileBundledRuntime(
      manifest,
      '/app/Resources/kungfu',
      async () => true,
    ),
  ]);
  const phaseWhileDownloadPending = f.controller.snapshot().phase;
  download.resolve(undefined);
  await downloading;

  assert.equal(reconciliationResult.status, 'rejected');
  if (reconciliationResult.status === 'rejected') {
    assert.match(String(reconciliationResult.reason), /update transport/i);
  }
  assert.equal(phaseWhileDownloadPending, 'downloading');
  assert.equal(installCalls, 0);
  assert.equal(plans.length, 1);
});

test('startup reconciliation activates only an idle Core plan', async () => {
  const f = fixture([plan('apply-now')]);
  const state = await f.controller.reconcileBundledRuntime(
    manifest,
    '/app/Resources/kungfu',
    async () => true,
  );

  assert.equal(state.phase, 'complete');
  assert.equal(state.receipt?.state, 'complete');
  assert.equal(f.staged.length, 1);
  assert.deepEqual(f.reconciled, [true]);
});

test('active incompatible work defers without staging or killing work', async () => {
  const f = fixture([plan('defer-until-idle')]);
  const state = await f.controller.reconcileBundledRuntime(
    manifest,
    '/app/Resources/kungfu',
    async () => {
      throw new Error('readiness must not run for a deferred plan');
    },
  );

  assert.equal(state.phase, 'deferred');
  assert.equal(state.message?.reasonCode, 'active-work-incompatible');
  assert.match(state.message?.activeWork ?? '', /pinned runtime/);
  assert.match(
    state.message?.documentationUrl ?? '',
    /#updates-while-work-is-active$/,
  );
  assert.equal(f.staged.length, 0);
  assert.equal(f.reconciled.length, 0);
});

test('readiness failure is reconciled through the Core rollback receipt', async () => {
  const f = fixture([plan('apply-now')]);
  const state = await f.controller.reconcileBundledRuntime(
    manifest,
    '/app/Resources/kungfu',
    async () => false,
  );

  assert.equal(state.phase, 'action-required');
  assert.equal(state.receipt?.state, 'failed-rolled-back');
  assert.deepEqual(f.reconciled, [false]);
});

test('a readiness probe crash is reconciled as a failed readiness check', async () => {
  const f = fixture([plan('apply-now')]);
  const state = await f.controller.reconcileBundledRuntime(
    manifest,
    '/app/Resources/kungfu',
    async () => {
      throw new Error('readiness probe crashed');
    },
  );

  assert.equal(state.phase, 'action-required');
  assert.equal(state.receipt?.state, 'failed-rolled-back');
  assert.deepEqual(f.reconciled, [false]);
});

test('a bundled runtime install failure revokes stale update authority', async () => {
  const f = fixture([plan('download-allowed')], {
    installBundledRuntime() {
      throw new Error('bundled runtime verification failed');
    },
  });
  f.announceUpdate();
  await f.controller.whenIdle();
  assert.equal(f.controller.snapshot().plan?.state, 'download-allowed');

  await assert.rejects(
    f.controller.reconcileBundledRuntime(
      manifest,
      '/app/Resources/kungfu',
      async () => true,
    ),
    /bundled runtime verification failed/i,
  );

  const state = f.controller.snapshot();
  assert.equal(state.phase, 'error');
  assert.equal(state.plan, null);
  assert.equal(state.receipt, null);
  assert.match(state.error, /bundled runtime verification failed/i);
  assert.equal(state.message?.messageReasonCode, 'action-required');
});

test('a Core reconcile failure preserves the current recovery receipt', async () => {
  let failReconcile = true;
  const f = fixture([plan('apply-now')], {
    reconcile() {
      if (failReconcile) throw new Error('Core reconcile unavailable');
    },
  });

  await assert.rejects(
    f.controller.reconcileBundledRuntime(
      manifest,
      '/app/Resources/kungfu',
      async () => true,
    ),
    /Core reconcile unavailable/i,
  );

  const state = f.controller.snapshot();
  assert.equal(state.phase, 'error');
  assert.equal(state.plan?.state, 'apply-now');
  assert.equal(state.receipt?.state, 'reconciling');
  assert.equal(state.reasonCode, 'desktop-updater-error');
  assert.match(state.error, /Core reconcile unavailable/i);
  assert.equal(state.message?.messageReasonCode, 'action-required');

  failReconcile = false;
  const recovered = await f.controller.reconcileBundledRuntime(
    manifest,
    '/app/Resources/kungfu',
    async () => true,
  );
  assert.equal(recovered.phase, 'complete');
  assert.equal(recovered.receipt?.state, 'complete');
  assert.equal(f.staged.length, 1);
  assert.deepEqual(f.reconciled, [true]);
});

test('a persisted reconciling receipt resumes without staging again', async () => {
  const stagedPlan = plan('apply-now');
  const f = fixture([], {
    load: {
      schema: 'kungfu.desktop-update-state/v1',
      phase: 'reconciling',
      version: manifest.productVersion,
      manifest,
      plan: stagedPlan,
      receipt: receipt(),
      progressPercent: null,
      reasonCode: stagedPlan.reasonCode,
      nextAction: stagedPlan.nextAction,
      documentationUrl: manifest.documentationUrl,
      error: '',
      message: null,
      updatedAtMs: 122,
    },
  });

  const recovered = await f.controller.reconcileBundledRuntime(
    manifest,
    '/app/Resources/kungfu',
    async () => true,
  );

  assert.equal(recovered.phase, 'complete');
  assert.equal(recovered.receipt?.state, 'complete');
  assert.equal(f.staged.length, 0);
  assert.deepEqual(f.reconciled, [true]);
});

test('a staged receipt cannot cross a changed release identity', async () => {
  const stagedPlan = plan('apply-now');
  const freshPlans = [plan('apply-now')];
  const f = fixture(freshPlans, {
    load: {
      schema: 'kungfu.desktop-update-state/v1',
      phase: 'reconciling',
      version: manifest.productVersion,
      manifest: {
        ...manifest,
        sourceCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      plan: stagedPlan,
      receipt: receipt(),
      progressPercent: null,
      reasonCode: stagedPlan.reasonCode,
      nextAction: stagedPlan.nextAction,
      documentationUrl: manifest.documentationUrl,
      error: '',
      message: null,
      updatedAtMs: 122,
    },
  });

  const recovered = await f.controller.reconcileBundledRuntime(
    manifest,
    '/app/Resources/kungfu',
    async () => true,
  );

  assert.equal(recovered.phase, 'complete');
  assert.equal(freshPlans.length, 0);
  assert.equal(f.staged.length, 1);
  assert.deepEqual(f.reconciled, [true]);
});

test('a stale downloaded target cannot replace the current Core plan', async () => {
  const f = fixture([plan('download-allowed')]);
  f.announceUpdate();
  await f.controller.whenIdle();
  await f.controller.downloadUpdate();
  f.emit({
    type: 'update-downloaded',
    info: {
      ...updateInfo,
      releaseManifest: { ...manifest, runtimeBuildId: 'runtime-stale' },
    },
  });
  await f.controller.whenIdle();

  assert.equal(f.controller.snapshot().phase, 'error');
  assert.match(f.controller.snapshot().error, /does not match/);
  assert.equal(
    f.controller.snapshot().message?.messageReasonCode,
    'action-required',
  );
  assert.match(
    f.controller.snapshot().message?.documentationUrl ?? '',
    /#troubleshooting$/,
  );
  assert.equal(f.quitAndInstallCalls(), 0);
});

test('a downloaded manifest must preserve the exact planned release identity', async () => {
  const f = fixture([plan('download-allowed')]);
  f.announceUpdate();
  await f.controller.whenIdle();
  await f.controller.downloadUpdate();
  f.emit({
    type: 'update-downloaded',
    info: {
      ...updateInfo,
      releaseManifest: {
        ...manifest,
        sourceCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    },
  });
  await f.controller.whenIdle();

  assert.equal(f.controller.snapshot().phase, 'error');
  assert.match(f.controller.snapshot().error, /does not match/);
  assert.equal(f.quitAndInstallCalls(), 0);
});

test('release identity comparison ignores JSON object key order', async () => {
  const f = fixture([plan('download-allowed')]);
  f.announceUpdate();
  await f.controller.whenIdle();
  await f.controller.downloadUpdate();
  f.emit({
    type: 'update-downloaded',
    info: {
      ...updateInfo,
      releaseManifest: {
        documentationUrl: manifest.documentationUrl,
        sourceCommit: manifest.sourceCommit,
        frontendBuildId: manifest.frontendBuildId,
        runtimeBuildId: manifest.runtimeBuildId,
        productVersion: manifest.productVersion,
        schema: manifest.schema,
      },
    },
  });
  await f.controller.whenIdle();

  assert.equal(f.controller.snapshot().phase, 'downloaded');
});

test('a failed Core plan becomes recoverable controller state', async () => {
  const f = fixture([]);
  f.announceUpdate();
  await f.controller.whenIdle();
  assert.equal(f.controller.snapshot().phase, 'error');
  assert.match(f.controller.snapshot().error, /fixture exhausted/);

  f.emit({ type: 'update-not-available' });
  await f.controller.whenIdle();
  assert.equal(f.controller.snapshot().phase, 'idle');
});
