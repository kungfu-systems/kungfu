// SPDX-License-Identifier: Apache-2.0
//
// ADR-0071 v5 read-only storage status. The command is intentionally named
// `storage-status`: it exposes the existing native storage authority without
// claiming a generic product-wide `status` namespace.

#[derive(Debug, Default, PartialEq, Eq)]
struct StatusArgs {
    runtime_dir: Option<String>,
    provider: Option<String>,
    provider_config_source: Option<String>,
    source: Option<String>,
    json: bool,
}

const USAGE: &str = "\
usage: kungfu storage-status [--runtime-dir <dir>] [--provider <name>]
                             [--provider-config-source <src>] [--source <id>]
                             [--json]

Summarize native storage state without booting CPython. With no --source the
whole runtime is inspected; this command has no mutation or Atlas-status mode.";

#[cfg(feature = "embedding")]
struct TemporaryContextRoot {
    path: std::path::PathBuf,
}

#[cfg(feature = "embedding")]
impl TemporaryContextRoot {
    fn create() -> Result<Self, String> {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("storage-status: system clock error: {error}"))?
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "kungfu-trunk-storage-status-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir(&path).map_err(|error| {
            format!("storage-status: cannot create temporary embedding context: {error}")
        })?;
        Ok(Self { path })
    }

    fn as_str(&self) -> Result<&str, String> {
        self.path
            .to_str()
            .ok_or_else(|| "storage-status: temporary path is not valid UTF-8".to_string())
    }
}

#[cfg(feature = "embedding")]
impl Drop for TemporaryContextRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

pub fn run(args: &[String]) -> Result<(), String> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{USAGE}");
        return Ok(());
    }
    inspect(parse(args)?)
}

fn parse(args: &[String]) -> Result<StatusArgs, String> {
    let mut out = StatusArgs::default();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut take = |flag: &str| -> Result<String, String> {
            it.next()
                .cloned()
                .ok_or_else(|| format!("storage-status {flag} needs a value"))
        };
        match arg.as_str() {
            "--runtime-dir" => out.runtime_dir = Some(take("--runtime-dir")?),
            "--provider" => out.provider = Some(take("--provider")?),
            "--provider-config-source" => {
                out.provider_config_source = Some(take("--provider-config-source")?)
            }
            "--source" => out.source = Some(take("--source")?),
            "--json" => out.json = true,
            other => return Err(format!("storage-status: unknown argument '{other}'")),
        }
    }
    Ok(out)
}

#[cfg(feature = "embedding")]
fn inspect(args: StatusArgs) -> Result<(), String> {
    use kungfu_embedding::{Context, ContextConfig, StorageStatusRequest, ABI_V5};

    let root = match &args.runtime_dir {
        Some(dir) => dir.clone(),
        None => crate::envs::kf_home()
            .to_str()
            .map(str::to_string)
            .ok_or_else(|| "the kungfu home path is not valid UTF-8".to_string())?,
    };
    // Context lifecycle logging belongs to an ephemeral host root. The target
    // runtime remains the request's read-only storage root.
    let context_root = TemporaryContextRoot::create()?;
    let context = Context::open(&ContextConfig::new(
        context_root.as_str()?,
        "kungfu-trunk",
        "storage-status",
    ))
    .map_err(|error| error.to_string())?;
    let mut request = StorageStatusRequest::new(&root);
    request.provider = args.provider.as_deref();
    request.provider_config_source = args.provider_config_source.as_deref();
    request.source_id = args.source.as_deref();
    let report = context
        .storage_status(&request)
        .map_err(|error| error.to_string())?;
    if !args.json {
        let scope = args
            .source
            .as_deref()
            .map(|source| format!("source:{source}"))
            .unwrap_or_else(|| "all".to_string());
        println!(
            "kungfu storage-status — embedding membrane (ABI v{ABI_V5})\n  runtime: {root}\n  scope: {scope}\n  verdict: ok={}",
            report.ok()
        );
    }
    println!(
        "{}",
        report
            .as_str()
            .map_err(|_| "storage-status: report blob was not valid UTF-8".to_string())?
    );
    if !report.ok() {
        return Err("storage-status: native status failed (see report above)".to_string());
    }
    Ok(())
}

#[cfg(not(feature = "embedding"))]
fn inspect(_args: StatusArgs) -> Result<(), String> {
    Err(
        "storage-status: native status needs the assembled product build — a \
         kungfu-trunk compiled with --features embedding next to libkungfu"
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn parser_accepts_only_read_only_status_scope() {
        let parsed = parse(&s(&[
            "--runtime-dir",
            "/rt",
            "--provider",
            "rocksdb",
            "--provider-config-source",
            "explicit",
            "--source",
            "alpha",
            "--json",
        ]))
        .unwrap();
        assert_eq!(parsed.runtime_dir.as_deref(), Some("/rt"));
        assert_eq!(parsed.provider.as_deref(), Some("rocksdb"));
        assert_eq!(parsed.provider_config_source.as_deref(), Some("explicit"));
        assert_eq!(parsed.source.as_deref(), Some("alpha"));
        assert!(parsed.json);
        assert!(parse(&s(&["--scope", "atlas"])).is_err());
        assert!(parse(&s(&["--execute"])).is_err());
    }

    #[test]
    fn missing_value_is_named() {
        let error = parse(&s(&["--source"])).unwrap_err();
        assert!(error.contains("--source"));
        assert!(error.contains("needs a value"));
    }

    #[test]
    fn help_is_available_without_the_core() {
        assert!(run(&s(&["--help"])).is_ok());
    }
}
