import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCapsuleNodePtyLoader } from './capsule-transport-runtime.mjs';
import {
  CodexAppServerProductRuntime,
  codexAppServerProductEnabled,
} from './codex-app-server-product.mjs';
import { ensurePrivateRuntimeDirectory } from './private-runtime-directory.mjs';
import { bindAgentSessionSurfaceRpc } from './product-rpc.mjs';
import { InProcessAgentSessionProductRuntime } from './product-runtime.mjs';
import { AgentSessionProductSurface } from './product-surface.mjs';
import {
  JsonFileWorkConsoleRegistryStore,
  WorkConsoleRegistry,
} from './work-console-registry.mjs';

const DEFAULT_IDLE_RETIREMENT_MS = 60_000;

export function createIdleWorkerRetirement({
  runtime,
  retire,
  timeoutMs = DEFAULT_IDLE_RETIREMENT_MS,
  schedule = setTimeout,
  cancel = clearTimeout,
  onError = (error) => {
    process.stderr.write(
      `agent-session worker retirement: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  },
} = {}) {
  if (!runtime || typeof runtime.list !== 'function') {
    throw new Error('idle worker retirement requires runtime.list()');
  }
  if (typeof retire !== 'function') {
    throw new Error('idle worker retirement requires retire()');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('idle worker retirement requires a positive timeout');
  }
  let timer = null;
  let stopped = false;

  const arm = () => {
    if (stopped) return;
    if (timer !== null) cancel(timer);
    timer = schedule(async () => {
      timer = null;
      if (stopped) return;
      if (runtime.list().length > 0) {
        arm();
        return;
      }
      stopped = true;
      try {
        await retire();
      } catch (error) {
        onError(error);
      }
    }, timeoutMs);
    timer?.unref?.();
  };

  return Object.freeze({
    touch: arm,
    stop() {
      stopped = true;
      if (timer !== null) cancel(timer);
      timer = null;
    },
  });
}

export async function runAgentSessionProductWorker({
  endpoint = process.env.KUNGFU_AGENT_SESSION_ENDPOINT,
  metadata = process.env.KUNGFU_AGENT_SESSION_METADATA,
  registryPath = process.env.KUNGFU_AGENT_SESSION_REGISTRY,
  pty = null,
  ptyModule = process.env.KUNGFU_AGENT_SESSION_NODE_PTY_MODULE,
  baseEnv = process.env,
  idleRetirementMs = Number(
    process.env.KUNGFU_AGENT_SESSION_IDLE_RETIREMENT_MS ??
      DEFAULT_IDLE_RETIREMENT_MS,
  ),
} = {}) {
  if (!endpoint || !metadata || !registryPath) {
    throw new Error(
      'detached Agent Session worker requires endpoint, metadata, and registry paths',
    );
  }
  mkdirSync(path.dirname(metadata), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    ensurePrivateRuntimeDirectory(path.dirname(endpoint));
  }
  const runtime = new InProcessAgentSessionProductRuntime({
    pty,
    loadPty: createCapsuleNodePtyLoader({
      modulePath: ptyModule,
      registryPath,
    }),
    baseEnv,
    structuredRuntime: codexAppServerProductEnabled(baseEnv)
      ? new CodexAppServerProductRuntime({ baseEnv })
      : null,
  });
  const registry = new WorkConsoleRegistry({
    store: new JsonFileWorkConsoleRegistryStore(registryPath),
  });
  const surface = new AgentSessionProductSurface({ runtime, registry });
  let idleRetirement = null;
  const server = bindAgentSessionSurfaceRpc({
    endpoint,
    invoke: (request) => {
      idleRetirement?.touch();
      return surface.invoke(request);
    },
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
    idleRetirement?.stop();
    runtime.shutdown();
    await server.close();
    for (const candidate of [endpoint, metadata]) {
      try {
        unlinkSync(candidate);
      } catch {}
    }
  };
  idleRetirement = createIdleWorkerRetirement({
    runtime,
    timeoutMs: idleRetirementMs,
    retire: () => close().finally(() => process.exit(0)),
  });
  idleRetirement.touch();
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
