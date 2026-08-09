#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { checkAgentSessionContract } from './agent-session-contract.mjs';

try {
  const result = await checkAgentSessionContract();
  console.log(
    `[agent-session-contract] contract=${result.contract} valid=${result.validFixtures} rejected=${result.rejectedFixtures} schema=${result.schemaValidation}`,
  );
} catch (error) {
  console.error(error?.stack ? error.stack : String(error));
  process.exit(1);
}
