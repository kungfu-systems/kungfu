#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { checkRuntimeContract } from './runtime-contract.mjs';

try {
  const result = await checkRuntimeContract();
  console.log(
    `[runtime-contract] contract=${result.contract} valid=${result.validFixtures} rejected=${result.rejectedFixtures} schema=${result.schemaValidation}`,
  );
} catch (error) {
  console.error(error?.stack ? error.stack : String(error));
  process.exit(1);
}
