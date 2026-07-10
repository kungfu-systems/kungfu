// SPDX-License-Identifier: Apache-2.0
//
// Task dispatch — the launcher's actual job.
//
//   run_pnpm:     ensure fnm + uv, pin node (`fnm install`), then run the task
//                 under the pinned toolchain via `fnm exec -- corepack pnpm`.
//   delegate_l2:  rich subcommands (build/rebuild/proxy/config) go to the L2
//                 node implementation (shifu.mjs), never to pnpm.
//
// A tiny `pnpm -> corepack pnpm` shim dir is prepended to PATH for the child
// so repo scripts that spawn bare `pnpm` work without requiring the user to
// have run `corepack enable` (the CI wrapper did the same).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::{tools, util};

pub fn run_pnpm(root: &Path, args: &[String]) -> ! {
    let fnm = tools::ensure_tool(&tools::FNM);
    let uv = tools::ensure_tool(&tools::UV);
    tools::default_fnm_dir_if_bootstrapped(&fnm);

    // Idempotent: make sure the node pinned by .node-version is installed.
    util::run_quiet(&fnm, &["install"], root);

    let mut cmd = Command::new(&fnm);
    cmd.arg("exec").arg("--using-file").arg("--");
    if cfg!(windows) {
        // fnm spawns the target directly without PATHEXT resolution, so bare
        // "corepack" is not found on Windows — only corepack.cmd is.
        cmd.arg("corepack.cmd");
    } else {
        cmd.arg("corepack");
    }
    cmd.arg("pnpm").args(args).current_dir(root);
    prepend_child_path(&mut cmd, tool_dirs_for_child(&fnm, &uv));
    util::exec_or_exit(cmd)
}

pub fn delegate_l2(root: &Path, args: &[String]) -> ! {
    let l2 = root.join("shifu.mjs");

    // Prefer the pinned node via an fnm that is already present (PATH or
    // cache); fall back to any system node so `config` can run before the
    // toolchain is ready; bootstrap fnm only as the last resort.
    if let Some(fnm) = tools::find_tool(&tools::FNM) {
        tools::default_fnm_dir_if_bootstrapped(&fnm);
        util::run_quiet(&fnm, &["install"], root);
        let mut cmd = Command::new(&fnm);
        cmd.arg("exec")
            .arg("--using-file")
            .arg("--")
            .arg("node")
            .arg(&l2)
            .args(args)
            .current_dir(root);
        prepend_child_path(&mut cmd, tool_dirs_for_child(&fnm, Path::new("")));
        util::exec_or_exit(cmd)
    }
    if let Some(node) = util::find_on_path("node") {
        let mut cmd = Command::new(node);
        cmd.arg(&l2).args(args).current_dir(root);
        util::exec_or_exit(cmd)
    }
    let fnm = tools::ensure_tool(&tools::FNM);
    tools::default_fnm_dir_if_bootstrapped(&fnm);
    util::run_quiet(&fnm, &["install"], root);
    let mut cmd = Command::new(&fnm);
    cmd.arg("exec")
        .arg("--using-file")
        .arg("--")
        .arg("node")
        .arg(&l2)
        .args(args)
        .current_dir(root);
    prepend_child_path(&mut cmd, tool_dirs_for_child(&fnm, Path::new("")));
    util::exec_or_exit(cmd)
}

/// Directories to prepend to the child's PATH: the pnpm shim plus the dirs of
/// cache-resolved tools (so `uv` / `fnm` invoked by build scripts resolve even
/// though they are not on the user's PATH).
fn tool_dirs_for_child(fnm: &Path, uv: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(shim) = make_pnpm_shim_dir() {
        dirs.push(shim);
    }
    for tool in [fnm, uv] {
        if tool.as_os_str().is_empty() {
            continue;
        }
        if tool.starts_with(util::kungfu_cache_dir()) {
            if let Some(dir) = tool.parent() {
                dirs.push(dir.to_path_buf());
            }
        }
    }
    dirs
}

fn prepend_child_path(cmd: &mut Command, dirs: Vec<PathBuf>) {
    if dirs.is_empty() {
        return;
    }
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut paths: Vec<PathBuf> = dirs;
    paths.extend(std::env::split_paths(&current));
    if let Ok(joined) = std::env::join_paths(paths) {
        cmd.env("PATH", joined);
    }
}

fn make_pnpm_shim_dir() -> std::io::Result<PathBuf> {
    let dir = util::unique_temp_dir("shifu-pnpm")?;
    #[cfg(windows)]
    {
        fs::write(
            dir.join("pnpm.cmd"),
            "@echo off\r\ncorepack.cmd pnpm %*\r\n",
        )?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let shim = dir.join("pnpm");
        fs::write(&shim, "#!/bin/sh\nexec corepack pnpm \"$@\"\n")?;
        fs::set_permissions(&shim, fs::Permissions::from_mode(0o755))?;
    }
    Ok(dir)
}
