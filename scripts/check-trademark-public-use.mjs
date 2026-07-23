#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import {
  CONTRACT_PATH,
  loadTrademarkPublicUse,
  validateTrademarkPublicUse,
} from './trademark-public-use-contract.mjs';

const { contract, surfaces } = loadTrademarkPublicUse();
const issues = validateTrademarkPublicUse(contract, surfaces);
if (issues.length) {
  for (const issue of issues) console.error(`[trademark-public-use] ${issue}`);
  process.exit(1);
}
console.log(
  `[trademark-public-use] contract=${CONTRACT_PATH} state=pre-release valid=true`,
);
