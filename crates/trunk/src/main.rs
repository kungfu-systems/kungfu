// SPDX-License-Identifier: Apache-2.0
//
// kungfu-trunk — the assembled product's Rust front door: root routing,
// native diagnostics, and the kungfu-owned env/package surface (ADR-0046).
//
// Layering law: this binary parses only the root contract plus commands whose
// semantics it owns. Domain subtrees remain argv-transparent and are parsed by
// their satellite. Failures are named and self-diagnosing.

mod doctor;
mod envs;
mod fsck;
mod help;
mod launch;
mod pins;
mod plans;
mod status;
mod variant;
mod xinfa_command;

use std::env;
use std::process::exit;

const USAGE: &str = "\
kungfu-trunk — kungfu package/env surface (uv underneath, pinned runtime only)

usage:
  kungfu-trunk env create [<name>]             create an env from the blessed interpreter
  kungfu-trunk env add <pkg>... [--env <name>] install packages into an env
  kungfu-trunk env remove <pkg>... [--env <name>]
                                               remove packages from an env
  kungfu-trunk env list                        list envs
  kungfu-trunk env info [<name>]               show an env's pins and paths
  kungfu-trunk env delete <name>               delete an env
  kungfu-trunk env run [--env <name>] [-- <cmd>...]
                                               run a command inside an env (default: python)
  kungfu-trunk prewarm                         pre-fetch the pinned uv + satellite CPython
  kungfu-trunk doctor [--read <ns> <name>]     read-only runtime inspection via the
                                               embedding membrane (product build)
  kungfu-trunk fsck [--runtime-dir <dir>] [--source <id>] [--episode <id>]
                                               read-only storage integrity check via the
                                               embedding membrane (product build)
  kungfu-trunk verify --source <id> --episode <id>
                                               deep episode frame verification
  kungfu-trunk gc-plan [--source <id>]          plan unreachable payload collection
  kungfu-trunk repair-plan [--source <id>] [--episode <id>]
                                               plan storage repair (never writes)
  kungfu-trunk storage-status [--source <id>]  summarize native storage state
  kungfu-trunk xinfa <command> [<args>...]      run the linked Xinfa compiler
  kungfu-trunk --version | --help

envs live under <KF_HOME>/envs; the default env is named 'default'.
";

const DEFAULT_ENV: &str = "default";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeCommand {
    Env,
    Prewarm,
    Doctor,
    Fsck,
    Verify,
    GcPlan,
    RepairPlan,
    StorageStatus,
    Xinfa,
}

struct NativeCommandSpec {
    command: NativeCommand,
    name: &'static str,
    summary: &'static str,
    section: &'static str,
    visibility: &'static str,
}

/// The one source of truth for native top-level command routing and discovery.
/// The unified help renderer consumes this same table and de-duplicates `env`,
/// which remains in Click as a compatibility forwarding surface.
const NATIVE_COMMANDS: &[NativeCommandSpec] = &[
    NativeCommandSpec {
        command: NativeCommand::Env,
        name: "env",
        summary: "manage runtime environments",
        section: "developer",
        visibility: "advanced",
    },
    NativeCommandSpec {
        command: NativeCommand::Prewarm,
        name: "prewarm",
        summary: "pre-fetch the pinned uv + satellite CPython",
        section: "system-maintenance",
        visibility: "advanced",
    },
    NativeCommandSpec {
        command: NativeCommand::Doctor,
        name: "doctor",
        summary: "read-only runtime inspection via the embedding membrane",
        section: "system-maintenance",
        visibility: "advanced",
    },
    NativeCommandSpec {
        command: NativeCommand::Fsck,
        name: "fsck",
        summary: "read-only storage integrity check via the embedding membrane",
        section: "system-maintenance",
        visibility: "advanced",
    },
    NativeCommandSpec {
        command: NativeCommand::Verify,
        name: "verify",
        summary: "deep episode frame verification via the embedding membrane",
        section: "facts-proof",
        visibility: "public",
    },
    NativeCommandSpec {
        command: NativeCommand::GcPlan,
        name: "gc-plan",
        summary: "plan unreachable payload collection without deleting",
        section: "system-maintenance",
        visibility: "advanced",
    },
    NativeCommandSpec {
        command: NativeCommand::RepairPlan,
        name: "repair-plan",
        summary: "plan storage repair without writing",
        section: "system-maintenance",
        visibility: "advanced",
    },
    NativeCommandSpec {
        command: NativeCommand::StorageStatus,
        name: "storage-status",
        summary: "summarize native storage state without CPython",
        section: "system-maintenance",
        visibility: "advanced",
    },
    NativeCommandSpec {
        command: NativeCommand::Xinfa,
        name: "xinfa",
        summary: "compile workspace context into a verified Xinfa Atlas",
        section: "agent-context",
        visibility: "public",
    },
];

