// SPDX-License-Identifier: Apache-2.0
//
// The shared bootstrap engine: resolve a pinned prebuilt tool (PATH → user
// cache → download by exact version, optionally checksum-verified), plus the
// path/probe helpers that discipline requires. Extracted from the shifu
// launcher (ADR-0044 lineage) so the product trunk (ADR-0046 stage 1) shares
// one downloader instead of reinventing it; both consumers keep the same
// user-global cache under `${XDG_CACHE_HOME:-~/.cache}/kungfu/`.
//
// Library rules:
//   - std-only, zero crates — same supply-chain discipline as shifu.
//   - never exits the process; fallible operations return Result and the
//     consuming binary decides how to die (shifu keeps its exit codes, the
//     trunk raises named self-diagnosing errors).
//   - no delegation / repo-discovery logic — that is shifu's own protocol
//     (ADR-0044) and stays in the shifu crate.

pub mod fetch;
pub mod paths;
pub mod tool;
