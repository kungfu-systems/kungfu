// SPDX-License-Identifier: Apache-2.0

import { writeFileSync } from 'node:fs';
import {
  buildSkillManagerView,
  writeSkillManagerViewFile,
} from '../src/index.ts';

function parseArgs(argv) {
  const args = {
    home: undefined,
    paths: [],
    out: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === '--home') args.home = value();
    else if (arg === '--path') args.paths.push(value());
    else if (arg === '--out') args.out = value();
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!args.home) throw new Error('--home is required');
  return args;
}

function printHelp() {
  console.log(`Usage: node --experimental-transform-types scripts/manager.mjs --home <dir> [options]

Build a Kungfu Skill manager view through the Node manager implementation.

Options:
  --path <dir>                skill directory or skill root, repeatable
  --out <file>                write manager view to file instead of stdout
`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.out) {
    writeSkillManagerViewFile(args.home, {
      extraPaths: args.paths,
      out: args.out,
    });
    console.log(args.out);
  } else {
    const view = buildSkillManagerView(args.home, { extraPaths: args.paths });
    writeFileSync(1, `${JSON.stringify(view, null, 2)}\n`, 'utf8');
  }
} catch (e) {
  console.error(`skill manager failed: ${e.message}`);
  process.exit(1);
}
