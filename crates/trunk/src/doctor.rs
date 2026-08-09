// SPDX-License-Identifier: Apache-2.0
//
// `doctor` — read-only physical inspection of the kungfu runtime through the
// embedding membrane.
//
// This is the trunk's first FFI consumer of the libkungfu embedding C ABI (RFC
// docs/architecture/embedding-contract-face.md): it negotiates the v1 table,
// opens a context on the runtime root, and reports capabilities plus, optionally,
// a bounded journal read probe. It is read-only by construction (RFC D5): the
// wrapper exposes only context/reader/read_batch, so `doctor` cannot write, and
// the diagnostic runs without initializing Python or Node — the wrong-runtime
// spirit applied to diagnosis (KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 driver 1: the front door stays alive when
// the domain runtime is broken).
//
// The FFI path is behind the `embedding` feature so a coreless build still has a
// `doctor` command that explains how to get the real thing.

/// A journal location to probe with a bounded read.
#[derive(Debug, PartialEq, Eq)]
struct ReadTarget {
    namespace: String,
    name: String,
}

const USAGE: &str = "\
usage: kungfu doctor [--read <namespace> <name>]

Read-only inspection of the kungfu runtime through the embedding membrane:
negotiates the C ABI, opens a context on <KF_HOME>, and reports capabilities.
With --read, also reads one journal batch from <namespace>/<name> and reports
frame/payload counts (proving the zero-copy mmap path).";

pub fn run(args: &[String]) -> Result<(), String> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("{USAGE}");
        return Ok(());
    }
    let target = parse_read_target(args)?;
    inspect(target)
}

/// Parse `[--read <namespace> <name>]`. Feature-independent so it is exercised by
/// the default-feature test build; the FFI lives in `inspect`. `--help` is handled
/// upstream in `run` so it exits success.
fn parse_read_target(args: &[String]) -> Result<Option<ReadTarget>, String> {
    let mut it = args.iter();
    let mut target = None;
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--read" => {
                let namespace = it
                    .next()
                    .ok_or("doctor --read needs <namespace> <name>")?
                    .clone();
                let name = it
                    .next()
                    .ok_or("doctor --read needs a <name> after <namespace>")?
                    .clone();
                target = Some(ReadTarget { namespace, name });
            }
            other => return Err(format!("doctor: unknown argument '{other}'\n\n{USAGE}")),
        }
    }
    Ok(target)
}

#[cfg(feature = "embedding")]
fn inspect(target: Option<ReadTarget>) -> Result<(), String> {
    use crate::envs;
    use kungfu_embedding::{Context, ContextConfig, Location, ABI_V1, MAX_BATCH_FRAMES};

    let home = envs::kf_home();
    let root = home
        .to_str()
        .ok_or("the kungfu home path is not valid UTF-8")?;

    let context = Context::open(&ContextConfig::new(root, "kungfu-trunk", "doctor"))
        .map_err(|e| e.to_string())?;

    println!("kungfu doctor — embedding membrane (ABI v{ABI_V1})");
    println!("  root: {root}");

    let advertised = context.advertised_capabilities();
    println!(
        "  advertised: read_journal_batch={} mmap_payload_view={} (0x{:x})",
        advertised.read_journal_batch(),
        advertised.mmap_payload_view(),
        advertised.bits()
    );

    let caps = context.capabilities().map_err(|e| e.to_string())?;
    println!(
        "  context:    read_journal_batch={} mmap_payload_view={} (0x{:x})",
        caps.read_journal_batch(),
        caps.mmap_payload_view(),
        caps.bits()
    );

    if let Some(ReadTarget { namespace, name }) = target {
        let mut reader = context
            .open_reader(&Location::new(&namespace, &name))
            .map_err(|e| e.to_string())?;
        let batch = reader
            .read_batch(MAX_BATCH_FRAMES)
            .map_err(|e| e.to_string())?;
        println!(
            "  read {namespace}/{name}: frames={} payload_bytes={} copied={} zero_copy={}",
            batch.frame_count(),
            batch.payload_bytes(),
            batch.payload_bytes_copied(),
            batch.payload_bytes_copied() == 0
        );
    }

    Ok(())
}

#[cfg(not(feature = "embedding"))]
fn inspect(_target: Option<ReadTarget>) -> Result<(), String> {
    Err(
        "doctor: physical inspection needs the assembled product build — a \
         kungfu-trunk compiled with --features embedding next to libkungfu. The \
         shipped product enables it; a bare dev build does not."
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn no_args_means_no_read_target() {
        assert_eq!(parse_read_target(&[]).unwrap(), None);
    }

    #[test]
    fn read_target_parses_namespace_and_name() {
        let target = parse_read_target(&s(&["--read", "md", "xtp"])).unwrap();
        assert_eq!(
            target,
            Some(ReadTarget {
                namespace: "md".to_string(),
                name: "xtp".to_string(),
            })
        );
    }

    #[test]
    fn read_target_needs_both_operands() {
        assert!(parse_read_target(&s(&["--read", "md"])).is_err());
        assert!(parse_read_target(&s(&["--read"])).is_err());
    }

    #[test]
    fn unknown_argument_is_named() {
        assert!(parse_read_target(&s(&["--bogus"])).is_err());
    }

    #[test]
    fn help_exits_success() {
        // --help is intercepted in run() and must not be an error exit.
        assert!(run(&s(&["--help"])).is_ok());
        assert!(run(&s(&["-h"])).is_ok());
    }
}
