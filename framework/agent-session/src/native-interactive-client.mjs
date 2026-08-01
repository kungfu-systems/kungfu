import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createDetachedAgentSessionHost,
  prepareAgentSessionNodePty,
} from './product-client.mjs';

const require = createRequire(import.meta.url);

function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function resolveWorker() {
  if (process.env.KUNGFU_AGENT_SESSION_WORKER) {
    return path.resolve(process.env.KUNGFU_AGENT_SESSION_WORKER);
  }
  const bundled = fileURLToPath(
    new URL('./agent-session-worker.mjs', import.meta.url),
  );
  if (existsSync(bundled)) return bundled;
  return fileURLToPath(new URL('./product-worker.mjs', import.meta.url));
}

export function resolveNativeInteractiveNodePty(
  workerPath,
  runtimeDir,
  moduleRequire = require,
) {
  const requested = process.env.KUNGFU_AGENT_SESSION_NODE_PTY_MODULE;
  const bundled = path.join(
    path.dirname(workerPath),
    'node_modules',
    'node-pty',
    'lib',
    'index.js',
  );
  const candidates = [requested ? path.resolve(requested) : null, bundled];
  try {
    const productClient = moduleRequire.resolve(
      '@kungfu-tech/agent-session/product-client',
    );
    candidates.push(
      path.join(
        path.dirname(path.dirname(productClient)),
        'node_modules',
        'node-pty',
        'lib',
        'index.js',
      ),
    );
  } catch {}
  try {
    candidates.push(moduleRequire.resolve('node-pty/lib/index.js'));
  } catch {}
  const modulePath = candidates.find(
    (candidate) => candidate && existsSync(candidate),
  );
  if (!modulePath) {
    throw new Error(
      'native Agent Session bootstrap cannot locate its packaged node-pty runtime',
    );
  }
  return prepareAgentSessionNodePty({ runtimeDir, modulePath });
}

export async function ensureNativeInteractiveSessionSurface({
  runtimeDir = process.env.KF_RUNTIME_DIR,
} = {}) {
  const resolvedRuntime = path.resolve(required(runtimeDir, 'KF_RUNTIME_DIR'));
  const workerPath = resolveWorker();
  process.env.KUNGFU_AGENT_SESSION_NODE_PTY_MODULE =
    resolveNativeInteractiveNodePty(workerPath, resolvedRuntime);
  const host = createDetachedAgentSessionHost({
    runtimeDir: resolvedRuntime,
    executable: process.env.KUNGFU_AGENT_SESSION_EXECUTABLE || process.execPath,
    workerPath,
    env: process.env,
  });
  await host.invoke({ operation: 'capabilities' });
  return host.endpoint;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  ensureNativeInteractiveSessionSurface().catch((error) => {
    process.stderr.write(
      `native Agent Session bootstrap: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
