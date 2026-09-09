#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import process from 'node:process';

import { AgentSessionCapsuleHost } from '@kungfu-tech/agent-session';
import {
  AgentSessionCapsulePeerTransport,
  InMemoryJournalNoticePort,
} from '@kungfu-tech/agent-session/peer-transport';

const PROFILE_ROOT = `sha256:${'b'.repeat(64)}`;

function value(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length)
    throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

function append(pathname, payload) {
  fs.appendFileSync(pathname, `${JSON.stringify(payload)}\n`, 'utf8');
}

class ProbePtyProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = process.pid;
  }

  onData(listener) {
    this.on('data', listener);
  }

  onExit(listener) {
    this.on('exit', listener);
  }

  write() {}
  resize() {}
  kill() {}
}

const commandPath = value('--command-path');
const markerPath = value('--marker-path');
const rejectionPath = value('--rejection-path');
const child = new ProbePtyProcess();
const host = new AgentSessionCapsuleHost({
  pty: { spawn: () => child },
  capsuleId: 'qualification-capsule',
  runtimeIdentity: 'qualification-runtime',
});
const started = host.start({
  workConsoleId: 'qualification-console',
  sessionAttemptId: 'qualification-attempt',
  capsuleGeneration: '1',
  sessionStreamEpoch: '1',
  provider: 'synthetic',
  profileRoot: PROFILE_ROOT,
  executable: process.execPath,
  argv: ['synthetic-provider'],
  cwd: process.cwd(),
});
const transport = new AgentSessionCapsulePeerTransport({
  host,
  port: new InMemoryJournalNoticePort(),
});

let offset = 0;
let registrationCount = 0;
function poll() {
  if (!fs.existsSync(commandPath)) return;
  const content = fs.readFileSync(commandPath, 'utf8');
  const next = content.slice(offset);
  offset = content.length;
  for (const line of next.split('\n').filter(Boolean)) {
    const authority = JSON.parse(line);
    try {
      if (registrationCount === 0) {
        transport.register({
          ...authority,
          supervisorGeneration: '1',
        });
      } else {
        transport.reregister(authority);
      }
      registrationCount += 1;
      append(markerPath, {
        event: 'capsule-ready',
        pid: process.pid,
        providerProcessStartIdentity: started.foreground.processStartIdentity,
        sessionStreamEpoch: transport.status().sessionStreamEpoch,
        runtimeContinuity: transport.status().runtimeContinuity,
        readyIndex: registrationCount,
      });
    } catch (error) {
      append(rejectionPath, {
        event: 'capsule-authority-rejected',
        pid: process.pid,
        code: error.code || 'unknown',
        message: error.message,
        authority,
      });
    }
  }
}

console.log(JSON.stringify({ event: 'capsule-starting', pid: process.pid }));
const timer = setInterval(poll, 25);
process.on('SIGTERM', () => {
  clearInterval(timer);
  process.exit(0);
});
