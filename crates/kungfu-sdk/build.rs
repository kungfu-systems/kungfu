// SPDX-License-Identifier: Apache-2.0

use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=KUNGFU_NATIVE_DIR");
    if env::var_os("CARGO_FEATURE_LINK_NATIVE").is_none() {
        return;
    }

    let native_dir = env::var_os("KUNGFU_NATIVE_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .unwrap_or_else(|| {
            panic!(
                "feature 'link-native' requires KUNGFU_NATIVE_DIR to name the directory containing libkungfu"
            )
        });
    println!("cargo:rustc-link-search=native={}", native_dir.display());
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-lib=static=kungfu");
    } else {
        println!("cargo:rustc-link-lib=dylib=kungfu");
    }
}
