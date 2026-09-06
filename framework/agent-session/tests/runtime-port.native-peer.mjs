// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'node:module';

import { NativeKungfuJournalNoticePort } from '../src/runtime-port.mjs';

const require = createRequire(import.meta.url);
// Core keeps the live-peer registration handshake open for 60 seconds. The
// fixture must not declare failure earlier than the production contract,
// especially on a cold Windows runner where coordinator startup follows a full
// native rebuild.
const PEER_REGISTRATION_TIMEOUT_MS = 60_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(
  predicate,
  label,
  timeout = PEER_REGISTRATION_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const [role, runtimeDir] = process.argv.slice(2);
if (!['writer', 'reader'].includes(role) || !runtimeDir) {
  throw new Error(
    'usage: runtime-port.native-peer.mjs writer|reader RUNTIME_DIR',
  );
}

const binding = require('@kungfu-tech/core/native-binding');
const port = new NativeKungfuJournalNoticePort({
  binding,
  runtimeDir,
  peerName: `agent_session_${role}`,
});

let failure = null;
try {
  await waitFor(() => port.health().live, `${role} peer registration`);
  if (role === 'writer') {
    let frame;
    for (let index = 0; index < 512; index += 1) {
      frame = port.append({
        kind: 'output',
        sessionId: 'native-roundtrip',
        payload: {
          schema: 'kungfu.agent-session.output/v1',
          data: `native peer transport frame ${index}`,
        },
      });
    }
    process.stdout.write(
      `${JSON.stringify({ type: 'writer-ready', frame })}\n`,
    );
    await new Promise((resolve) => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    });
  } else {
    await waitFor(() => port.canFollow(), 'reader coordinator command channel');
    port.follow({
      mode: 'live',
      role: 'system',
      namespace: 'node',
      name: 'agent_session_writer',
    });
    // Deliberately block the Node consumer while the dedicated native watcher
    // drains the journal. Its one-slot bridge must coalesce wakeups without
    // growing an unbounded callback queue or losing the bounded journal data.
    const slowConsumerUntil = Date.now() + 250;
    while (Date.now() < slowConsumerUntil) {
      // intentional synchronous consumer stall
    }
    const frame = await waitFor(() => {
      const result = port.read({ fromCursor: 0 });
      return result.frames
        .filter((candidate) => candidate.sessionId === 'native-roundtrip')
        .at(-1);
    }, 'reader cursor reconstruction');
    const runtimeStats = Object.fromEntries(
      Object.entries(port.peer.runtimeStats()).map(([key, value]) => [
        key,
        typeof value === 'bigint' ? value.toString() : value,
      ]),
    );
    process.stdout.write(
      `${JSON.stringify({
        type: 'reader-received',
        frame,
        health: port.health(),
        runtimeStats,
      })}\n`,
    );
  }
} catch (error) {
  failure = error;
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
} finally {
  port.close();
  // Watcher::quit asks the dedicated native thread to unwind. Bound the fixture
  // lifetime so a slow native teardown cannot leave the qualification runner
  // hanging.
  await sleep(500);
}
process.exit(failure ? 1 : 0);
