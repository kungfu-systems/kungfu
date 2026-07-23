// SPDX-License-Identifier: Apache-2.0

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NativeKungfuJournalNoticePort } from '../src/runtime-port.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '..', '..', '..');
const BINDING_PATH = path.join(
  ROOT,
  'framework',
  'core',
  'dist',
  'kungfu',
  'kungfu_node.node',
);
const require = createRequire(import.meta.url);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, label, timeout = 15_000) {
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

const binding = require(BINDING_PATH);
const port = new NativeKungfuJournalNoticePort({
  binding,
  runtimeDir,
  peerName: `agent_session_${role}`,
});

let failure = null;
try {
  await waitFor(() => port.health().live, `${role} peer registration`);
  if (role === 'writer') {
    const frame = port.append({
      kind: 'output',
      sessionId: 'native-roundtrip',
      payload: {
        schema: 'kungfu.agent-session.output/v1',
        data: 'hello from the native peer transport',
      },
    });
    process.stdout.write(
      `${JSON.stringify({ type: 'writer-ready', frame })}\n`,
    );
    await new Promise((resolve) => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    });
  } else {
    port.follow({
      mode: 'live',
      role: 'system',
      namespace: 'node',
      name: 'agent_session_writer',
    });
    const frame = await waitFor(() => {
      const result = port.read({ fromCursor: 0 });
      return result.frames.find(
        (candidate) => candidate.sessionId === 'native-roundtrip',
      );
    }, 'reader cursor reconstruction');
    process.stdout.write(
      `${JSON.stringify({ type: 'reader-received', frame, health: port.health() })}\n`,
    );
  }
} catch (error) {
  failure = error;
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
} finally {
  port.close();
  // Watcher::quit asks the uv worker to unwind. Bound the fixture lifetime so
  // a slow native teardown cannot leave the qualification runner hanging.
  await sleep(500);
}
process.exit(failure ? 1 : 0);
