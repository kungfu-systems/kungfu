#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { checkUpgradeContract } from './upgrade-contract.mjs';

try {
  const result = checkUpgradeContract();
  console.log(
    `[upgrade-contract] contract=${result.contract} states=${result.states} reasons=${result.reasons} fixtures=${result.fixtures}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
