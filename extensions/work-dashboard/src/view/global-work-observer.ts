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