#[derive(Debug, PartialEq, Eq)]
struct RootAssignment {
    name: String,
    envvar: String,
    value: String,
}

#[derive(Debug, PartialEq, Eq)]
enum ProductRoute {
    Help,
    Version,
    Native {
        command: NativeCommand,
        args_at: usize,
        globals: Vec<RootAssignment>,
    },
    Launch,
}

fn main() {
    // KUNGFU_AS_VARIANT asks this process to *be* a runtime variant (e.g. node),
    // so it is decided before any subcommand interpretation. When the trunk can
    // own the variant natively (node, without booting CPython) it runs it here and
    // exits; otherwise it falls through to the normal path, where the Python
    // variant table still handles it (ADR-0046 stage 3).
    if let Some(code) = variant::dispatch() {
        exit(code);
    }

    let args: Vec<String> = env::args().skip(1).collect();
    // Installed as `kungfu`, this binary is the assembled product's front
    // door. It parses the generated root contract for routing only, keeps the
    // subtrees it implements, and execs the assembled interpreter for every
    // domain subtree verbatim (ADR-0046 layered CLI law).
    if launch::invoked_as_kungfu() {
        let root_options = help::root_options().unwrap_or_default();
        let route = match route_product(&args, &root_options) {
            Ok(route) => route,
            Err(msg) => {
                eprintln!("kungfu: {msg}");
                exit(2);
            }
        };
        let result = match route {
            ProductRoute::Help => {
                if let Some(text) = help::render(&native_command_help()) {
                    print!("{text}");
                    return;
                }
                launch::launch(&args)
            }
            ProductRoute::Version => {
                println!(
                    "{}",
                    help::version().unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
                );
                return;
            }
            ProductRoute::Native {
                command,
                args_at,
                globals,
            } => {
                apply_root_globals(&globals);
                run_native(command, &args[args_at..])
            }
            ProductRoute::Launch => launch::launch(&args),
        };
        if let Err(msg) = result {
            eprintln!("kungfu: {msg}");
            exit(1);
        }
        return;
    }
    let result = match args.first().map(String::as_str) {
        Some("env") => dispatch_env(&args[1..]),
        Some("prewarm") => envs::prewarm(),
        Some("doctor") => doctor::run(&args[1..]),
        Some("fsck") => fsck::run(&args[1..]),
        Some("verify") => fsck::run_verify(&args[1..]),
        Some("gc-plan") => plans::run_gc(&args[1..]),
        Some("repair-plan") => plans::run_repair(&args[1..]),
        Some("storage-status") => status::run(&args[1..]),
        Some("xinfa") => xinfa_command::run(&args[1..]),
        Some("--version" | "-V" | "version") => {
            println!("kungfu-trunk {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        None | Some("--help" | "-h" | "help") => {
            print!("{USAGE}");
            Ok(())
        }
        Some(other) => {
            eprintln!("kungfu: unknown command '{other}'\n\n{USAGE}");
            exit(2);
        }
    };
    if let Err(msg) = result {
        eprintln!("kungfu: {msg}");
        exit(1);
    }
}

fn native_command_help() -> Vec<help::NativeCommandHelp> {
    NATIVE_COMMANDS
        .iter()
        .map(|spec| help::NativeCommandHelp {
            name: spec.name,
            summary: spec.summary,
            section: spec.section,
            visibility: spec.visibility,
        })
        .collect()
}

fn find_native(name: &str) -> Option<NativeCommand> {
    NATIVE_COMMANDS
        .iter()
        .find(|spec| spec.name == name)
        .map(|spec| spec.command)
}

fn run_native(command: NativeCommand, args: &[String]) -> Result<(), String> {
    match command {
        NativeCommand::Env => dispatch_env(args),
        NativeCommand::Prewarm => envs::prewarm(),
        NativeCommand::Doctor => doctor::run(args),
        NativeCommand::Fsck => fsck::run(args),
        NativeCommand::Verify => fsck::run_verify(args),
        NativeCommand::GcPlan => plans::run_gc(args),
        NativeCommand::RepairPlan => plans::run_repair(args),
        NativeCommand::StorageStatus => status::run(args),
        NativeCommand::Xinfa => xinfa_command::run(args),
    }
}

/// Classify only the generated root option prefix. Once a command token is
/// reached, domain argv is never inspected. Unknown root options deliberately
/// route to Click, which remains the authority for its own diagnostics.
fn route_product(
    args: &[String],
    root_options: &[help::RootOption],
) -> Result<ProductRoute, String> {
    if args.is_empty() {
        return Ok(ProductRoute::Help);
    }

    let mut globals = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if matches!(arg.as_str(), "--help" | "-h" | "help") {
            return Ok(ProductRoute::Help);
        }
        if arg == "--version" {
            return Ok(ProductRoute::Version);
        }
        if arg == "--" {
            return Ok(ProductRoute::Launch);
        }
        if let Some(command) = find_native(arg) {
            return Ok(ProductRoute::Native {
                command,
                args_at: index + 1,
                globals,
            });
        }

        let Some((option, inline_value)) = match_root_option(arg, root_options) else {
            return Ok(ProductRoute::Launch);
        };
        if option.name == "help" {
            return Ok(ProductRoute::Help);
        }
        if matches!(
            option.name.as_str(),
            "help_all" | "help_section" | "help_json"
        ) {
            return Ok(ProductRoute::Launch);
        }
        if option.name == "version" {
            return Ok(ProductRoute::Version);
        }
        if option.arity > 1 {
            return Err(format!(
                "root option '{}' has unsupported arity {}; rebuild the trunk contract",
                option.name, option.arity
            ));
        }

        let value = if option.arity == 0 {
            option.envvar.clone().unwrap_or_else(|| "1".to_string())
        } else if let Some(value) = inline_value {
            value
        } else {
            index += 1;
            args.get(index)
                .cloned()
                .ok_or_else(|| format!("root option '{arg}' needs a value"))?
        };
        if !option.choices.is_empty() && !option.choices.iter().any(|choice| choice == &value) {
            return Err(format!(
                "invalid value '{value}' for root option '{arg}'; expected one of: {}",
                option.choices.join(", ")
            ));
        }
        if let Some(envvar) = &option.envvar {
            globals.push(RootAssignment {
                name: option.name.clone(),
                envvar: envvar.clone(),
                value,
            });
        }
        index += 1;
    }

    Ok(ProductRoute::Help)
}

