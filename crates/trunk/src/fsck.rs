// SPDX-License-Identifier: Apache-2.0
//
// `fsck` — read-only substrate integrity check of the kungfu storage runtime
// through the embedding membrane.
//
// This is `doctor`'s natural sibling (ADR-0071 Bucket A): it negotiates the v2
// embedding table, opens a context on the runtime root, and runs the C++
// `storage_service::fsck` through the membrane's read-only diagnostic surface.
// The compute is native C++ reused verbatim — no domain logic is rewritten in
// Rust — and it runs without booting CPython, so it survives a broken Python
// runtime, the same reason `doctor` is Rust-native (ADR-0046 driver 1).
//
// The FFI path is behind the `embedding` feature so a coreless build still has an
// `fsck` command that explains how to get the real thing.

/// Parsed `fsck` arguments. Feature-independent so the default-feature test build
/// exercises the parser; the FFI lives in `inspect`.
#[derive(Debug, Default, PartialEq, Eq)]
struct FsckArgs {
    runtime_dir: Option<String>,
    provider: Option<String>,
    provider_config_source: Option<String>,
    source: Option<String>,
    episode: Option<u64>,
    verify_frames: bool,
    json: bool,
}

const USAGE: &str = "\
usage: kungfu fsck [--runtime-dir <dir>] [--provider <name>]
                   [--provider-config-source <src>] [--source <id>]
                   [--episode <id>] [--verify-frames] [--json]

Read-only substrate integrity check of the kungfu storage runtime through the
embedding membrane. Reuses the native C++ storage fsck (no CPython), so it runs
even when the Python runtime is down. Reports an ok/degraded verdict plus the
full JSON report. Scope: --episode implies one episode (needs --source),
--source alone implies one source, otherwise the whole runtime.

Exit status is 0 when the runtime passes, non-zero when checks fail.";

const VERIFY_USAGE: &str = "\
usage: kungfu verify [--runtime-dir <dir>] [--provider <name>]
                     [--provider-config-source <src>] --source <id>
                     --episode <id> [--json]

Deeply verify one episode's attached journal frames through the native storage
fsck authority. This is a read-only, no-CPython operation; --source and
--episode are required so 'verify' cannot silently degrade to a shallow scan.";

pub fn run(args: &[String]) -> Result<(), String> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{USAGE}");
        return Ok(());
    }
    let parsed = parse_args(args)?;
    inspect(parsed, "fsck")
}

pub fn run_verify(args: &[String]) -> Result<(), String> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{VERIFY_USAGE}");
        return Ok(());
    }
    let parsed = parse_verify_args(args)?;
    inspect(parsed, "verify")
}

fn parse_verify_args(args: &[String]) -> Result<FsckArgs, String> {
    let mut parsed = parse_args(args).map_err(|error| error.replacen("fsck", "verify", 1))?;
    if parsed.source.is_none() || parsed.episode.is_none() {
        return Err("verify needs --source <id> and --episode <id>".to_string());
    }
    parsed.verify_frames = true;
    Ok(parsed)
}

fn parse_args(args: &[String]) -> Result<FsckArgs, String> {
    let mut out = FsckArgs::default();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut take = |flag: &str| -> Result<String, String> {
            it.next()
                .cloned()
                .ok_or_else(|| format!("fsck {flag} needs a value"))
        };
        match arg.as_str() {
            "--runtime-dir" => out.runtime_dir = Some(take("--runtime-dir")?),
            "--provider" => out.provider = Some(take("--provider")?),
            "--provider-config-source" => {
                out.provider_config_source = Some(take("--provider-config-source")?);
            }
            "--source" => out.source = Some(take("--source")?),
            "--episode" => {
                let raw = take("--episode")?;
                let id = raw.parse::<u64>().map_err(|_| {
                    format!("fsck --episode needs a non-negative integer, got '{raw}'")
                })?;
                out.episode = Some(id);
            }
            "--verify-frames" => out.verify_frames = true,
            "--json" => out.json = true,
            other => return Err(format!("fsck: unknown argument '{other}'\n\n{USAGE}")),
        }
    }
    if out.episode.is_some() && out.source.is_none() {
        return Err(
            "fsck --episode needs --source <id> to select the episode's source".to_string(),
        );
    }
    Ok(out)
}

