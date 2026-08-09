#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { checkProjectCutCompositionContract } from './project-cut-composition-contract.mjs';

try {
  const result = checkProjectCutCompositionContract();
  console.log(
    `[project-cut-composition] schema=${result.schemaRoot} contract=${result.contractRoot} schemas=${result.schemaFiles}`,
  );
} catch (error) {
  console.error(error?.stack ? error.stack : String(error));
  process.exit(1);
}
