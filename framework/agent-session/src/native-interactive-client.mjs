import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDetachedAgentSessionHost } from './product-client.mjs';

const SURFACE_CAPABILITIES_SCHEMA =
  'kungfu.agent-session.surface-capabilities/v1';
const REQUIRED_NATIVE_ACTIONS = [
  'capabilities',
  'show',
  'plan-native-start',
  'start-native',
  'heartbeat-native',
  'project-native-work',
  'end-native',
];

function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function resolveWorker(env) {
  if (env.KUNGFU_AGENT_SESSION_WORKER) {
    return path.resolve(env.KUNGFU_AGENT_SESSION_WORKER);
  }
  const bundled = fileURLToPath(
    new URL('./agent-session-worker.mjs', import.meta.url),
  );
  if (existsSync(bundled)) return bundled;
  return fileURLToPath(new URL('./product-worker.mjs', import.meta.url));
}

export function assertNativeInteractiveCapabilities(capabilities) {
  const actions = new Set(
    Array.isArray(capabilities?.actions) ? capabilities.actions : [],
  );
  const missing = REQUIRED_NATIVE_ACTIONS.filter(
    (action) => !actions.has(action),
  );
  if (
    capabilities?.schema === SURFACE_CAPABILITIES_SCHEMA &&
    missing.length === 0
  ) {
    return capabilities;
  }
  const details = [];
  if (capabilities?.schema !== SURFACE_CAPABILITIES_SCHEMA) {
    details.push(
      `schema is ${capabilities?.schema || 'missing'}; expected ${SURFACE_CAPABILITIES_SCHEMA}`,
    );
  }
  if (missing.length > 0) {
    details.push(`missing operations: ${missing.join(', ')}`);
  }
  throw new Error(
    `Agent Session protocol mismatch: ${details.join('; ')}. Close running Kungfu processes for this Project and retry. Project data does not need to be deleted.`,
  );
}

export async function ensureNativeInteractiveSessionSurface({
  runtimeDir = process.env.KF_RUNTIME_DIR,
  env = process.env,
  createHost = createDetachedAgentSessionHost,
} = {}) {
  const resolvedRuntime = path.resolve(required(runtimeDir, 'KF_RUNTIME_DIR'));
  const workerPath = resolveWorker(env);
  const nativeEnv = Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => name !== 'KUNGFU_AGENT_SESSION_NODE_PTY_MODULE',
    ),
  );
  const host = createHost({
    runtimeDir: resolvedRuntime,
    executable: env.KUNGFU_AGENT_SESSION_EXECUTABLE || process.execPath,
    workerPath,
    env: nativeEnv,
  });
  assertNativeInteractiveCapabilities(
    await host.invoke({ operation: 'capabilities' }),
  );
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
