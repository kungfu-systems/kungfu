// SPDX-License-Identifier: Apache-2.0
//
// Prerequisite tools (fnm for the node side, uv for the python side).
//
// The resolution and download engine lives in the shared `bootstrap` crate
// (extracted from here so the product trunk consumes the same discipline —
// ADR-0046 stage 1). shifu keeps only its own policy: exit code 127 with the
// launcher-prefixed message when a required tool cannot be provided.

use std::path::{Path, PathBuf};

pub use bootstrap::tool::{default_fnm_dir_if_bootstrapped, find_tool, Tool, FNM, UV};

use crate::util;

/// Resolve a tool, bootstrapping the pinned prebuilt release when absent.
pub fn ensure_tool(tool: &Tool, root: &Path) -> PathBuf {
    bootstrap::tool::ensure_tool(tool, root, "shifu")
        .unwrap_or_else(|msg| util::die_code(&msg, 127))
}
