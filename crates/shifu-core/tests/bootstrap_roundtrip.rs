// SPDX-License-Identifier: Apache-2.0
//
// Second-consumer proof: drive shifu-core's bootstrap the way the product
// trunk will (ADR-0046 stage 1) — build a FetchSpec from its own pin data and
// run the full download -> verify -> cache round trip, plus the checksum
// gate, against a local file:// fixture so no network is involved.
//
// One #[test] on purpose: the cache root is isolated through XDG_CACHE_HOME,
// which is process-global state, so the scenario runs as a single sequential
// story.

use std::fs;
use std::path::Path;
use std::process::Command;

use shifu_core::bootstrap::{fetch, sha256_file, BootstrapErrorKind, FetchSpec};

fn file_url(path: &Path) -> String {
    let p = path.canonicalize().expect("fixture path resolves");
    let s = p.to_string_lossy().to_string();
    if cfg!(windows) {
        format!(
            "file:///{}",
            s.trim_start_matches(r"\\?\").replace('\\', "/")
        )
    } else {
        format!("file://{s}")
    }
}

fn make_archive(dir: &Path, name: &str, binary: &str, content: &[u8]) -> std::path::PathBuf {
    let stage = dir.join(format!("stage-{name}"));
    fs::create_dir_all(&stage).expect("create stage dir");
    fs::write(stage.join(binary), content).expect("write fixture binary");
    let archive = dir.join(name);
    let status = Command::new("tar")
        .arg("-czf")
        .arg(&archive)
        .arg("-C")
        .arg(&stage)
        .arg(binary)
        .status()
        .expect("tar available");
    assert!(status.success(), "tar failed creating the fixture archive");
    archive
}

#[test]
fn pinned_fetch_roundtrip_cache_hit_and_checksum_gate() {
    let scratch = std::env::temp_dir().join(format!("shifu-core-it-{}", std::process::id()));
    let _ = fs::remove_dir_all(&scratch);
    fs::create_dir_all(&scratch).expect("create scratch");
    // Isolate the user-global cache for the whole scenario.
    std::env::set_var("XDG_CACHE_HOME", scratch.join("cache"));

    let binary = if cfg!(windows) {
        "demotool.exe"
    } else {
        "demotool"
    };
    let payload: &[u8] = b"#!/bin/sh\necho demo\n";
    let archive = make_archive(&scratch, "demotool-1.2.3.tar.gz", binary, payload);
    let digest = sha256_file(&archive).expect("host has a sha256 tool");

    // Round trip: download (file://) + verify pinned checksum + extract + cache.
    let spec = FetchSpec {
        tool: "demotool".to_string(),
        version: "1.2.3".to_string(),
        url: file_url(&archive),
        sha256: Some(digest),
        mirror_env: Some("DEMOTOOL_DIST_MIRROR".to_string()),
        binary: None,
    };
    let cached = fetch(&spec).expect("pinned fetch round trip");
    assert_eq!(cached, spec.cached_binary());
    assert!(
        cached.ends_with(Path::new("kungfu/tools/demotool/1.2.3").join(binary)),
        "cache layout: {}",
        cached.display()
    );
    assert_eq!(fs::read(&cached).expect("read cached"), payload);

    // Cache hit: with the source archive gone, resolution still succeeds.
    fs::remove_file(&archive).expect("drop fixture");
    let again = fetch(&spec).expect("cache hit needs no download");
    assert_eq!(cached, again);

    // Checksum gate: a wrong pin fails with the named, self-diagnosing error
    // (fresh version so the cache cannot answer first).
    let archive = make_archive(&scratch, "demotool-1.2.4.tar.gz", binary, payload);
    let bad = FetchSpec {
        tool: "demotool".to_string(),
        version: "1.2.4".to_string(),
        url: file_url(&archive),
        sha256: Some("0".repeat(64)),
        mirror_env: Some("DEMOTOOL_DIST_MIRROR".to_string()),
        binary: None,
    };
    let err = fetch(&bad).expect_err("wrong checksum must fail");
    assert!(matches!(
        err.kind(),
        BootstrapErrorKind::ChecksumMismatch { .. }
    ));
    let report = err.to_string();
    assert!(report.contains(&bad.url), "report names the exact url");
    assert!(report.contains(&"0".repeat(64)), "report names the pin");
    assert!(
        report.contains("DEMOTOOL_DIST_MIRROR"),
        "report names the mirror override"
    );
    assert!(
        !bad.cached_binary().exists(),
        "a failed verification must not populate the cache"
    );

    let _ = fs::remove_dir_all(&scratch);
}
