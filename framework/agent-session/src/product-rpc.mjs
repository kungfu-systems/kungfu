import { chmodSync } from 'node:fs';
import net from 'node:net';

const MAX_REQUEST_BYTES = 1024 * 1024;

export function invokeAgentSessionSurfaceRpc({ endpoint, request }) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new Error('surface RPC client requires an endpoint');
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.setEncoding('utf8');
    let pending = '';
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      pending += chunk;
      if (Buffer.byteLength(pending, 'utf8') > MAX_REQUEST_BYTES) {
        socket.destroy();
        reject(
          Object.assign(new Error('surface RPC response exceeds 1 MiB'), {
            code: 'response_too_large',
          }),
        );
        return;
      }
      const newline = pending.indexOf('\n');
      if (newline < 0) return;
      socket.end();
      try {
        const response = JSON.parse(pending.slice(0, newline));
        if (response.ok) resolve(response.value);
        else {
          reject(
            Object.assign(
              new Error(response.error?.message ?? 'Agent Session RPC failed'),
              { code: response.error?.code ?? 'agent_session_error' },
            ),
          );
        }
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', reject);
  });
}

/**
 * Bind the same Agent Session invoke surface for installed CLI/KFD-3 clients.
 * The socket is a runtime-scoped action channel, not a terminal byte proxy.
 */
export function bindAgentSessionSurfaceRpc({ invoke, endpoint }) {
  if (typeof invoke !== 'function')
    throw new Error('surface RPC requires invoke()');
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new Error('surface RPC requires an endpoint');
  }
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let pending = '';
    socket.on('data', (chunk) => {
      pending += chunk;
      if (Buffer.byteLength(pending, 'utf8') > MAX_REQUEST_BYTES) {
        socket.end(
          `${JSON.stringify({ ok: false, error: { code: 'request_too_large', message: 'request exceeds 1 MiB' } })}\n`,
        );
        return;
      }
      while (pending.includes('\n')) {
        const newline = pending.indexOf('\n');
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line) continue;
        void Promise.resolve()
          .then(() => invoke(JSON.parse(line)))
          .then((value) =>
            socket.write(`${JSON.stringify({ ok: true, value })}\n`),
          )
          .catch((error) => {
            socket.write(
              `${JSON.stringify({
                ok: false,
                error: {
                  code: error?.code ?? 'agent_session_error',
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              })}\n`,
            );
          });
      }
    });
  });
  const ready = new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(endpoint, () => {
      server.off('error', onError);
      try {
        if (process.platform !== 'win32') chmodSync(endpoint, 0o600);
        resolve();
      } catch (error) {
        server.close();
        reject(error);
      }
    });
  });
  return {
    endpoint,
    ready,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
