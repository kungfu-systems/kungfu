// SPDX-License-Identifier: Apache-2.0
//
// Approval-bridge fixture. Proves a human control decision on a managed run
// becomes a journal fact (ApprovalDecision, msg_type 30009) and yields the right
// process control action (SIGINT for interrupt, input for approve/deny/resume),
// plus schema-only decode of the pinned .bfbs. No real terminal, no native
// journal writer.
//
// Runs under `uv run --frozen python` for flatbuffers; stubs the top-level
// kungfu package so the native binding import is skipped.
//
// Usage: node tests/fixtures/rewind-demo-approval/run.mjs

import path from 'node:path';
import { locate, uvPython } from '../_harness.mjs';

const { fixtureDir, coreDir } = locate(import.meta.url);

uvPython(coreDir, [path.join(fixtureDir, 'check_approval.py'), fixtureDir]);
