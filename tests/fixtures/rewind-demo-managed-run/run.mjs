// SPDX-License-Identifier: Apache-2.0
//
// Managed-run fixture. Proves the seam that joins the cost parse layer and the
// cost wire event into one managed act: launch a provider, parse its
// structured output, and emit a CostSnapshot journal event bound to the run.
// Drives run_managed with an injected fake process runner and a list-collecting
// emit sink (the same (action_type, bytes) signature the supervisor exposes), so it
// spawns no real CLI and needs no native journal writer.
//
// Runs under `uv run --frozen python` for flatbuffers; stubs the top-level
// kungfu package so the native binding import is skipped.
//
// Usage: node tests/fixtures/rewind-demo-managed-run/run.mjs

import path from 'node:path';
import { locate, uvPython } from '../_harness.mjs';

const { fixtureDir, coreDir } = locate(import.meta.url);

uvPython(coreDir, [path.join(fixtureDir, 'check_managed_run.py'), fixtureDir]);
