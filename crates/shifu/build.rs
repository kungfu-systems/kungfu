// SPDX-License-Identifier: Apache-2.0
//
// Bake the build-time git identity into the binary so `shifu --version` can
// say exactly which commit produced it (the crate version alone is locked to
// the monorepo train and does not move between releases). std-only: shells
// out to git; falls back to "unknown" outside a checkout.

use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn main() {
    let sha = git(&["rev-parse", "--short=9", "HEAD"]).unwrap_or_else(|| "unknown".to_string());
    // Dirty marker scoped to this crate: enough to flag "not exactly that
    // commit" without a whole-monorepo status walk on every build.
    let dirty = git(&["status", "--porcelain", "--untracked-files=no", "--", "."])
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    println!(
        "cargo:rustc-env=SHIFU_GIT_SHA={sha}{}",
        if dirty { "-dirty" } else { "" }
    );
    // Build channel: release binaries (built by release-shifu.yml with
    // SHIFU_RELEASE_BUILD=1) identify as "release"; every local build — cargo
    // install, the shim's source-fresh slots, self-update — is "source", so
    // `shifu --version` always tells which supply chain the binary came from.
    let channel = if std::env::var_os("SHIFU_RELEASE_BUILD").is_some_and(|v| v == "1") {
        "release"
    } else {
        "source"
    };
    println!("cargo:rustc-env=SHIFU_BUILD_CHANNEL={channel}");
    println!("cargo:rerun-if-env-changed=SHIFU_RELEASE_BUILD");
    println!("cargo:rerun-if-changed=../../.git/HEAD");
}
