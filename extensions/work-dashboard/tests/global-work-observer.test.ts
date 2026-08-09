import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GLOBAL_WORK_OBSERVER_EVENT_CHANNEL,
  GLOBAL_WORK_OBSERVER_SUBSCRIBE_CHANNEL,
  GLOBAL_WORK_OBSERVER_UNSUBSCRIBE_CHANNEL,
  type GlobalWorkObserverEvent,
  subscribeGlobalWorkObserver,
} from '../src/view/global-work-observer.ts';

test('renderer subscribes to main-process push without owning polling', async () => {
  const listeners = new Map<
    string,
    (event: unknown, payload: GlobalWorkObserverEvent) => void
  >();
  const invoked: string[] = [];
  const received: GlobalWorkObserverEvent[] = [];
  const ipc = {
    invoke: async (channel: string) => {
      invoked.push(channel);
    },
    on: (
      channel: string,
      listener: (event: unknown, payload: GlobalWorkObserverEvent) => void,
    ) => {
      listeners.set(channel, listener);
    },
    removeListener: (channel: string) => {
      listeners.delete(channel);
    },
  };

  const dispose = await subscribeGlobalWorkObserver(ipc, (event) =>
    received.push(event),
  );
  listeners.get(GLOBAL_WORK_OBSERVER_EVENT_CHANNEL)?.(
    {},
    {
      schema: 'kungfu.gui.global-work-observer-event/v1',
      kind: 'snapshot',
      mode: 'incremental',
      observed_at: '2026-07-25T00:00:00Z',
      latency_ms: 99,
      changed_workspace_ids: ['project:a'],
      snapshot: {},
    },
  );
  assert.deepEqual(invoked, [GLOBAL_WORK_OBSERVER_SUBSCRIBE_CHANNEL]);
  assert.equal(received.length, 1);
  listeners.get(GLOBAL_WORK_OBSERVER_EVENT_CHANNEL)?.(
    {},
    {
      schema: 'kungfu.gui.global-work-observer-event/v1',
      kind: 'snapshot',
      mode: 'incremental',
      observed_at: '2026-07-25T00:00:01Z',
      latency_ms: 98,
      changed_workspace_ids: ['project:a'],
      snapshot: {},
    },
  );
  assert.equal(received.length, 1);
  await dispose();
  assert.deepEqual(invoked, [
    GLOBAL_WORK_OBSERVER_SUBSCRIBE_CHANNEL,
    GLOBAL_WORK_OBSERVER_UNSUBSCRIBE_CHANNEL,
  ]);
  assert.equal(listeners.size, 0);
});
