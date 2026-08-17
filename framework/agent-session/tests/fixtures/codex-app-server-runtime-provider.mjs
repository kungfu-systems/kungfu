// SPDX-License-Identifier: Apache-2.0

import readline from 'node:readline';

const mode = process.argv[2] ?? 'late-turn-response';
const lines = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function turn(threadId, turnId, status = 'inProgress') {
  return { id: turnId, status, items: [] };
}

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'synthetic-redacted' } });
    return;
  }
  if (message.method === 'initialized') {
    if (mode === 'malformed') {
      process.stdout.write('{not-json}\n');
    } else if (mode === 'unknown-method') {
      send({ method: 'provider/unknown', params: {} });
    } else if (mode === 'unknown-request') {
      send({ id: 'future-request-1', method: 'provider/unknown', params: {} });
    } else if (mode === 'burst') {
      for (let index = 0; index < 32; index += 1) {
        send({
          method: 'thread/status/changed',
          params: { threadId: `thread-${index}`, status: { type: 'idle' } },
        });
      }
    } else if (mode === 'server-request') {
      send({
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          startedAtMs: 1,
        },
      });
    } else if (mode === 'multi-identity') {
      send({
        method: 'turn/started',
        params: { threadId: 'thread-a', turn: turn('thread-a', 'turn-a') },
      });
      send({
        method: 'turn/started',
        params: { threadId: 'thread-b', turn: turn('thread-b', 'turn-b') },
      });
    } else if (mode === 'stderr-redaction') {
      process.stderr.write('synthetic-secret-must-not-be-retained');
    } else if (mode === 'unexpected-exit') {
      setTimeout(() => process.exit(23), 5);
    }
    return;
  }
  if (
    message.method === 'thread/start' &&
    [
      'product-route',
      'response-first-product-route',
      'response-first-slow-terminal-product-route',
    ].includes(mode)
  ) {
    send({
      method: 'thread/started',
      params: { thread: { id: 'thread-product' } },
    });
    send({ id: message.id, result: { thread: { id: 'thread-product' } } });
    return;
  }
  if (message.method === 'turn/start') {
    const threadId = message.params.threadId;
    if (
      mode === 'response-first-product-route' ||
      mode === 'response-first-slow-terminal-product-route'
    ) {
      send({ id: message.id, result: { turn: { id: 'turn-authority' } } });
      setTimeout(() => {
        send({
          method: 'turn/started',
          params: { threadId, turn: turn(threadId, 'turn-authority') },
        });
        const complete = () => {
          send({
            method: 'item/agentMessage/delta',
            params: {
              threadId,
              turnId: 'turn-authority',
              itemId: 'message-authority',
              delta: 'Structured answer retained.',
            },
          });
          send({
            method: 'turn/completed',
            params: {
              threadId,
              turn: turn(threadId, 'turn-authority', 'completed'),
            },
          });
        };
        if (mode === 'response-first-slow-terminal-product-route') {
          setTimeout(complete, 250);
        } else {
          complete();
        }
      }, 25);
      return;
    }
    send({
      method: 'turn/started',
      params: { threadId, turn: turn(threadId, 'turn-authority') },
    });
    if (mode === 'product-route') {
      send({
        id: 'approval-product',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId,
          turnId: 'turn-authority',
          itemId: 'item-product',
          startedAtMs: 1,
        },
      });
      send({ id: message.id, result: { turn: { id: 'turn-authority' } } });
      return;
    }
    send({
      method: 'turn/completed',
      params: {
        threadId,
        turn: turn(threadId, 'turn-authority', 'completed'),
      },
    });
    setTimeout(
      () => send({ id: message.id, result: { turn: { id: 'turn-authority' } } }),
      10,
    );
    return;
  }
  if (message.id === 'approval-product' && mode === 'product-route') {
    send({
      method: 'serverRequest/resolved',
      params: {
        requestId: 'approval-product',
        threadId: 'thread-product',
      },
    });
    send({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-product',
        turnId: 'turn-authority',
        itemId: 'message-product',
        delta: 'Approved structured answer retained.',
      },
    });
    send({
      method: 'turn/completed',
      params: {
        threadId: 'thread-product',
        turn: turn('thread-product', 'turn-authority', 'completed'),
      },
    });
    return;
  }
  if (message.method === 'turn/interrupt' && mode === 'product-route') {
    send({
      method: 'turn/completed',
      params: {
        threadId: message.params.threadId,
        turn: turn(
          message.params.threadId,
          message.params.turnId,
          'interrupted',
        ),
      },
    });
    send({ id: message.id, result: {} });
  }
});

process.on('SIGTERM', () => process.exit(0));
