// SPDX-License-Identifier: Apache-2.0
//
// Build script for kungfu-trunk.
//
// It is a no-op unless the `embedding` feature is on. With the feature, it links
// libkungfu so the trunk can FFI into the embedding membrane (RFC
// docs/architecture/embedding-contract-face.md D2/D6): the trunk is the
// first-party consumer, compiled against the same core it ships next to. Coreless
// builds — the workspace CI gate, a dev checkout without a built core — keep the
// feature off and link nothing, so the rlib-only members and the frozen-host
// launch surface still build with no core in reach.
//
// Native dir resolution: KF_TRUNK_NATIVE_DIR if set, else the product build's own
// output. On POSIX that is framework/core/build/<type> (where libkungfu.* lands);
// on Windows it is the build root framework/core/build (where kungfu_embedding.lib
// and the static kungfu.lib/yijinjing.lib land — MSVC archives colocate at the
// root, not under a <type> subdir).
//
// What the trunk links differs by platform (ADR-0046 stage 3):
//   POSIX   — the SHARED libkungfu exports kungfu_embedding_get_api directly, so
//             link `dylib=kungfu`; the product ships libkungfu next to the trunk
//             binary in dist/kungfu, resolved by an origin-relative rpath.
//   Windows — the core is STATIC and unexported (COFF 65K export limit), so link
//             the single-export import lib `kungfu_embedding` (Phase B2); the
//             product ships kungfu_embedding.dll next to the exe, resolved from
//             the exe directory (Windows' default DLL search — no rpath).

use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=KF_TRUNK_NATIVE_DIR");

    // Only link when the embedding feature is compiled in.
    if env::var_os("CARGO_FEATURE_EMBEDDING").is_none() {
        return;
    }

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let is_windows = target_os == "windows";

    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let build_type = env::var("KF_TRUNK_BUILD_TYPE").unwrap_or_else(|_| "Release".to_string());
    let native_dir = env::var_os("KF_TRUNK_NATIVE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let build = manifest.join("../../framework/core/build");
            // Windows archives sit at the build root; POSIX under build/<type>.
            if is_windows {
                build
            } else {
                build.join(&build_type)
            }
        });
    let native_dir = native_dir.canonicalize().unwrap_or_else(|_| {
        let lib = if is_windows {
            "kungfu_embedding.lib"
        } else {
            "libkungfu"
        };
        panic!(
            "kungfu-trunk[embedding]: native dir {} not found; build framework/core \
             or set KF_TRUNK_NATIVE_DIR to a dir holding {lib}",
            native_dir.display()
        )
    });

    let native_dir = native_dir.display().to_string();
    println!("cargo:rustc-link-search=native={native_dir}");

    if is_windows {
        // The single-export DLL's import lib; kungfu_embedding.dll ships next to the
        // exe and is found via the default DLL search path, so no rpath.
        println!("cargo:rustc-link-lib=dylib=kungfu_embedding");
        return;
    }

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
