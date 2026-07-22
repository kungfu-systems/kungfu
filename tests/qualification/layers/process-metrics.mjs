// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawn, spawnSync } from 'node:child_process';

function sampleResidentBytes(pid) {
  if (process.platform === 'win32') {
    const result = spawnSync(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.status !== 0) return null;
    const columns = (result.stdout.match(/"(?:[^"]|"")*"/g) || []).map(
      (value) => value.slice(1, -1).replaceAll('""', '"'),
    );
    const kib = Number((columns[4] || '').replace(/[^0-9]/g, ''));
    return Number.isFinite(kib) && kib > 0 ? kib * 1024 : null;
  }
  const result = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  const kib = Number(result.stdout.trim());
  return Number.isFinite(kib) && kib > 0 ? kib * 1024 : null;
}

export function qualificationHoldMs(platform = process.platform) {
  return platform === 'win32' || platform === 'linux' ? 1000 : 100;
}

export function runMeasured(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: options.shell ?? false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let peakResidentBytes = 0;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const sample = () => {
      const value = sampleResidentBytes(child.pid);
      if (value !== null)
        peakResidentBytes = Math.max(peakResidentBytes, value);
    };
    sample();
    const timer = setInterval(sample, options.sampleIntervalMs || 10);
    child.once('error', (error) => {
      clearInterval(timer);
      reject(
        new Error(
          `${command} ${args.join(' ')} could not start: ${error.message}`,
          { cause: error },
        ),
      );
    });
    child.once('close', (status, signal) => {
      clearInterval(timer);
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (status !== 0) {
        reject(
          new Error(
            `${command} ${args.join(' ')} failed (status=${status}, signal=${signal || 'none'}):\n${stderr}`,
          ),
        );
        return;
      }
      if (peakResidentBytes <= 0) {
        reject(
          new Error(
            `${command} completed before a resident-memory sample could be recorded`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, durationMs, peakResidentBytes });
    });
  });
}
