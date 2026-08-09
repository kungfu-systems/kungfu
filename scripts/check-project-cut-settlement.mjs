#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { checkProjectCutSettlementContract } from './project-cut-settlement-contract.mjs';

try {
  const result = checkProjectCutSettlementContract();
  console.log(
    `[project-cut-settlement] schema=${result.schemaRoot} contract=${result.contractRoot} schemas=${result.schemaFiles} schema-validation=${result.schemaValidation}`,
  );
} catch (error) {
  console.error(error?.stack ? error.stack : String(error));
  process.exit(1);
}
