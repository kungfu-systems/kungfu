#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { checkProjectCutHistoryContract } from './project-cut-history-contract.mjs';

try {
  const result = checkProjectCutHistoryContract();
  console.log(
    `[project-cut-history] schema=${result.schemaRoot} contract=${result.contractRoot} schemas=${result.schemaFiles} schema-validation=${result.schemaValidation}`,
  );
} catch (error) {
  console.error(error?.stack ? error.stack : String(error));
  process.exit(1);
}
