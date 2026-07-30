#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { checkWorkDesignPolicyReplayContract } from './work-design-policy-replay-contract.mjs';

try {
  const result = checkWorkDesignPolicyReplayContract();
  console.log(
    `[work-design-policy-replay] schema=${result.schemaRoot} contract=${result.contractRoot} schemas=${result.schemaFiles} schema-validation=${result.schemaValidation}`,
  );
} catch (error) {
  console.error(error?.stack ? error.stack : String(error));
  process.exit(1);
}
