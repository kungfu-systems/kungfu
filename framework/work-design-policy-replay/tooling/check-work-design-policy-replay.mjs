#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';

import { checkWorkDesignPolicyReplayContract } from './work-design-policy-replay-contract.mjs';

function readFeedbackInput(argv) {
  const index = argv.indexOf('--input');
  if (index < 0 || !argv[index + 1])
    throw new Error(
      'usage: work-design:feedback <compile|shadow|activate|monitor|transition|status> --input <request.json>',
    );
  return JSON.parse(fs.readFileSync(argv[index + 1], 'utf8'));
}

async function runFeedback(argv) {
  const {
    compileWorkDesignOutcome,
    decideWorkDesignActivation,
    decideWorkDesignCanary,
    evaluateWorkDesignShadow,
    inspectWorkDesignFeedback,
    transitionWorkDesignPolicyState,
  } = await import('../src/index.mjs');
  const [operation = '', ...args] = argv;
  const input = readFeedbackInput(args);
  const operations = {
    compile: () => compileWorkDesignOutcome(input),
    shadow: () => evaluateWorkDesignShadow(input),
    activate: () => decideWorkDesignActivation(input),
    monitor: () => decideWorkDesignCanary(input),
    transition: () =>
      transitionWorkDesignPolicyState(input.state, input.decision),
    status: () => inspectWorkDesignFeedback(input),
  };
  if (!(operation in operations))
    throw new Error(`unsupported Work Design feedback operation: ${operation}`);
  const result = operations[operation]();
  console.log(JSON.stringify(result, null, 2));
  if (result?.ok === false) process.exitCode = 1;
}

try {
  const [command = 'check', ...args] = process.argv.slice(2);
  if (command === 'feedback') await runFeedback(args);
  else {
    const result = checkWorkDesignPolicyReplayContract();
    console.log(
      `[work-design-policy-replay] schema=${result.schemaRoot} contract=${result.contractRoot} schemas=${result.schemaFiles} schema-validation=${result.schemaValidation}`,
    );
  }
} catch (error) {
  console.error(error?.stack ? error.stack : String(error));
  process.exit(1);
}