fn match_root_option<'a>(
    arg: &str,
    root_options: &'a [help::RootOption],
) -> Option<(&'a help::RootOption, Option<String>)> {
    for option in root_options {
        for flag in &option.flags {
            if arg == flag {
                return Some((option, None));
            }
            if option.arity == 1 && flag.starts_with("--") {
                if let Some(value) = arg.strip_prefix(&format!("{flag}=")) {
                    return Some((option, Some(value.to_string())));
                }
            }
            if option.arity == 1
                && flag.starts_with('-')
                && !flag.starts_with("--")
                && arg.starts_with(flag)
                && arg.len() > flag.len()
            {
                return Some((option, Some(arg[flag.len()..].to_string())));
            }
        }
    }
    None
}

fn apply_root_globals(globals: &[RootAssignment]) {
    for assignment in globals {
        // Click gives an explicit --home precedence over an inherited
        // KF_RUNTIME_DIR. Preserve that exact root contract for native tools.
        if assignment.name == "home" {
            env::remove_var("KF_RUNTIME_DIR");
        }
        env::set_var(&assignment.envvar, &assignment.value);
    }
}

fn dispatch_env(args: &[String]) -> Result<(), String> {
    let (verb, rest) = match args.split_first() {
        Some((v, r)) => (v.as_str(), r),
        None => {
            print!("{USAGE}");
            return Ok(());
        }
    };
    match verb {
        "create" => envs::create(rest.first().map(String::as_str).unwrap_or(DEFAULT_ENV)),
        "add" => {
            let (name, packages) = split_env_flag(rest)?;
            envs::add(&name, &packages)
        }
        "remove" => {
            let (name, packages) = split_env_flag(rest)?;
            envs::remove(&name, &packages)
        }
        "list" => envs::list(),
        "info" => envs::info(rest.first().map(String::as_str).unwrap_or(DEFAULT_ENV)),
        "delete" => match rest.first() {
            Some(name) => envs::delete(name),
            None => Err("env delete needs an explicit name".to_string()),
        },
        "run" => {
            let (name, command) = split_env_flag(rest)?;
            envs::run(&name, &command)
        }
        other => Err(format!("unknown env command '{other}'\n\n{USAGE}")),
    }
}

