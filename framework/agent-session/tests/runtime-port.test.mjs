import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACTION_ENVELOPE_CARRIER_TYPE,
  NativeKungfuJournalNoticePort,
} from '../src/runtime-port.mjs';

class FakeWatcher {
  constructor(_runtimeDir, _name, _bypass, _sleep, captureCustom) {
    assert.equal(captureCustom, true);
    this.started = false;
    this.live = true;
    this.usable = true;
    this.issued = [];
    this.incoming = [];
  }

  isStarted() {
    return this.started;
  }

  isLive() {
    return this.live;
  }

  isUsable() {
    return this.usable;
  }

  start() {
    this.started = true;
  }

  issueRawPublic(carrierType, data) {
    this.issued.push({ carrierType, data });
    return this.live;
  }

  requestReadFromPublic(location, fromTime) {
    this.followed = { location, fromTime };
    return this.live;
  }

  drainCustomData() {
    const frames = this.incoming.splice(0);
    return { dropped: 0n, frames };
  }

  quit() {
    this.started = false;
  }
}

const binding = {
  Watcher: FakeWatcher,
  encodeActionEnvelope: (value) =>
    Buffer.from(
      JSON.stringify({
        ...value,
        payload: {
          ...value.payload,
          data: [...value.payload.data],
        },
      }),
    ),
  decodeActionEnvelope: (value) => {
    const decoded = JSON.parse(Buffer.from(value).toString());
    decoded.payload.encoding = 2;
    decoded.payload.data = Uint8Array.from(decoded.payload.data);
    return decoded;
  },
};

test('native port uses action envelopes on one public journal writer', () => {
  const port = new NativeKungfuJournalNoticePort({
    binding,
    runtimeDir: '/tmp/runtime',
    peerName: 'capsule-1',
  });
  const stored = port.append({
    frameClass: 'volatile-terminal-transport',
    kind: 'output-bytes',
    payload: {
      schema: 'kungfu.agent-session.output-frame/v1',
      startSequence: 0,
      endSequence: 5,
      data: 'hello',
    },
  });
  assert.equal(stored.cursor, 1);
  assert.equal(port.peer.issued.length, 1);
  assert.equal(port.peer.issued[0].carrierType, ACTION_ENVELOPE_CARRIER_TYPE);
  assert.deepEqual(port.health(), {
    schema: 'kungfu.agent-session.native-peer-health/v1',
    started: true,
    live: true,
    usable: true,
    transport: 'mmap-journal+nng-notice',
    coordinatorByteProxy: false,
  });
});

test('reader follows a Peer public journal and reconstructs cursor frames', () => {
  const writer = new NativeKungfuJournalNoticePort({
    binding,
    runtimeDir: '/tmp/runtime',
    peerName: 'capsule-writer',
  });
  const reader = new NativeKungfuJournalNoticePort({
    binding,
    runtimeDir: '/tmp/runtime',
    peerName: 'capsule-reader',
  });
  writer.append({
    frameClass: 'auditable-control',
    kind: 'controller-granted',
    payload: {
      schema: 'kungfu.agent-session.controller-lease-receipt/v1',
      leaseId: 'lease-1',
    },
  });
  reader.follow({ role: 'system', namespace: 'node', name: 'capsule-writer' });
  reader.peer.incoming.push({
    carrierType: ACTION_ENVELOPE_CARRIER_TYPE,
    data: writer.peer.issued[0].data,
  });
  const recovered = reader.read({ fromCursor: 0 });
  assert.equal(recovered.frames.length, 1);
  assert.equal(recovered.frames[0].kind, 'controller-granted');
  assert.equal(recovered.frames[0].payload.leaseId, 'lease-1');
  assert.equal(reader.peer.followed.fromTime, 0n);
});

test('native queue overflow becomes an explicit gap', () => {
  const port = new NativeKungfuJournalNoticePort({
    binding,
    runtimeDir: '/tmp/runtime',
    peerName: 'capsule-overflow',
  });
  port.peer.drainCustomData = () => ({ dropped: 3n, frames: [] });
  const recovered = port.read({ fromCursor: 0 });
  assert.equal(recovered.gap.reason, 'native-peer-queue-overflow');
  assert.equal(recovered.gap.nativeDropped, '3');
});
