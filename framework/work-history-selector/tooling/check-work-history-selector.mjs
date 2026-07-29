#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { checkWorkHistorySelectorContract } from './work-history-selector-contract.mjs';

try {
  const result = checkWorkHistorySelectorContract();
  console.log(
    `[work-history-selector] schema=${result.schemaRoot} contract=${result.contractRoot} schemas=${result.schemaFiles} schema-validation=${result.schemaValidation}`,
  );
} catch (error) {
  console.error(error?.stack ? error.stack : String(error));
  process.exit(1);
}
