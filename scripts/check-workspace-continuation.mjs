#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { checkWorkspaceContinuationContract } from './workspace-continuation-contract.mjs';

try {
  const result = checkWorkspaceContinuationContract();
  console.log(
    `[workspace-continuation] contract=${result.contractRoot} states=${result.states} actions=${result.actions}`,
  );
} catch (error) {
  console.error(error?.stack ? error.stack : String(error));
  process.exit(1);
}
