#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const schemaDir = path.join(
  process.cwd(),
  'framework',
  'core',
  'src',
  'libkungfu',
  'schemas',
);
const candidates = [process.env.FLATC].filter(Boolean);
const conanBuildRoot = path.join(os.homedir(), '.conan2', 'p', 'b');
if (fs.existsSync(conanBuildRoot)) {
  for (const slot of fs.readdirSync(conanBuildRoot)) {
    candidates.push(path.join(conanBuildRoot, slot, 'p', 'bin', 'flatc'));
  }
}
candidates.push('flatc');

let lastError;
for (const flatc of candidates) {
  if (flatc !== 'flatc' && !fs.existsSync(flatc)) continue;
  const result = spawnSync(
    flatc,
    [
      '-b',
      '--schema',
      '--bfbs-filenames',
      '.',
      '-o',
      '.',
      'profile_lifecycle_event.fbs',
    ],
    { cwd: schemaDir, stdio: 'inherit' },
  );
  if (!result.error && result.status === 0) process.exit(0);
  lastError = result.error ?? new Error(`flatc exited ${result.status}`);
}
throw lastError ?? new Error('flatc not found; run ./shifu build:core first');
