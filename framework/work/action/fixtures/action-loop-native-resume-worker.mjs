// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createCorePublicAdapters,
  createExplicitCompatibilityAdapters,
  resumeActionLoop,
} from '../action-loop-begin.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(
  fs.readFileSync(path.join(DIR, '..', 'action-loop.contract.json'), 'utf8'),
);
const [runtime, loopRef] = process.argv.slice(2);

function invoke(operation, payload) {
  const child = spawnSync(
    'uv',
    [
      'run',
      '--project',
      path.join(DIR, '..', '..', '..', 'core'),
      '--frozen',
      'python',
      '-m',
      'kungfu.agent.action_loop',
      '--runtime-dir',
      runtime,
      operation,
    ],
    {
      cwd: path.join(DIR, '..', '..', '..', '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        PYTHONPATH: [
          path.join(DIR, '..', '..', '..', 'core', 'src', 'python'),
          path.join(DIR, '..', '..', '..', 'core', 'build', 'python'),
          process.env.PYTHONPATH,
        ]
          .filter(Boolean)
          .join(path.delimiter),
      },
      input: JSON.stringify(payload),
    },
  );
  if (child.status !== 0) throw new Error(child.stderr);
  return JSON.parse(child.stdout);
}

const result = await resumeActionLoop(contract, loopRef, {
  ...createExplicitCompatibilityAdapters(),
  ...createCorePublicAdapters(invoke),
});
process.stdout.write(`${JSON.stringify(result)}\n`);
