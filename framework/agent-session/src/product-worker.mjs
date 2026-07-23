import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CodexAppServerProductRuntime,
  codexAppServerProductEnabled,
} from './codex-app-server-product.mjs';
import { bindAgentSessionSurfaceRpc } from './product-rpc.mjs';
import { InProcessAgentSessionProductRuntime } from './product-runtime.mjs';
import { AgentSessionProductSurface } from './product-surface.mjs';
import {
  JsonFileWorkConsoleRegistryStore,
  WorkConsoleRegistry,
} from './work-console-registry.mjs';

const require = createRequire(import.meta.url);

export async function runAgentSessionProductWorker({
  endpoint = process.env.KUNGFU_AGENT_SESSION_ENDPOINT,
  metadata = process.env.KUNGFU_AGENT_SESSION_METADATA,
  registryPath = process.env.KUNGFU_AGENT_SESSION_REGISTRY,
  pty = null,
  ptyModule = process.env.KUNGFU_AGENT_SESSION_NODE_PTY_MODULE,
  baseEnv = process.env,
} = {}) {
  if (!endpoint || !metadata || !registryPath) {
    throw new Error(
      'detached Agent Session worker requires endpoint, metadata, and registry paths',
    );
  }
  mkdirSync(path.dirname(metadata), { recursive: true, mode: 0o700 });
  const loadedPty =
    pty ?? require(ptyModule ? path.resolve(ptyModule) : 'node-pty');
  const runtime = new InProcessAgentSessionProductRuntime({
    pty: loadedPty,
    baseEnv,
    structuredRuntime: codexAppServerProductEnabled(baseEnv)
      ? new CodexAppServerProductRuntime({ baseEnv })
      : null,
  });
  const registry = new WorkConsoleRegistry({
    store: new JsonFileWorkConsoleRegistryStore(registryPath),
  });
  const surface = new AgentSessionProductSurface({ runtime, registry });
  const server = bindAgentSessionSurfaceRpc({
    endpoint,
    invoke: (request) => surface.invoke(request),
  });
  await server.ready;
  const record = {
    schema: 'kungfu.agent-session.product-worker/v1',
    pid: process.pid,
    endpoint,
    startedAt: Number(
      process.env.KUNGFU_AGENT_SESSION_STARTED_AT ?? Date.now(),
    ),
    runtimeIdentity: `product-worker:${process.pid}`,
    continuity: 'capsule-owner-process-only',
  };
  const temporary = `${metadata}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, metadata);

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    runtime.shutdown();
    await server.close();
    for (const candidate of [endpoint, metadata]) {
      try {
        unlinkSync(candidate);
      } catch {}
    }
  };
  process.once('SIGTERM', () => void close().finally(() => process.exit(0)));
  process.once('SIGINT', () => void close().finally(() => process.exit(0)));
  return { runtime, registry, surface, server, record, close };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runAgentSessionProductWorker().catch((error) => {
    process.stderr.write(
      `agent-session worker: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
