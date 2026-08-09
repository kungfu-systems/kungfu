#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { checkUpgradeQualification } from './upgrade-qualification.mjs';

try {
  const result = checkUpgradeQualification();
  console.log(
    `[upgrade-qualification] contract=${result.contract} fixtures=${result.fixtures} messages=${result.messages} platforms=${result.platforms}`,
  );
} catch (error) {
  console.error(
    `[upgrade-qualification] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
