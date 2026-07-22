// SPDX-License-Identifier: Apache-2.0
//
// ADR-0071 v4 plan-only maintenance commands. No mutating switch exists here:
// the Rust surface and C ABI both make gc-plan / repair-plan structurally dry-run.

#[derive(Debug, Default, PartialEq, Eq)]
struct PlanArgs {
    runtime_dir: Option<String>,
    provider: Option<String>,
    provider_config_source: Option<String>,
    source: Option<String>,
    episode: Option<u64>,
    verify_frames: bool,
    json: bool,
}

const GC_USAGE: &str = "\
usage: kungfu gc-plan [--runtime-dir <dir>] [--provider <name>]
                      [--source <id>] [--json]

Plan unreachable-payload garbage collection without deleting anything. Source
scope is conservative because the interim payload store is shared.";

const REPAIR_USAGE: &str = "\
usage: kungfu repair-plan [--runtime-dir <dir>] [--provider <name>]
                          [--provider-config-source <src>] [--source <id>]
                          [--episode <id>] [--verify-frames] [--json]

Produce a read-only repair plan from the native storage authority. Episode scope
requires --source; no fetch, apply, execute, or write mode crosses this command.";

pub fn run_gc(args: &[String]) -> Result<(), String> {
    if wants_help(args) {
        println!("{GC_USAGE}");
        return Ok(());
    }
    let parsed = parse(args, "gc-plan", false)?;
    if parsed.episode.is_some() || parsed.provider_config_source.is_some() || parsed.verify_frames {
        return Err(format!("gc-plan: unsupported scope option\n\n{GC_USAGE}"));
    }
    inspect_gc(parsed)
}

pub fn run_repair(args: &[String]) -> Result<(), String> {
    if wants_help(args) {
        println!("{REPAIR_USAGE}");
        return Ok(());
    }
    inspect_repair(parse(args, "repair-plan", true)?)
}

fn wants_help(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--help" || arg == "-h")
}

fn parse(args: &[String], command: &str, allow_episode: bool) -> Result<PlanArgs, String> {
    let mut out = PlanArgs::default();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut take = |flag: &str| -> Result<String, String> {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{command} {flag} needs a value"))
        };
        match arg.as_str() {
            "--runtime-dir" => out.runtime_dir = Some(take("--runtime-dir")?),
            "--provider" => out.provider = Some(take("--provider")?),
            "--provider-config-source" => {
                out.provider_config_source = Some(take("--provider-config-source")?)
            }
            "--source" => out.source = Some(take("--source")?),
            "--episode" if allow_episode => {
                let raw = take("--episode")?;
                out.episode = Some(raw.parse().map_err(|_| {
                    format!("{command} --episode needs a non-negative integer, got '{raw}'")
                })?);
            }
            "--verify-frames" if allow_episode => out.verify_frames = true,
            "--json" => out.json = true,
            other => return Err(format!("{command}: unknown argument '{other}'")),
        }
    }
    if out.episode.is_some() && out.source.is_none() {
        return Err(format!("{command} --episode needs --source <id>"));
    }
    if out.verify_frames && out.episode.is_none() {
        return Err(format!("{command} --verify-frames needs --episode <id>"));
    }
    Ok(out)
}

#[cfg(feature = "embedding")]
fn runtime_dir(args: &PlanArgs) -> Result<String, String> {
    match &args.runtime_dir {
        Some(dir) => Ok(dir.clone()),
        None => crate::envs::kf_home()
            .to_str()
            .map(str::to_string)
            .ok_or_else(|| "the kungfu home path is not valid UTF-8".to_string()),
    }
}

