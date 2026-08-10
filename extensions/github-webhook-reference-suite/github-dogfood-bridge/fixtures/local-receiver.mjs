// SPDX-License-Identifier: Apache-2.0

import { createServer } from 'node:http';

function readBody(request, maximum) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maximum) {
        reject(new Error('fixture body exceeded local bound'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}
export async function startLocalReceiver(host, maximum = 65_536) {
  const server = createServer(async (request, response) => {
    try {
      const body = await readBody(request, maximum);
      const result = await host.intake({
        method: request.method ?? '',
        path: new URL(request.url ?? '/', 'http://127.0.0.1').pathname,
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(',') : String(value ?? ''),
          ]),
        ),
        body,
        signature: typeof request.headers['x-fixture-signature'] === 'string'
          ? request.headers['x-fixture-signature']
          : null,
        replayKey: typeof request.headers['x-fixture-delivery'] === 'string'
          ? request.headers['x-fixture-delivery']
          : null,
      });
      response.statusCode = result.accepted ? 202 : 403;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ accepted: result.accepted, receipt: result.receipt }));
    } catch {
      response.statusCode = 500;
      response.end(JSON.stringify({ accepted: false, code: 'FIXTURE_RECEIVER_FAILED' }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
    server.close();
    throw new Error('local receiver did not bind exact loopback');
  }
  return {
    url: `http://127.0.0.1:${address.port}/events`,
    bindAddress: address.address,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}
