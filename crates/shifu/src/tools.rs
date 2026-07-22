// SPDX-License-Identifier: Apache-2.0
//
// Launcher-side adapter over shifu-core's bootstrap: same resolution
// semantics (PATH -> user-global cache -> pinned prebuilt download), plus the
// launcher's exit policy — a failed mandatory bootstrap dies with 127, the
// classic command-not-found code.

use std::path::{Path, PathBuf};

pub use shifu_core::bootstrap::{
    default_fnm_dir_if_bootstrapped, find_tool, Tool, BUILDCHAIN, FNM, UV,
};

use crate::util;

pub fn ensure_tool(tool: &Tool, root: &Path) -> PathBuf {
    shifu_core::bootstrap::ensure_tool(tool, root).unwrap_or_else(|err| {
        util::die_code(
            &format!(
                "{} is required but was not found on PATH, and bootstrapping the prebuilt binary \
                 failed: {err}\n  install it manually ({}) or fix the failure above and re-run",
                tool.name,
                tool.install_hint()
            ),
            127,
        )
    })
}
