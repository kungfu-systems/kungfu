// SPDX-License-Identifier: Apache-2.0

import { writeFileSync } from 'node:fs';
import { buildSkillContext, writeSkillContextFile } from '../src/index.ts';

function parseArgs(argv) {
  const args = {
    home: undefined,
    source: 'gui',
    manager: 'node',
    profile: undefined,
    agent: undefined,
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
    else if (arg === '--source') args.source = value();
    else if (arg === '--manager') args.manager = value();
    else if (arg === '--profile') args.profile = value();
    else if (arg === '--agent') args.agent = value();
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
  if (!['cli', 'gui', 'test'].includes(args.source)) {
    throw new Error(`unsupported source: ${args.source}`);
  }
  if (!['node', 'python'].includes(args.manager)) {
    throw new Error(`unsupported manager: ${args.manager}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node --experimental-transform-types scripts/context.mjs --home <dir> [options]

Build a Kungfu Skill context envelope through the Node manager implementation.

Options:
  --source cli|gui|test       session source (default: gui)
  --manager node|python       session manager label (default: node)
  --profile <name>            optional profile label
  --agent <name>              optional agent label
  --path <dir>                skill directory or skill root, repeatable
  --out <file>                write envelope to file instead of stdout
`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.out) {
    writeSkillContextFile(args.home, {
      source: args.source,
      manager: args.manager,
      profile: args.profile,
      agent: args.agent,
      extraPaths: args.paths,
      out: args.out,
    });
    console.log(args.out);
  } else {
    const envelope = buildSkillContext(args.home, {
      source: args.source,
      manager: args.manager,
      profile: args.profile,
      agent: args.agent,
      extraPaths: args.paths,
    });
    writeFileSync(1, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  }
} catch (e) {
  console.error(`skill context failed: ${e.message}`);
  process.exit(1);
}
