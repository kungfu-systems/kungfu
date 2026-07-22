import assert from 'node:assert/strict';
import test from 'node:test';

import { openLedger } from '../src/capability/ledger.ts';
import type { KfNativeBinding } from '../src/capability/types.ts';

test('replay anchors are derived from typed Episode rows', () => {
  let request: unknown;
  const binding = {
    storageEpisodeListTyped(runtimeDir: string, options: unknown) {
      request = { runtimeDir, options };
      return {
        episodes: [
          {
            episode_id: '41',
            open: { location_uid: 7, begin_time: '100' },
            close: { end_time: '240' },
            unique_frame_count: '12',
            last_frame_uid: '99',
            update_time: '230',
            closed: true,
          },
          {
            episode_id: 42n,
            open: { location_uid: 8, begin_time: 300n },
            unique_frame_count: 3n,
            last_frame_uid: 101n,
            update_time: 350n,
            closed: false,
          },
        ],
      };
    },
  } as unknown as KfNativeBinding;

  const anchors = openLedger({
    binding,
    locator: { runtimeDir: '/tmp/kungfu-runtime' },
  }).replayAnchors();

  assert.deepEqual(request, {
    runtimeDir: '/tmp/kungfu-runtime',
    options: { limit: 1_000_000 },
  });
  assert.deepEqual(anchors, [
    {
      episodeId: 41n,
      locationUid: 7,
      beginTime: 100n,
      endTime: 240n,
      frameCount: 12n,
      lastFrameUid: 99n,
      closed: true,
    },
    {
      episodeId: 42n,
      locationUid: 8,
      beginTime: 300n,
      endTime: 350n,
      frameCount: 3n,
      lastFrameUid: 101n,
      closed: false,
    },
  ]);
});
