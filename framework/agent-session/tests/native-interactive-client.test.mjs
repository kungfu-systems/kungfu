import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveNativeInteractiveNodePty } from '../src/native-interactive-client.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const TUI_DIST = path.join(ROOT, 'framework', 'tui', 'dist');

test('provider-first source bundle resolves node-pty through the Agent Session package', async () => {
  const runtimeDir = await mkdtemp(
    path.join(os.tmpdir(), 'kungfu-native-provider-first-'),
  );
  const bundleRequire = createRequire(
    path.join(TUI_DIST, 'native-agent-session.mjs'),
  );
  const previous = process.env.KUNGFU_AGENT_SESSION_NODE_PTY_MODULE;
  Reflect.deleteProperty(process.env, 'KUNGFU_AGENT_SESSION_NODE_PTY_MODULE');
  try {
    assert.throws(
      () => bundleRequire.resolve('node-pty/lib/index.js'),
      /Cannot find module/u,
    );
    assert.equal(
      bundleRequire.resolve('@kungfu-tech/agent-session/product-client'),
      path.join(
        ROOT,
        'framework',
        'agent-session',
        'src',
        'product-client.mjs',
      ),
    );
    const modulePath = resolveNativeInteractiveNodePty(
      path.join(TUI_DIST, 'agent-session-worker.mjs'),
      runtimeDir,
      bundleRequire,
    );
    assert.equal(existsSync(modulePath), true);
    assert.match(modulePath, /node-pty\/lib\/index\.js$/u);
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(
        process.env,
        'KUNGFU_AGENT_SESSION_NODE_PTY_MODULE',
      );
    } else {
      process.env.KUNGFU_AGENT_SESSION_NODE_PTY_MODULE = previous;
    }
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