#[cfg(feature = "embedding")]
fn inspect_gc(args: PlanArgs) -> Result<(), String> {
    use kungfu_embedding::{Context, ContextConfig, StorageGcPlanRequest, ABI_V4};

    let root = runtime_dir(&args)?;
    let context = Context::open(&ContextConfig::new(&root, "kungfu-trunk", "gc-plan"))
        .map_err(|error| error.to_string())?;
    let mut request = StorageGcPlanRequest::new(&root);
    request.provider = args.provider.as_deref();
    request.source_id = args.source.as_deref();
    let report = context
        .storage_gc_plan(&request)
        .map_err(|error| error.to_string())?;
    emit("gc-plan", ABI_V4, &root, args.json, &report)
}

#[cfg(not(feature = "embedding"))]
fn inspect_gc(_args: PlanArgs) -> Result<(), String> {
    coreless("gc-plan")
}

#[cfg(feature = "embedding")]
fn inspect_repair(args: PlanArgs) -> Result<(), String> {
    use kungfu_embedding::{Context, ContextConfig, StorageFsckRequest, StorageFsckScope, ABI_V4};

    let root = runtime_dir(&args)?;
    let context = Context::open(&ContextConfig::new(&root, "kungfu-trunk", "repair-plan"))
        .map_err(|error| error.to_string())?;
    let mut request = StorageFsckRequest::new(&root);
    request.provider = args.provider.as_deref();
    request.provider_config_source = args.provider_config_source.as_deref();
    request.scope = if args.episode.is_some() {
        StorageFsckScope::Episode
    } else if args.source.is_some() {
        StorageFsckScope::Source
    } else {
        StorageFsckScope::All
    };
    request.source_id = args.source.as_deref();
    request.episode_id = args.episode.unwrap_or(0);
    request.verify_frames = args.verify_frames;
    let report = context
        .storage_repair_plan(&request)
        .map_err(|error| error.to_string())?;
    emit("repair-plan", ABI_V4, &root, args.json, &report)
}

#[cfg(not(feature = "embedding"))]
fn inspect_repair(_args: PlanArgs) -> Result<(), String> {
    coreless("repair-plan")
}

#[cfg(feature = "embedding")]
fn emit(
    command: &str,
    abi: u32,
    root: &str,
    json_only: bool,
    report: &kungfu_embedding::FsckReport,
) -> Result<(), String> {
    if !json_only {
        println!(
            "kungfu {command} — embedding membrane (ABI v{abi})\n  runtime: {root}\n  verdict: ok={} degraded={}",
            report.ok(),
            report.degraded()
        );
    }
    println!(
        "{}",
        report
            .as_str()
            .map_err(|_| format!("{command}: report blob was not valid UTF-8"))?
    );
    if !report.ok() {
        return Err(format!("{command}: native plan failed (see report above)"));
    }
    Ok(())
}

#[cfg(not(feature = "embedding"))]
fn coreless(command: &str) -> Result<(), String> {
    Err(format!(
        "{command}: maintenance planning needs the assembled product build — a \
         kungfu-trunk compiled with --features embedding next to libkungfu"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn gc_parser_is_plan_only() {
        let parsed = parse(
            &s(&["--source", "s", "--provider", "rocksdb"]),
            "gc-plan",
            false,
        )
        .unwrap();
        assert_eq!(parsed.source.as_deref(), Some("s"));
        assert_eq!(parsed.provider.as_deref(), Some("rocksdb"));
        assert!(run_gc(&s(&["--execute"])).is_err());
        assert!(run_gc(&s(&["--episode", "1"])).is_err());
    }

    #[test]
    fn repair_episode_and_verify_require_their_parent_scope() {
        assert!(parse(&s(&["--episode", "1"]), "repair-plan", true).is_err());
        assert!(parse(&s(&["--verify-frames"]), "repair-plan", true).is_err());
        assert!(parse(
            &s(&["--source", "s", "--episode", "1", "--verify-frames"]),
            "repair-plan",
            true
        )
        .is_ok());
    }

    #[test]
    fn help_is_available_without_the_core() {
        assert!(run_gc(&s(&["--help"])).is_ok());
        assert!(run_repair(&s(&["-h"])).is_ok());
    }
}
