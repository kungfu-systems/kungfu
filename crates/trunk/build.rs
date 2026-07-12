// SPDX-License-Identifier: Apache-2.0
//
// Build script for kungfu-trunk.
//
// It is a no-op unless the `embedding` feature is on. With the feature, it links
// libkungfu so the trunk can FFI into the embedding membrane (RFC
// framework/core/docs/embedding-contract-face.md D2/D6): the trunk is the
// first-party consumer, compiled against the same core it ships next to. Coreless
// builds — the workspace CI gate, a dev checkout without a built core — keep the
// feature off and link nothing, so the rlib-only members and the frozen-host
// launch surface still build with no core in reach.
//
// Native dir resolution (POSIX): KF_TRUNK_NATIVE_DIR if set, else the product
// build's own output at framework/core/build/<type>. The product ships libkungfu
// next to the trunk binary in dist/kungfu, so an origin-relative rpath resolves
// it at runtime; the native-dir rpath additionally lets an in-place dev or
// verification build load a sibling core directly.

use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=KF_TRUNK_NATIVE_DIR");

    // Only link when the embedding feature is compiled in.
    if env::var_os("CARGO_FEATURE_EMBEDDING").is_none() {
        return;
    }

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "windows" {
        // The core is static on Windows (COFF 65K export limit); the product build
        // links the static libkungfu and re-exports the single C entry (RFC D2
        // Windows note). Wiring that static link + import lib is a product-build
        // follow-up; the feature is POSIX-only until then.
        panic!(
            "kungfu-trunk[embedding]: Windows static-core linking is not wired yet \
             (RFC D2 Windows note); build the embedding feature on macOS/Linux, or \
             land the Windows static-link follow-up first"
        );
    }

    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let build_type = env::var("KF_TRUNK_BUILD_TYPE").unwrap_or_else(|_| "Release".to_string());
    let native_dir = env::var_os("KF_TRUNK_NATIVE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            manifest
                .join("../../framework/core/build")
                .join(&build_type)
        });
    let native_dir = native_dir.canonicalize().unwrap_or_else(|_| {
        panic!(
            "kungfu-trunk[embedding]: native dir {} not found; build framework/core \
             or set KF_TRUNK_NATIVE_DIR to a dir holding libkungfu",
            native_dir.display()
        )
    });

    let native_dir = native_dir.display().to_string();
    println!("cargo:rustc-link-search=native={native_dir}");
    println!("cargo:rustc-link-lib=dylib=kungfu");

    // Runtime resolution: dist/kungfu ships libkungfu next to the trunk binary, so
    // an origin-relative rpath finds it; the native-dir rpath lets an in-place dev
    // build load the sibling core directly.
    let origin = if target_os == "macos" {
        "@loader_path"
    } else {
        "$ORIGIN"
    };
    println!("cargo:rustc-link-arg=-Wl,-rpath,{origin}");
    println!("cargo:rustc-link-arg=-Wl,-rpath,{native_dir}");
}
