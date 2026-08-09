#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { checkProjectCutContract } from './project-cut-contract.mjs';

try {
  const result = checkProjectCutContract();
  console.log(
    `[project-cut-contract] schema=${result.schemaRoot} protocol=${result.protocolRoot} cut=${result.cutRoot} receipt=${result.receiptRoot} schemas=${result.schemaFiles} schema-validation=${result.schemaValidation} schema-fixtures=${result.schemaFixtures} negative=${result.negativeFixtures}`,
  );
} catch (error) {
  console.error(error?.stack ? error.stack : String(error));
  process.exit(1);
}
