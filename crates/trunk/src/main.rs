// SPDX-License-Identifier: Apache-2.0
//
// kungfu-trunk — the product trunk at stage-1 size: the kungfu-owned
// env/package surface plus the lazy pinned-toolchain bootstrap (ADR-0046).
//
// Layering law: this binary owns the `env` semantics, so it parses the `env`
// arguments; the frozen front door forwards the subtree here untouched.
// Failures are named and self-diagnosing (exact URL, expected checksum, the
// mirror override to set) — the wrong-runtime spirit applied to downloads.

mod doctor;
mod envs;
mod launch;
mod pins;

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
  kungfu-trunk --version | --help

envs live under <KF_HOME>/envs; the default env is named 'default'.
";

const DEFAULT_ENV: &str = "default";

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    // Installed as `kungfu`, this binary is the assembled product's front
    // door: the trunk keeps only the subtrees it implements (env, prewarm)
    // and execs the assembled interpreter for everything else, verbatim —
    // argv-transparent per the layering law (ADR-0046 stage 2).
    if launch::invoked_as_kungfu() {
        // doctor is owned by the trunk at the front door on purpose: it is the
        // diagnostic that must run even when the domain runtime is broken, so it
        // never forwards to the assembled interpreter (ADR-0046 driver 1).
        let result = match args.first().map(String::as_str) {
            Some("env") => dispatch_env(&args[1..]),
            Some("prewarm") => envs::prewarm(),
            Some("doctor") => doctor::run(&args[1..]),
            _ => launch::launch(&args),
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
    use super::split_env_flag;

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
}
