#!/usr/bin/env node
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { AgentSessionCapsuleHost } from './capsule-host.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const endpoint = argument('--endpoint');
const capsuleId = argument('--capsule-id');
const runtimeIdentity = argument('--runtime-identity');
const maxOutputBytes = Number(argument('--max-output-bytes') ?? 262144);
const explicitPtyModule = argument('--pty-module');
if (!endpoint || !capsuleId || !runtimeIdentity) {
  throw new Error(
    'usage: capsule-worker.mjs --endpoint PATH --capsule-id ID --runtime-identity ID',
  );
}

const require = createRequire(import.meta.url);
const packageJson = explicitPtyModule
  ? path.resolve(explicitPtyModule, '..', '..', 'package.json')
  : require.resolve('node-pty/package.json');
const packageRoot = path.dirname(packageJson);
const ptyModulePath =
  explicitPtyModule ?? path.join(packageRoot, 'lib', 'index.js');
const importedPty = await import(pathToFileURL(ptyModulePath).href);
const pty = importedPty.default ?? importedPty;
const helper = path.join(
  packageRoot,
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'spawn-helper',
);
let ptyReadiness = { ready: true, diagnostic: null };
if (process.platform === 'darwin') {
  const mode = fs.existsSync(helper) ? fs.statSync(helper).mode & 0o777 : 0;
  if ((mode & 0o111) === 0) {
    ptyReadiness = {
      ready: false,
      diagnostic: `node-pty spawn-helper is not executable: ${helper}; repair the packaged artifact before starting a provider`,
    };
  }
}

const host = new AgentSessionCapsuleHost({
  pty,
  capsuleId,
  runtimeIdentity,
  maxOutputBytes,
  ptyReadiness,
});

const operations = {
  handshake: () => host.handshake(),
  start: (payload) => host.start(payload),
  status: () => host.status(),
  snapshot: (payload) => host.snapshot(payload?.requestedSequence ?? 0),
  input: (payload) => host.input(payload),
  resize: (payload) => host.resize(payload),
  signal: (payload) => host.signal(payload),
  lifecycle: () => host.lifecycle(),
};
const MAX_REQUEST_BYTES = 1024 * 1024;

function reply(socket, value) {
  socket.write(`${JSON.stringify(value)}\n`);
}

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let pending = '';
  socket.on('data', (chunk) => {
    pending += chunk;
    if (Buffer.byteLength(pending, 'utf8') > MAX_REQUEST_BYTES) {
      reply(socket, {
        id: null,
        ok: false,
        error: 'request exceeds the 1 MiB local Capsule port limit',
      });
      socket.end();
      return;
    }
    while (pending.includes('\n')) {
      const newline = pending.indexOf('\n');
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line) continue;
      let request;
      try {
        request = JSON.parse(line);
        const operation = operations[request.operation];
        if (!operation)
          throw new Error(`unknown operation '${request.operation}'`);
        reply(socket, {
          id: request.id,
          ok: true,
          value: operation(request.payload),
        });
      } catch (error) {
        reply(socket, {
          id: request?.id ?? null,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
});

server.on('error', (error) => {
  process.stderr.write(`[agent-session-capsule] ${error.message}\n`);
  process.exitCode = 1;
});

server.listen(endpoint, () => {
  if (process.platform !== 'win32') fs.chmodSync(endpoint, 0o600);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
