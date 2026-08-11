// SPDX-License-Identifier: Apache-2.0

import { writeFileSync } from 'node:fs';
import { readSkillRegistry } from '../src/index.ts';

function parseArgs(argv) {
  let home;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--home') {
      index += 1;
      home = argv[index];
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node --experimental-transform-types scripts/registry.mjs --home <dir>\n',
      );
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!home) throw new Error('--home is required');
  return home;
}

try {
  const report = readSkillRegistry(parseArgs(process.argv.slice(2)));
  writeFileSync(1, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
} catch (error) {
  process.stderr.write(
    `[skill-registry] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
