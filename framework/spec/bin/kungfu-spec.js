#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0

const {
  inspectAuthority,
  inspectBundle,
  preserveBundle,
  verifyAuthorityBundle,
  verifyBundle,
} = require('../index.js');

function usage() {
  console.error(
    'usage: kungfu-spec authority | authority-verify | inspect BUNDLE | verify BUNDLE | preserve BUNDLE OUTPUT',
  );
}

function holdForQualification() {
  const milliseconds = Number(process.env.KUNGFU_QUALIFICATION_HOLD_MS || 0);
  if (milliseconds > 0)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

try {
  const [command, input, output, ...extra] = process.argv.slice(2);
  if (
    !command ||
    extra.length ||
    (!['authority', 'authority-verify'].includes(command) && !input) ||
    (['authority', 'authority-verify'].includes(command) &&
      (input || output)) ||
    (command === 'preserve' && !output)
  ) {
    usage();
    process.exit(2);
  }
  let result;
  if (command === 'authority') result = inspectAuthority();
  else if (command === 'authority-verify') result = verifyAuthorityBundle();
  else if (command === 'inspect') result = inspectBundle(input);
  else if (command === 'verify') result = verifyBundle(input);
  else if (command === 'preserve') result = preserveBundle(input, output);
  else {
    usage();
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  holdForQualification();
} catch (error) {
  console.error(
    `kungfu-spec: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
