#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { checkWorkDesignAdvisorContract } from './work-design-advisor-contract.mjs';

try {
  const result = checkWorkDesignAdvisorContract();
  console.log(
    `[work-design-advisor] schema=${result.schemaRoot} contract=${result.contractRoot} schemas=${result.schemaFiles} schema-validation=${result.schemaValidation}`,
  );
} catch (error) {
  console.error(error?.stack ? error.stack : String(error));
  process.exit(1);
}