/// Extract `--env <name>` from an argument list; everything else (minus a
/// bare `--` separator) passes through in order. Default env: 'default'.
fn split_env_flag(args: &[String]) -> Result<(String, Vec<String>), String> {
    let mut name = DEFAULT_ENV.to_string();
    let mut rest = Vec::new();
    let mut it = args.iter().peekable();
    let mut passthrough = false;
    while let Some(arg) = it.next() {
        if passthrough {
            rest.push(arg.clone());
            continue;
        }
        match arg.as_str() {
            "--" => passthrough = true,
            "--env" => match it.next() {
                Some(v) => name = v.clone(),
                None => return Err("--env needs a value".to_string()),
            },
            _ => rest.push(arg.clone()),
        }
    }
    Ok((name, rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn env_flag_extracts_and_defaults() {
        let (name, rest) = split_env_flag(&s(&["torch", "--env", "research"])).unwrap();
        assert_eq!(name, "research");
        assert_eq!(rest, s(&["torch"]));
        let (name, rest) = split_env_flag(&s(&["torch", "pandas"])).unwrap();
        assert_eq!(name, "default");
        assert_eq!(rest, s(&["torch", "pandas"]));
    }

    #[test]
    fn double_dash_stops_flag_parsing() {
        let (name, rest) =
            split_env_flag(&s(&["--env", "research", "--", "python", "--env", "x"])).unwrap();
        assert_eq!(name, "research");
        assert_eq!(rest, s(&["python", "--env", "x"]));
    }

    #[test]
    fn missing_env_value_is_named() {
        assert!(split_env_flag(&s(&["--env"])).is_err());
    }

    fn root_options() -> Vec<help::RootOption> {
        vec![
            help::RootOption {
                name: "home".to_string(),
                arity: 1,
                envvar: Some("KF_HOME".to_string()),
                flags: vec!["-H".to_string(), "--home".to_string()],
                choices: vec![],
            },
            help::RootOption {
                name: "log_level".to_string(),
                arity: 1,
                envvar: Some("KF_LOG_LEVEL".to_string()),
                flags: vec!["-l".to_string(), "--log_level".to_string()],
                choices: vec![
                    "trace".to_string(),
                    "debug".to_string(),
                    "info".to_string(),
                    "warning".to_string(),
                    "error".to_string(),
                    "critical".to_string(),
                ],
            },
            help::RootOption {
                name: "env_verify_location".to_string(),
                arity: 0,
                envvar: Some("KF_VERIFY_LOCATION".to_string()),
                flags: vec!["-ENV-verify-location".to_string()],
                choices: vec![],
            },
            help::RootOption {
                name: "help_all".to_string(),
                arity: 0,
                envvar: None,
                flags: vec!["--help-all".to_string()],
                choices: vec![],
            },
            help::RootOption {
                name: "help_section".to_string(),
                arity: 1,
                envvar: None,
                flags: vec!["--help-section".to_string()],
                choices: vec![],
            },
            help::RootOption {
                name: "help_json".to_string(),
                arity: 0,
                envvar: None,
                flags: vec!["--help-json".to_string()],
                choices: vec![],
            },
        ]
    }

    #[test]
    fn native_commands_route_after_generated_root_options() {
        let route = route_product(
            &s(&[
                "--home=/tmp/kf",
                "-ldebug",
                "-ENV-verify-location",
                "fsck",
                "--json",
            ]),
            &root_options(),
        )
        .unwrap();
        assert_eq!(
            route,
            ProductRoute::Native {
                command: NativeCommand::Fsck,
                args_at: 4,
                globals: vec![
                    RootAssignment {
                        name: "home".to_string(),
                        envvar: "KF_HOME".to_string(),
                        value: "/tmp/kf".to_string(),
                    },
                    RootAssignment {
                        name: "log_level".to_string(),
                        envvar: "KF_LOG_LEVEL".to_string(),
                        value: "debug".to_string(),
                    },
                    RootAssignment {
                        name: "env_verify_location".to_string(),
                        envvar: "KF_VERIFY_LOCATION".to_string(),
                        value: "KF_VERIFY_LOCATION".to_string(),
                    },
                ],
            }
        );
    }

    #[test]
    fn every_stage_two_diagnostic_routes_from_the_native_table() {
        for (name, command) in [
            ("verify", NativeCommand::Verify),
            ("gc-plan", NativeCommand::GcPlan),
            ("repair-plan", NativeCommand::RepairPlan),
            ("storage-status", NativeCommand::StorageStatus),
        ] {
            assert_eq!(
                route_product(&s(&["--home", "/tmp/kf", name, "--json"]), &root_options()).unwrap(),
                ProductRoute::Native {
                    command,
                    args_at: 3,
                    globals: vec![RootAssignment {
                        name: "home".to_string(),
                        envvar: "KF_HOME".to_string(),
                        value: "/tmp/kf".to_string(),
                    }],
                }
            );
        }
    }

    #[test]
    fn domain_subtrees_remain_opaque() {
        assert_eq!(
            route_product(
                &s(&["-H", "/tmp/kf", "trace", "--home", "domain"]),
                &root_options()
            )
            .unwrap(),
            ProductRoute::Launch
        );
        assert_eq!(
            route_product(&s(&["--unknown", "fsck"]), &root_options()).unwrap(),
            ProductRoute::Launch
        );
    }

    #[test]
    fn root_help_and_version_are_trunk_owned() {
        assert_eq!(
            route_product(&s(&["-H", "/tmp/kf", "--version"]), &root_options()).unwrap(),
            ProductRoute::Version
        );
        assert_eq!(
            route_product(&s(&["-H", "/tmp/kf", "--help"]), &root_options()).unwrap(),
            ProductRoute::Help
        );
    }

    #[test]
    fn explicit_progressive_help_expansion_routes_to_the_offline_python_projection() {
        for args in [
            s(&["--help-all"]),
            s(&["--help-section", "action-model"]),
            s(&["--help-json"]),
        ] {
            assert_eq!(
                route_product(&args, &root_options()).unwrap(),
                ProductRoute::Launch
            );
        }
    }

    #[test]
    fn missing_root_value_is_named() {
        let error = route_product(&s(&["--home"]), &root_options()).unwrap_err();
        assert!(error.contains("--home"));
        assert!(error.contains("needs a value"));
    }

    #[test]
    fn generated_root_choice_is_enforced() {
        let error =
            route_product(&s(&["--log_level", "loud", "fsck"]), &root_options()).unwrap_err();
        assert!(error.contains("invalid value 'loud'"));
        assert!(error.contains("trace, debug, info, warning, error, critical"));
    }

    #[test]
    fn native_command_table_is_unique_and_complete() {
        let mut names: Vec<_> = NATIVE_COMMANDS.iter().map(|spec| spec.name).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), NATIVE_COMMANDS.len());
        assert_eq!(
            names,
            vec![
                "doctor",
                "env",
                "fsck",
                "gc-plan",
                "prewarm",
                "repair-plan",
                "storage-status",
                "verify",
                "xinfa",
            ]
        );
    }
}
