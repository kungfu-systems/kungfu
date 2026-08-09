// SPDX-License-Identifier: Apache-2.0
//
// The runtime-pins manifest: the product's single pin surface for the lazy
// toolchain. A KEY=VALUE file (std-only parse, same shape as build-local.env)
// shipped next to the trunk binary; the repo truth is product/runtime-pins.env
// and the dist step copies it verbatim after checking it against .uv-version.
//
// Unlike the dev launcher (env-pinned, checksum optional), the product
// requires a checksum for the current platform: a missing pin is a named
// error, not a silent unverified download.

use std::env;
use std::fs;
use std::path::Path;

#[derive(Debug)]
pub struct Pins {
    pub uv_version: String,
    pub python_pin: String,
    pub uv_sha256: Option<String>,
}

/// Manifest key carrying the uv archive checksum for this host, e.g.
/// `UV_SHA256_MACOS_AARCH64`.
fn sha_key() -> String {
    format!(
        "UV_SHA256_{}_{}",
        env::consts::OS.to_uppercase(),
        env::consts::ARCH.to_uppercase()
    )
}

pub fn load(path: &Path) -> Result<Pins, String> {
    let text = fs::read_to_string(path)
        .map_err(|e| format!("cannot read runtime pins {}: {e}", path.display()))?;
    let mut uv_version = None;
    let mut python_pin = None;
    let mut uv_sha256 = None;
    let want_sha = sha_key();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        match key {
            "UV_VERSION" => uv_version = Some(value.to_string()),
            "PYTHON_PIN" => python_pin = Some(value.to_string()),
            k if k == want_sha => uv_sha256 = Some(value.to_lowercase()),
            _ => {}
        }
    }
    Ok(Pins {
        uv_version: uv_version
            .ok_or_else(|| format!("runtime pins {} carries no UV_VERSION", path.display()))?,
        python_pin: python_pin
            .ok_or_else(|| format!("runtime pins {} carries no PYTHON_PIN", path.display()))?,
        uv_sha256,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pins_and_platform_checksum() {
        let dir = shifu_core::host::unique_temp_dir("trunk-pins-test").unwrap();
        let file = dir.join("runtime-pins.env");
        let sha = "a".repeat(64);
        fs::write(
            &file,
            format!(
                "# comment\nUV_VERSION=0.11.23\nPYTHON_PIN=3.13.14\n{}={sha}\n",
                sha_key()
            ),
        )
        .unwrap();
        let pins = load(&file).unwrap();
        assert_eq!(pins.uv_version, "0.11.23");
        assert_eq!(pins.python_pin, "3.13.14");
        assert_eq!(pins.uv_sha256.as_deref(), Some(sha.as_str()));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_required_keys_are_named() {
        let dir = shifu_core::host::unique_temp_dir("trunk-pins-test2").unwrap();
        let file = dir.join("runtime-pins.env");
        fs::write(&file, "PYTHON_PIN=3.13.14\n").unwrap();
        let err = load(&file).unwrap_err();
        assert!(err.contains("UV_VERSION"), "unexpected error: {err}");
        let _ = fs::remove_dir_all(dir);
    }
}