#[cfg(feature = "embedding")]
fn inspect(args: FsckArgs, command: &str) -> Result<(), String> {
    use crate::envs;
    use kungfu_embedding::{Context, ContextConfig, StorageFsckRequest, StorageFsckScope, ABI_V2};

    let home = envs::kf_home();
    let runtime_dir = match &args.runtime_dir {
        Some(dir) => dir.clone(),
        None => home
            .to_str()
            .ok_or("the kungfu home path is not valid UTF-8")?
            .to_string(),
    };

    let context = Context::open(&ContextConfig::new(&runtime_dir, "kungfu-trunk", command))
        .map_err(|e| e.to_string())?;

    let scope = if args.episode.is_some() {
        StorageFsckScope::Episode
    } else if args.source.is_some() {
        StorageFsckScope::Source
    } else {
        StorageFsckScope::All
    };

    let mut request = StorageFsckRequest::new(&runtime_dir);
    request.provider = args.provider.as_deref();
    request.provider_config_source = args.provider_config_source.as_deref();
    request.scope = scope;
    request.source_id = args.source.as_deref();
    request.episode_id = args.episode.unwrap_or(0);
    request.verify_frames = args.verify_frames;

    let report = context.storage_fsck(&request).map_err(|e| e.to_string())?;

    if !args.json {
        println!(
            "kungfu {command} — embedding membrane (ABI v{ABI_V2})\n  runtime: {runtime_dir}\n  verdict: ok={} degraded={}",
            report.ok(),
            report.degraded(),
        );
    }
    // The report blob is JSON produced by the native core; emit it verbatim.
    match report.as_str() {
        Ok(json) => println!("{json}"),
        Err(_) => return Err(format!("{command}: report blob was not valid UTF-8")),
    }
    if report.degraded() && report.ok() {
        eprintln!("kungfu: {command}: runtime is degraded (see report)");
    }
    if !report.ok() {
        return Err(format!(
            "{command}: storage integrity checks failed (see report above)"
        ));
    }
    Ok(())
}

#[cfg(not(feature = "embedding"))]
fn inspect(_args: FsckArgs, command: &str) -> Result<(), String> {
    Err(format!(
        "{command}: substrate inspection needs the assembled product build — a \
         kungfu-trunk compiled with --features embedding next to libkungfu. The \
         shipped product enables it; a bare dev build does not."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn no_args_is_all_scope_defaults() {
        let parsed = parse_args(&[]).unwrap();
        assert_eq!(parsed, FsckArgs::default());
        assert!(parsed.runtime_dir.is_none());
        assert!(!parsed.verify_frames);
        assert!(!parsed.json);
    }

    #[test]
    fn parses_all_flags() {
        let parsed = parse_args(&s(&[
            "--runtime-dir",
            "/rt",
            "--provider",
            "rocksdb",
            "--provider-config-source",
            "cfg",
            "--source",
            "md-xtp",
            "--episode",
            "42",
            "--verify-frames",
            "--json",
        ]))
        .unwrap();
        assert_eq!(parsed.runtime_dir.as_deref(), Some("/rt"));
        assert_eq!(parsed.provider.as_deref(), Some("rocksdb"));
        assert_eq!(parsed.provider_config_source.as_deref(), Some("cfg"));
        assert_eq!(parsed.source.as_deref(), Some("md-xtp"));
        assert_eq!(parsed.episode, Some(42));
        assert!(parsed.verify_frames);
        assert!(parsed.json);
    }

    #[test]
    fn episode_requires_source() {
        assert!(parse_args(&s(&["--episode", "1"])).is_err());
        assert!(parse_args(&s(&["--episode", "1", "--source", "s"])).is_ok());
    }

    #[test]
    fn episode_rejects_non_integer() {
        assert!(parse_args(&s(&["--source", "s", "--episode", "x"])).is_err());
    }

    #[test]
    fn missing_flag_value_is_named() {
        assert!(parse_args(&s(&["--runtime-dir"])).is_err());
        assert!(parse_args(&s(&["--source"])).is_err());
    }

    #[test]
    fn unknown_argument_is_named() {
        assert!(parse_args(&s(&["--bogus"])).is_err());
    }

    #[test]
    fn help_exits_success() {
        assert!(run(&s(&["--help"])).is_ok());
        assert!(run(&s(&["-h"])).is_ok());
    }

    #[test]
    fn verify_requires_one_episode_and_forces_deep_check() {
        assert!(parse_verify_args(&s(&["--source", "s"])).is_err());
        assert!(parse_verify_args(&s(&["--episode", "1"])).is_err());
        let parsed = parse_verify_args(&s(&["--source", "s", "--episode", "1"])).unwrap();
        assert!(parsed.verify_frames);
        // A coreless test build reaches the expected assembled-product error only
        // after the verify-specific scope contract has passed.
        let error = run_verify(&s(&["--source", "s", "--episode", "1"])).unwrap_err();
        assert!(error.contains("verify: substrate inspection"));
    }
}
