#!/usr/bin/env node

import readline from 'node:readline';

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});

for await (const line of input) {
  const request = JSON.parse(line);
  const handshake = request.operation === 'handshake';
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      contract: 'kfd.agent-runtime-adapter-response/v1',
      requestId: request.requestId,
      adapter: {
        id: 'kungfu-deliberately-invalid-always-accept',
        version: '0.0.0',
        topology: 'negative-fixture',
      },
      status: 'accepted',
      code: handshake ? 'adapter-ready' : 'invalid-always-accept',
      observations: handshake
        ? {
            profile: 'kfd-agent-runtime@0.1.0-alpha.1',
            protocol: 'jsonl-stdio/v1',
          }
        : { deliberatelyInvalid: true },
    })}\n`,
  );
}
