import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createCapsuleNodePtyLoader } from './capsule-transport-runtime.mjs';
import { ensurePrivateRuntimeDirectory } from './private-runtime-directory.mjs';
import {
  bindAgentSessionSurfaceRpc,
  invokeAgentSessionSurfaceRpc,
} from './product-rpc.mjs';
import { InProcessAgentSessionProductRuntime } from './product-runtime.mjs';
import { AgentSessionProductSurface } from './product-surface.mjs';
import {
  JsonFileWorkConsoleRegistryStore,
  WorkConsoleRegistry,
} from './work-console-registry.mjs';

const require = createRequire(import.meta.url);

const CONNECT_TIMEOUT_MS = 5000;
const RETRY_MS = 50;
const STARTUP_LOCK_STALE_MS = CONNECT_TIMEOUT_MS * 2;

export function prepareAgentSessionNodePty({ runtimeDir, modulePath } = {}) {
  if (typeof runtimeDir !== 'string' || runtimeDir.length === 0) {
    throw new Error('node-pty preparation requires runtimeDir');
  }
  const resolvedModule = path.resolve(
    modulePath ?? require.resolve('node-pty/lib/index.js'),
  );
  const packageRoot = realpathSync(path.dirname(path.dirname(resolvedModule)));
  if (process.platform !== 'darwin') return resolvedModule;
  const helper = path.join(
    packageRoot,
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper',
  );
  if (existsSync(helper) && (lstatSync(helper).mode & 0o111) !== 0) {
    return resolvedModule;
  }
  const targetRoot = path.join(
    path.resolve(runtimeDir),
    'agent-session-support',
    'node-pty',
  );
  if (!existsSync(targetRoot)) {
    ensurePrivateRuntimeDirectory(path.dirname(targetRoot));
    cpSync(packageRoot, targetRoot, { recursive: true });
  }
  const targetStat = lstatSync(targetRoot);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new Error(
      `Agent Session node-pty support path '${targetRoot}' must be a real directory`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && targetStat.uid !== uid) {
    throw new Error(
      `Agent Session node-pty support path '${targetRoot}' is not owned by this user`,
    );
  }
  const targetHelper = path.join(
    targetRoot,
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper',
  );
  if (!existsSync(targetHelper)) {
    throw new Error(`node-pty spawn-helper is unavailable: ${targetHelper}`);
  }
  const helperStat = lstatSync(targetHelper);
  if (!helperStat.isFile() || helperStat.isSymbolicLink()) {
    throw new Error(
      `node-pty spawn-helper '${targetHelper}' must be a real file`,
    );
  }
  chmodSync(targetHelper, 0o700);
  return path.join(targetRoot, 'lib', 'index.js');
}

function canonicalRuntimeDir(runtimeDir) {
  let existing = path.resolve(runtimeDir);
  const suffix = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...suffix);
}

