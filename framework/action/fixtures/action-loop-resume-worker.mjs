// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resumeActionLoop } from '../action-loop-begin.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(
  fs.readFileSync(path.join(DIR, '..', 'action-loop.contract.json'), 'utf8'),
);
const [checkpointFile, loopRef] = process.argv.slice(2);
const persisted = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
const rows = new Map(persisted.rows);
const checkpointStore = {
  async load(ref) {
    return rows.has(ref)
      ? { status: 'current', ...rows.get(ref) }
      : { status: 'absent' };
  },
  async resolve(ref) {
    return rows.get(ref)?.envelope.factRef;
  },
};
const adapters = {
  checkpointStore,
  atlasCompiler: {
    async observe(binding) {
      return { current: binding.state === 'current' };
    },
  },
  warrantResolver: {
    async observe(binding) {
      return { state: binding.state };
    },
  },
  episodeRecorder: {
    async inspect(binding) {
      return { state: binding.state, externalEffect: 'accepted' };
    },
  },
};

const result = await resumeActionLoop(contract, loopRef, adapters);
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;
