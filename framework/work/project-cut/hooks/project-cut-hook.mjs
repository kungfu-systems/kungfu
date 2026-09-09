#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import {
  observeSettlementCommit,
  verifySettlement,
} from '../src/settlement.mjs';

const hook = process.argv[2];
const statePath = process.env.PROJECT_CUT_SETTLEMENT_STATE;

function emit(value) {
  process.stdout.write(
    `${JSON.stringify({ schema: 'project.cut.hook-response/v1', ...value })}\n`,
  );
}

try {
  if (!statePath) {
    emit({ ok: true, hook, outcome: 'not-configured', authority: false });
  } else if (hook === 'pre-commit') {
    const result = verifySettlement(process.cwd(), statePath);
    emit({ ...result, hook, authority: false });
    if (!result.ok) process.exitCode = 1;
  } else if (hook === 'post-commit') {
    const result = observeSettlementCommit(process.cwd(), statePath, 'HEAD', {
      execute: true,
    });
    emit({ ...result, hook, authority: false });
    if (!result.ok) process.exitCode = 1;
  } else {
    throw Object.assign(new Error(`unknown Project Cut hook '${hook}'`), {
      code: 'unknown-hook',
    });
  }
} catch (error) {
  emit({
    ok: false,
    hook,
    authority: false,
    error: {
      code: error.code ?? 'hook-failed',
      message: String(error.message),
    },
  });
  process.exitCode = 1;
}
