import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerScript = path.join(here, '..', 'src', 'capsule-worker.mjs');
const providerScript = path.join(here, 'fixtures', 'synthetic-provider.mjs');
const PROFILE_ROOT = `sha256:${'b'.repeat(64)}`;
const require = createRequire(import.meta.url);
const socketTempRoot = process.platform === 'darwin' ? '/tmp' : os.tmpdir();

function preparedNodePty(temp) {
  const source = path.dirname(require.resolve('node-pty/package.json'));
  const target = path.join(temp, 'node-pty');
  fs.cpSync(source, target, { recursive: true });
  if (process.platform === 'darwin') {
    const helper = path.join(
      target,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper',
    );
    const mode = fs.statSync(helper).mode & 0o777;
    fs.chmodSync(helper, mode | 0o111);
  }
  return path.join(target, 'lib', 'index.js');
}

async function stopTestOwnedChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  let diagnostic = '';
  if (process.platform === 'win32' && child.pid) {
    const result = spawnSync(
      'taskkill.exe',
      ['/pid', String(child.pid), '/t', '/f'],
      { encoding: 'utf8', windowsHide: true },
    );
    diagnostic = [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join('\n')
      .trim();
  } else {
    child.kill('SIGTERM');
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null)
    throw new Error(
      `test-owned Capsule process tree ${child.pid || 'unknown'} did not exit: ${diagnostic || 'no termination diagnostic'}`,
    );
}

async function waitFor(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

async function connect(endpoint) {
  const socket = net.createConnection(endpoint);
  socket.setEncoding('utf8');
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  let sequence = 0;
  let pending = '';
  const waiting = new Map();
  socket.on('data', (chunk) => {
    pending += chunk;
    while (pending.includes('\n')) {
      const newline = pending.indexOf('\n');
      const response = JSON.parse(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      const entry = waiting.get(response.id);
      waiting.delete(response.id);
      if (response.ok) entry?.resolve(response.value);
      else entry?.reject(new Error(response.error));
    }
  });
  return {
    close: () => socket.destroy(),
    request(operation, payload) {
      sequence += 1;
      const id = `request-${sequence}`;
      socket.write(`${JSON.stringify({ id, operation, payload })}\n`);
      return new Promise((resolve, reject) =>
        waiting.set(id, { resolve, reject }),
      );
    },
  };
}

test('detached Capsule worker survives client loss and reattaches to the same PTY', async (t) => {
  const temp = fs.mkdtempSync(path.join(socketTempRoot, 'kungfu-capsule-'));
  const endpoint = path.join(temp, 'capsule.sock');
  const ptyModule = preparedNodePty(temp);
  const child = spawn(
    process.execPath,
    [
      workerScript,
      '--endpoint',
      endpoint,
      '--capsule-id',
      'capsule-smoke',
      '--runtime-identity',
      'runtime-smoke',
      '--max-output-bytes',
      '512',
      '--pty-module',
      ptyModule,
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await stopTestOwnedChild(child);
    fs.rmSync(temp, { force: true, recursive: true });
  });
  await waitFor(
    () => fs.existsSync(endpoint),
    'Capsule endpoint did not appear',
    process.platform === 'win32' ? 20_000 : 5_000,
  );

  const first = await connect(endpoint);
  clients.push(first);
  const handshake = await first.request('handshake');
  assert.equal(handshake.processId, child.pid);
  assert.ok(handshake.capabilities.includes('pty-owner'));
  const started = await first.request('start', {
    workConsoleId: 'console-smoke',
    sessionAttemptId: 'attempt-smoke',
    capsuleGeneration: '3',
    sessionStreamEpoch: '5',
    provider: 'synthetic',
    profileRoot: PROFILE_ROOT,
    executable: process.execPath,
    argv: [providerScript],
    cwd: temp,
    env: { PATH: process.env.PATH, HOME: temp, TERM: 'xterm-256color' },
    cols: 40,
    rows: 8,
  });
  first.close();

  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await connect(endpoint);
  clients.push(second);
  const reattached = await second.request('status');
  assert.equal(reattached.sessionAttemptId, started.sessionAttemptId);
  assert.equal(reattached.foreground.pid, started.foreground.pid);
  await waitFor(async () => {
    const replay = await second.request('snapshot', { requestedSequence: 0 });
    return replay.receipt.nextSequence > 4096;
  }, 'synthetic PTY output did not arrive');
  const replay = await second.request('snapshot', { requestedSequence: 0 });
  assert.equal(replay.receipt.gap.reason, 'bounded-retention-overflow');
  assert.equal(replay.vt.activeBuffer, 'primary');
  assert.ok(replay.vt.lines.some((line) => line.includes('approval-needed')));

  const current = {
    sessionAttemptId: reattached.sessionAttemptId,
    capsuleGeneration: reattached.capsuleGeneration,
    sessionStreamEpoch: reattached.sessionStreamEpoch,
    processStartIdentity: reattached.foreground.processStartIdentity,
  };
  const receipt = await second.request('input', {
    ...current,
    actionId: 'action-exit',
    inputId: 'input-exit',
    data: 'exit\r',
  });
  assert.equal(receipt.proves, 'validated-input-written-to-pty-only');
  assert.equal(receipt.semanticOutcome, null);
  await waitFor(
    async () => (await second.request('status')).lifecycleState === 'ended',
    'provider did not exit',
  );
  await assert.rejects(
    second.request('input', {
      ...current,
      actionId: 'action-late',
      inputId: 'input-late',
      data: 'echo unsafe\r',
    }),
    /input admission is closed/u,
  );
});