export function detachedAgentSessionPaths(runtimeDir) {
  if (typeof runtimeDir !== 'string' || runtimeDir.length === 0) {
    throw new Error('detached Agent Session host requires runtimeDir');
  }
  const directory = path.join(canonicalRuntimeDir(runtimeDir), 'agent-session');
  const scope = createHash('sha256')
    .update(directory)
    .digest('hex')
    .slice(0, 16);
  const socketDirectory =
    process.platform === 'win32'
      ? null
      : path.join(
          '/tmp',
          `kungfu-agent-session-${process.getuid?.() ?? 'user'}`,
        );
  return {
    directory,
    socketDirectory,
    endpoint:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\kungfu-agent-session-${scope}`
        : path.join(socketDirectory, `${scope}.sock`),
    metadata: path.join(directory, 'worker.json'),
    registry: path.join(directory, 'work-console-registry.json'),
    startupLock: path.join(directory, 'worker-start.lock'),
  };
}

function transientConnection(error) {
  return ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(
    error?.code,
  );
}

function clearStaleSocket(endpoint) {
  if (process.platform === 'win32' || !existsSync(endpoint)) return;
  const stat = lstatSync(endpoint);
  if (!stat.isSocket()) {
    throw new Error(
      `refusing to replace non-socket Agent Session endpoint '${endpoint}'`,
    );
  }
  unlinkSync(endpoint);
}

function acquireStartupLock(lockPath) {
  const token = `${process.pid}:${randomUUID()}`;
  try {
    writeFileSync(lockPath, token, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') return null;
    throw error;
  }
  return () => {
    try {
      if (readFileSync(lockPath, 'utf8') === token) unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  };
}

function clearStaleStartupLock(lockPath, now) {
  if (!existsSync(lockPath)) return false;
  let stat;
  try {
    stat = lstatSync(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `refusing to replace invalid Agent Session startup lock '${lockPath}'`,
    );
  }
  if (now() - stat.mtimeMs <= STARTUP_LOCK_STALE_MS) return false;
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  return true;
}

export function createDetachedAgentSessionHost({
  runtimeDir,
  executable = process.execPath,
  workerPath = fileURLToPath(new URL('./product-worker.mjs', import.meta.url)),
  env = process.env,
  spawnProcess = spawn,
  unrefWorker = true,
  now = () => Date.now(),
}) {
  const paths = detachedAgentSessionPaths(runtimeDir);
  let starting = null;

  const call = (request) =>
    invokeAgentSessionSurfaceRpc({ endpoint: paths.endpoint, request });

  async function ensureWorker() {
    if (starting) return starting;
    starting = (async () => {
      ensurePrivateRuntimeDirectory(paths.directory);
      if (paths.socketDirectory) {
        ensurePrivateRuntimeDirectory(paths.socketDirectory);
      }
      const deadline = now() + STARTUP_LOCK_STALE_MS + CONNECT_TIMEOUT_MS;
      let lastError = null;
      while (now() < deadline) {
        try {
          await call({ operation: 'capabilities' });
          return;
        } catch (error) {
          lastError = error;
          if (!transientConnection(error)) throw error;
        }

        const releaseStartupLock = acquireStartupLock(paths.startupLock);
        if (!releaseStartupLock) {
          clearStaleStartupLock(paths.startupLock, now);
          await delay(RETRY_MS);
          continue;
        }
        try {
          try {
            await call({ operation: 'capabilities' });
            return;
          } catch (error) {
            lastError = error;
            if (!transientConnection(error)) throw error;
          }
          clearStaleSocket(paths.endpoint);
          const workerEnv = {
            ...env,
            ELECTRON_RUN_AS_NODE: '1',
            KUNGFU_AS_VARIANT: 'node',
            KUNGFU_AGENT_SESSION_ENDPOINT: paths.endpoint,
            KUNGFU_AGENT_SESSION_METADATA: paths.metadata,
            KUNGFU_AGENT_SESSION_REGISTRY: paths.registry,
            KUNGFU_AGENT_SESSION_STARTED_AT: String(now()),
          };
          // KUNGFU_NODE_VARIANT_ENTRY pins the current embedded-Node program
          // (for example tui.mjs). It must never override the reviewed worker
          // argv in a detached child.
          workerEnv.KUNGFU_NODE_VARIANT_ENTRY = undefined;
          const child = spawnProcess(executable, [workerPath], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: workerEnv,
          });
          if (unrefWorker) child.unref?.();
          const workerDeadline = now() + CONNECT_TIMEOUT_MS;
          while (now() < workerDeadline) {
            try {
              await call({ operation: 'capabilities' });
              return;
            } catch (error) {
              lastError = error;
              if (!transientConnection(error)) throw error;
              await delay(RETRY_MS);
            }
          }
        } finally {
          releaseStartupLock();
        }
      }
      throw new Error(
        `detached Agent Session worker did not become ready: ${lastError?.message ?? 'timeout'}`,
      );
    })().finally(() => {
      starting = null;
    });
    return starting;
  }

  return Object.freeze({
    ...paths,
    async invoke(request) {
      try {
        return await call(request);
      } catch (error) {
        if (!transientConnection(error)) throw error;
        await ensureWorker();
        return await call(request);
      }
    },
  });
}

/**
 * Own an Agent Session surface inside the calling product process.
 *
 * Deterministic Mock onboarding uses this host so readiness and retirement are
 * exact process-lifecycle events.  It deliberately has no startup deadline,
 * stale-lock heuristic, retry interval, or idle timer.  The public RPC endpoint
 * remains available to the bundled CLI subprocesses for the lifetime of the
 * TUI, and close() retires it when that owner exits.
 */
export function createAttachedAgentSessionHost({
  runtimeDir,
  pty = null,
  ptyModule,
  env = process.env,
} = {}) {
  const scope = `${process.pid}-${randomUUID()}`;
  const paths = detachedAgentSessionPaths(
    path.join(canonicalRuntimeDir(runtimeDir), 'attached', scope),
  );
  ensurePrivateRuntimeDirectory(paths.directory);
  if (paths.socketDirectory) {
    ensurePrivateRuntimeDirectory(paths.socketDirectory);
  }
  const runtime = new InProcessAgentSessionProductRuntime({
    pty,
    loadPty: createCapsuleNodePtyLoader({
      modulePath: ptyModule,
      registryPath: paths.registry,
    }),
    baseEnv: env,
  });
  const registry = new WorkConsoleRegistry({
    store: new JsonFileWorkConsoleRegistryStore(paths.registry),
  });
  const surface = new AgentSessionProductSurface({ runtime, registry });
  const server = bindAgentSessionSurfaceRpc({
    endpoint: paths.endpoint,
    invoke: (request) => surface.invoke(request),
  });
  let closed = false;

  return Object.freeze({
    ...paths,
    ready: server.ready,
    async invoke(request) {
      await server.ready;
      return surface.invoke(request);
    },
    async close() {
      if (closed) return;
      closed = true;
      runtime.shutdown();
      await server.close();
      if (process.platform !== 'win32') {
        try {
          unlinkSync(paths.endpoint);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    },
  });
}
