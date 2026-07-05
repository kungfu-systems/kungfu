// SPDX-License-Identifier: Apache-2.0
//
// Cost-wire fixture. Proves the parse-layer CostSnapshot becomes a rewind
// open-layer journal event (msg_type 30008) that decodes without the runtime
// that wrote it: the serializer + parse->wire bridge round-trip, the honesty
// invariant (unknown cost never becomes 0.0), and the pinned rewind_events.bfbs
// carrying the CostSnapshot shape for schema-only decode.
//
// Heavier than the pure-stdlib cost-adapter parse fixture — it needs flatbuffers
// — so it runs under `uv run --frozen python`. It still needs no built
// dist/kungfu and no journal writer: the check stubs the top-level kungfu
// package so the native binding import is skipped.
//
// Usage: node tests/fixtures/rewind-demo-cost-wire/run.mjs

import path from 'node:path';
import { locate, uvPython } from '../_harness.mjs';

const { fixtureDir, coreDir } = locate(import.meta.url);

uvPython(coreDir, [path.join(fixtureDir, 'check_cost_wire.py'), fixtureDir]);
