#!/usr/bin/env node

// SPDX-License-Identifier: Apache-2.0

const { inspectBundle, preserveBundle, verifyBundle } = require('../index.js');

function usage() {
  console.error(
    'usage: kungfu-spec inspect BUNDLE | verify BUNDLE | preserve BUNDLE OUTPUT',
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
    !input ||
    extra.length ||
    (command === 'preserve' && !output)
  ) {
    usage();
    process.exit(2);
  }
  let result;
  if (command === 'inspect') result = inspectBundle(input);
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
