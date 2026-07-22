#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { checkEpisodeAdmissionContract } from './episode-admission-contract.mjs';

try {
  const result = checkEpisodeAdmissionContract();
  console.log(
    `[episode-admission] contract=${result.contractRoot} actions=${result.actions} transports=${result.transports} states=${result.states}`,
  );
} catch (error) {
  console.error(error?.stack ? error.stack : String(error));
  process.exit(1);
}
