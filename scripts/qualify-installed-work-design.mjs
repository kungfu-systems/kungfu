#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1])
    throw new Error(`${name} is required`);
  return path.resolve(process.argv[index + 1]);
}

function snapshot(runtimeRoot, files) {
  return Object.fromEntries(
    files.map((relative) => {
      const file = path.join(runtimeRoot, 'framework', ...relative.split('/'));
      const stat = fs.statSync(file);
      return [
        relative,
        {
          sha256: crypto
            .createHash('sha256')
            .update(fs.readFileSync(file))
            .digest('hex'),
          mode: stat.mode,
          mtimeMs: stat.mtimeMs,
        },
      ];
    }),
  );
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function run(binary, input, home) {
  const result = spawnSync(
    binary,
    ['--home', home, 'work-design', 'preflight', '--input', input],
    {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      env: {
        HOME: home,
        PATH: process.env.PATH,
        NODE_PATH: '',
        NODE_OPTIONS: '',
      },
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      result.error?.message ||
        result.stderr ||
        result.stdout ||
        `exit ${result.status}`,
    );
  return JSON.parse(result.stdout);
}

const binary = option('--binary');
const runtimeRoot = option('--runtime-root');
const surfaceIndex = process.argv.indexOf('--surface');
const surface =
  surfaceIndex >= 0 ? process.argv[surfaceIndex + 1] : 'installed';
const fixture = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'framework',
      'work',
      'work-design-preflight',
      'fixtures',
      'installed-preflight-request.json',
    ),
    'utf8',
  ),
);
function installedWorkDesignRequest({ manual = false } = {}) {
  const request = structuredClone(fixture);
  if (manual)
    request.disposition = {
      action: 'overridden',
      decisionAuthority: 'human',
      rationaleRoot:
        'sha256:df7186e3f525d9207abfb9a533e300f692cb70703886862698296a6d3e1f6b72',
    };
  return request;
}
const manifestPath = path.join(runtimeRoot, 'work-design-runtime.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (
  manifest.schema !== 'kungfu.work-design.runtime-closure/v1' ||
  !Array.isArray(manifest.files) ||
  !manifest.files.includes(manifest.entrypoint)
)
  throw new Error('installed Work Design closure manifest is invalid');

const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), 'kungfu-work-design-installed-'),
);
try {
  const home = path.join(temporary, 'home');
  const automaticInput = path.join(temporary, 'automatic.json');
  const manualInput = path.join(temporary, 'manual.json');
  fs.writeFileSync(
    automaticInput,
    `${JSON.stringify(installedWorkDesignRequest())}\n`,
  );
  fs.writeFileSync(
    manualInput,
    `${JSON.stringify(installedWorkDesignRequest({ manual: true }))}\n`,
  );
  const before = snapshot(runtimeRoot, manifest.files);
  const automatic = run(binary, automaticInput, home);
  const manual = run(binary, manualInput, home);
  const after = snapshot(runtimeRoot, manifest.files);
  if (
    automatic.outcome !== 'advisory-auto-adopted' ||
    automatic.operation?.mutates !== false ||
    automatic.authority?.assignment !== false
  )
    throw new Error(
      'installed automatic preflight violated its read-only boundary',
    );
  if (
    manual.outcome !== 'manual-capture' ||
    manual.adoption?.adopted !== false ||
    manual.fallback?.silentAdoption !== false
  )
    throw new Error(
      'installed manual capture was not an explicit human exception',
    );
  if (canonical(before) !== canonical(after))
    throw new Error(
      'installed Work Design runtime changed while preflight executed',
    );
  console.log(
    JSON.stringify(
      {
        schema: 'kungfu.work-design.installed-qualification/v1',
        status: 'qualified',
        surface,
        binary,
        runtimeRoot,
        entrypoint: manifest.entrypoint,
        fileCount: manifest.files.length,
        automaticOutcome: automatic.outcome,
        manualOutcome: manual.outcome,
        readOnly: true,
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
