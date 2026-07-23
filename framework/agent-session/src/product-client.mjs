import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { invokeAgentSessionSurfaceRpc } from './product-rpc.mjs';

const CONNECT_TIMEOUT_MS = 5000;
const RETRY_MS = 50;
const STARTUP_LOCK_STALE_MS = CONNECT_TIMEOUT_MS * 2;

export function detachedAgentSessionPaths(runtimeDir) {
  if (typeof runtimeDir !== 'string' || runtimeDir.length === 0) {
    throw new Error('detached Agent Session host requires runtimeDir');
  }
  const directory = path.join(path.resolve(runtimeDir), 'agent-session');
  const scope = createHash('sha256')
    .update(directory)
    .digest('hex')
    .slice(0, 16);
  const socketDirectory =
    process.platform === 'win32'
      ? null
      : path.join(
          process.platform === 'darwin' ? '/tmp' : os.tmpdir(),
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

function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(
      `Agent Session runtime path '${directory}' is not a real directory`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(
      `Agent Session runtime path '${directory}' is not owned by this user`,
    );
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error(
      `Agent Session runtime path '${directory}' must not be group/world accessible`,
    );
  }
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
      ensurePrivateDirectory(paths.directory);
      if (paths.socketDirectory) ensurePrivateDirectory(paths.socketDirectory);
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
          const child = spawnProcess(executable, [workerPath], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: {
              ...env,
              ELECTRON_RUN_AS_NODE: '1',
              KUNGFU_AGENT_SESSION_ENDPOINT: paths.endpoint,
              KUNGFU_AGENT_SESSION_METADATA: paths.metadata,
              KUNGFU_AGENT_SESSION_REGISTRY: paths.registry,
              KUNGFU_AGENT_SESSION_STARTED_AT: String(now()),
            },
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
