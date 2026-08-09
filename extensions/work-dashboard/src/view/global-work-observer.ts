import type { AssignmentRuntime } from '@kungfu-tech/api/capability';

export const GLOBAL_WORK_OBSERVER_SUBSCRIBE_CHANNEL =
  'kf-global-work-observer:subscribe';
export const GLOBAL_WORK_OBSERVER_UNSUBSCRIBE_CHANNEL =
  'kf-global-work-observer:unsubscribe';
export const GLOBAL_WORK_OBSERVER_EVENT_CHANNEL =
  'kf-global-work-observer:event';

export type GlobalWorkObserverEvent =
  | {
      schema: 'kungfu.gui.global-work-observer-event/v1';
      kind: 'snapshot';
      mode: 'resume' | 'incremental' | 'recovery';
      observed_at: string;
      latency_ms: number;
      changed_workspace_ids: string[];
      snapshot: Record<string, unknown>;
    }
  | {
      schema: 'kungfu.gui.global-work-observer-event/v1';
      kind: 'error';
      error: string;
    };

export type GlobalWorkObserverIpc = {
  invoke: (channel: string, payload?: unknown) => Promise<unknown>;
  on: (
    channel: string,
    listener: (event: unknown, payload: GlobalWorkObserverEvent) => void,
  ) => void;
  removeListener: (
    channel: string,
    listener: (event: unknown, payload: GlobalWorkObserverEvent) => void,
  ) => void;
};

export async function subscribeGlobalWorkObserver(
  ipc: GlobalWorkObserverIpc,
  receive: (event: GlobalWorkObserverEvent) => void,
): Promise<() => Promise<void>> {
  let lastRevision = '';
  const listener = (_event: unknown, payload: GlobalWorkObserverEvent) => {
    if (payload?.schema !== 'kungfu.gui.global-work-observer-event/v1') return;
    if (payload.kind === 'snapshot') {
      const projection = payload.snapshot.global_work as
        | Record<string, unknown>
        | undefined;
      const revision = JSON.stringify({
        projection_root: projection?.projection_root,
        aggregate: payload.snapshot.aggregate,
        verification: payload.snapshot.verification,
      });
      if (revision === lastRevision) return;
      lastRevision = revision;
    }
    receive(payload);
  };
  ipc.on(GLOBAL_WORK_OBSERVER_EVENT_CHANNEL, listener);
  await ipc.invoke(GLOBAL_WORK_OBSERVER_SUBSCRIBE_CHANNEL);
  return async () => {
    ipc.removeListener(GLOBAL_WORK_OBSERVER_EVENT_CHANNEL, listener);
    await ipc.invoke(GLOBAL_WORK_OBSERVER_UNSUBSCRIBE_CHANNEL);
  };
}

export function observeAssignmentRuntimeStatus(
  assignmentRuntime: AssignmentRuntime,
  publish: (status: string) => void,
): () => void {
  let active = true;
  let timer: number | undefined;

  const observe = async () => {
    try {
      const discovery = await assignmentRuntime.discover();
      if (discovery.status !== 'ok') {
        throw new Error(
          discovery.error?.message ?? 'Work Runtime discovery failed',
        );
      }
      const snapshot = await assignmentRuntime.snapshot();
      if (snapshot.status !== 'ok') {
        const diagnostics = await assignmentRuntime.diagnostics();
        const recovery = await assignmentRuntime.recoveryPlan();
        throw new Error(
          snapshot.error?.message ??
            diagnostics.error?.message ??
            recovery.error?.message ??
            'Work Runtime snapshot failed',
        );
      }
      const watched = await assignmentRuntime.watch();
      if (!active) return;
      if (watched.status === 'ok') {
        publish(`Work Runtime · ${snapshot.revision.value}`);
        return;
      }
      const diagnostics = await assignmentRuntime.diagnostics();
      const recovery = await assignmentRuntime.recoveryPlan();
      if (!active) return;
      if (
        watched.error?.code === 'event-resume-gap' ||
        watched.error?.code === 'generation-fenced'
      ) {
        const connected = await assignmentRuntime.connect();
        const resumed = await assignmentRuntime.watch(connected.genesisCursor);
        if (!active) return;
        if (resumed.status === 'ok') {
          publish(`Work Runtime · recovered · ${snapshot.revision.value}`);
          return;
        }
      }
      publish(
        `Work Runtime · ${watched.error?.code ?? 'watch unavailable'} · ${String(
          (recovery.result as { status?: unknown } | null)?.status ??
            diagnostics.error?.code ??
            'recovery inspected',
        )}`,
      );
    } catch (reason: unknown) {
      if (active) {
        publish(
          `Work Runtime unavailable · ${
            reason instanceof Error ? reason.message : String(reason)
          }`,
        );
      }
    } finally {
      if (active) timer = window.setTimeout(() => void observe(), 5000);
    }
  };

  void observe();
  return () => {
    active = false;
    if (timer !== undefined) window.clearTimeout(timer);
  };
}
