use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use crate::command::{self, Command, Operation};
use crate::{
    canonicalize_project_bytes_with_validity, compile_episode_successor_bytes, compile_gui_view,
    compile_human_view, compile_project_bytes_with_validity, compile_repository_atlas_bytes,
    compile_repository_pack_bytes, compile_task_chart, diff_atlases, expand_projection,
    impact_between, impact_from_atlas, import_context_pack, inspect_atlas, inspect_pack,
    inspect_projection, materialize_surface_inventory_bytes, pack_value, resolve_route_bytes,
    validate_project_bytes_with_validity, verify_atlas, verify_pack, verify_projection,
    write_atlas_directory, write_pack_directory,
};

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn json_string(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            control if control.is_control() => {
                output.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => output.push(other),
        }
    }
    output.push('"');
    output
}

fn configured_path(key: &str, fallback: PathBuf) -> (PathBuf, &'static str) {
    match env::var_os(key) {
        Some(value) if !value.is_empty() => (PathBuf::from(value), "environment"),
        _ => (fallback, "workspace"),
    }
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn diagnose() -> Result<String, String> {
    let current_dir = env::current_dir().map_err(|error| format!("cannot resolve cwd: {error}"))?;
    let (state_home, state_source) =
        configured_path("XINFA_STATE_HOME", current_dir.join(".xinfa"));
    let (cache_home, cache_source) = configured_path("XINFA_CACHE_HOME", state_home.join("cache"));
    Ok(format!(
        "{{\"schema\":\"xinfa.diagnostic/v1\",\"product\":\"xinfa\",\"version\":{},\"stateHome\":{},\"stateSource\":{},\"cacheHome\":{},\"cacheSource\":{},\"writesState\":false}}",
        json_string(VERSION),
        json_string(&display_path(&state_home)),
        json_string(state_source),
        json_string(&display_path(&cache_home)),
        json_string(cache_source),
    ))
}
pub(crate) fn usage() -> &'static str {
    crate::CLI_USAGE
}

fn project_argument(arguments: &[String]) -> Result<&str, String> {
    match arguments {
        [project, reference, format] if project == "--project" && format == "--json" => {
            Ok(reference)
        }
        _ => Err(format!("expected --project FILE|- --json\n{}", usage())),
    }
}

fn read_project(reference: &str) -> Result<Vec<u8>, String> {
    if reference == "-" {
        use std::io::Read;
        let mut bytes = Vec::new();
        std::io::stdin()
            .read_to_end(&mut bytes)
            .map_err(|error| format!("cannot read project from stdin: {error}"))?;
        Ok(bytes)
    } else {
        fs::read(reference).map_err(|error| format!("cannot read project {reference}: {error}"))
    }
}

fn keyed_arguments(
    arguments: &[String],
    allowed: &[&str],
) -> Result<BTreeMap<String, String>, String> {
    command::keyed_options(arguments, allowed, usage())
}

fn required<'a>(arguments: &'a BTreeMap<String, String>, key: &str) -> Result<&'a str, String> {
    command::required(arguments, key)
}

fn positive_usize(arguments: &BTreeMap<String, String>, key: &str) -> Result<usize, String> {
    command::positive_usize(arguments, key)
}

fn repository_root(project: &str, explicit: Option<&String>) -> Result<PathBuf, String> {
    if let Some(root) = explicit {
        return Ok(PathBuf::from(root));
    }
    if project == "-" {
        return Err("repository pack compilation from stdin requires --root".to_owned());
    }
    Ok(Path::new(project)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf())
}

pub fn run(arguments: &[String]) -> Result<ExitCode, String> {
    match command::parse(arguments) {
        Command::Version => {
            println!("xinfa {VERSION}");
            Ok(ExitCode::SUCCESS)
        }
        Command::Contract => {
            print!("{}", command::PRODUCT_CONTRACT);
            Ok(ExitCode::SUCCESS)
        }
        Command::Invoke(Operation::ProjectMaterialize, rest) => {
            let arguments = keyed_arguments(rest, &["--inventory"])?;
            let reference = required(&arguments, "--inventory")?;
            let bytes = read_project(reference)?;
            print!(
                "{}",
                materialize_surface_inventory_bytes(&bytes, reference)?
            );
            Ok(ExitCode::SUCCESS)
        }
        Command::Schema(name) => {
            let schema = command::schema(name)
                .ok_or_else(|| format!("unsupported arguments\n{}", usage()))?;
            print!("{schema}");
            Ok(ExitCode::SUCCESS)
        }
        Command::Invoke(Operation::EpisodeCompile, rest) => {
            let arguments = keyed_arguments(
                rest,
                &[
                    "--before",
                    "--project",
                    "--submission",
                    "--output",
                    "--root",
                ],
            )?;
            let project = required(&arguments, "--project")?;
            if project == "-" {
                return Err("Episode compilation requires a repository project file".to_owned());
            }
            let root = repository_root(project, arguments.get("--root"))?;
            let submission = required(&arguments, "--submission")?;
            let project_bytes = read_project(project)?;
            let submission_bytes = fs::read(root.join(submission))
                .map_err(|error| format!("cannot read Episode submission {submission}: {error}"))?;
            let artifacts = compile_episode_successor_bytes(
                &project_bytes,
                project,
                &submission_bytes,
                submission,
                &root,
                "public",
                Path::new(required(&arguments, "--before")?),
            )?;
            write_atlas_directory(
                Path::new(required(&arguments, "--output")?),
                &artifacts.atlas,
            )?;
            print!("{}", artifacts.receipt);
            Ok(ExitCode::SUCCESS)
        }
        Command::Invoke(Operation::AtlasCompile, rest) => {
            let arguments = keyed_arguments(
                rest,
                &["--project", "--pack", "--output", "--root", "--visibility"],
            )?;
            let output = required(&arguments, "--output")?;
            let artifacts = match (arguments.get("--project"), arguments.get("--pack")) {
                (Some(project), None) => {
                    let root = repository_root(project, arguments.get("--root"))?;
                    let visibility = arguments
                        .get("--visibility")
                        .map(String::as_str)
                        .unwrap_or("public");
                    let bytes = read_project(project)?;
                    let outcome =
                        compile_repository_atlas_bytes(&bytes, project, &root, visibility)?;
                    let Some(artifacts) = outcome.artifacts else {
                        print!("{}", outcome.receipt);
                        return Ok(ExitCode::from(1));
                    };
                    artifacts
                }
                (None, Some(pack)) => {
                    if arguments.contains_key("--root") || arguments.contains_key("--visibility") {
                        return Err(
                            "--root and --visibility apply only to --project compilation"
                                .to_owned(),
                        );
                    }
                    import_context_pack(Path::new(pack))?
                }
                _ => {
                    return Err(
                        "Atlas compile requires exactly one of --project or --pack".to_owned()
                    )
                }
            };
            write_atlas_directory(Path::new(output), &artifacts)?;
            print!("{}", artifacts.receipt);
            Ok(ExitCode::SUCCESS)
        }
        Command::Invoke(operation @ (Operation::AtlasInspect | Operation::AtlasVerify), rest) => {
            let arguments = keyed_arguments(rest, &["--atlas"])?;
            let reference = Path::new(required(&arguments, "--atlas")?);
            if operation == Operation::AtlasInspect {
                print!("{}", inspect_atlas(reference)?);
                Ok(ExitCode::SUCCESS)
            } else {
                let (receipt, valid) = verify_atlas(reference)?;
                print!("{receipt}");
                Ok(if valid {
                    ExitCode::SUCCESS
                } else {
                    ExitCode::from(1)
                })
            }
        }
        Command::Invoke(Operation::AtlasDiff, rest) => {
            let arguments = keyed_arguments(rest, &["--before", "--after"])?;
            print!(
                "{}",
                diff_atlases(
                    Path::new(required(&arguments, "--before")?),
                    Path::new(required(&arguments, "--after")?),
                )?
            );
            Ok(ExitCode::SUCCESS)
        }
        Command::Invoke(Operation::AtlasImpact, rest) => {
            let arguments =
                keyed_arguments(rest, &["--since", "--project", "--root", "--visibility"])?;
            let since = Path::new(required(&arguments, "--since")?);
            let project = required(&arguments, "--project")?;
            let root = repository_root(project, arguments.get("--root"))?;
            let visibility = arguments
                .get("--visibility")
                .map(String::as_str)
                .unwrap_or("public");
            let bytes = read_project(project)?;
            let outcome = compile_repository_atlas_bytes(&bytes, project, &root, visibility)?;
            let Some(artifacts) = outcome.artifacts else {
                print!("{}", outcome.receipt);
                return Ok(ExitCode::from(1));
            };
            print!("{}", impact_from_atlas(since, &artifacts)?);
            Ok(ExitCode::SUCCESS)
        }
        Command::Invoke(Operation::RouteResolve, rest) => {
            let arguments = keyed_arguments(rest, &["--atlas", "--task"])?;
            let task_reference = required(&arguments, "--task")?;
            let task_bytes = read_project(task_reference)?;
            let outcome = resolve_route_bytes(
                Path::new(required(&arguments, "--atlas")?),
                &task_bytes,
                task_reference,
            )?;
            print!("{}", outcome.receipt);
            Ok(if outcome.resolved {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            })
        }
        Command::Invoke(Operation::Read, rest) => {
            let arguments = keyed_arguments(
                rest,
                &["--atlas", "--route", "--intent", "--surface", "--max-hops"],
            )?;
            let atlas = Path::new(required(&arguments, "--atlas")?);
            let route = required(&arguments, "--route")?;
            let intent = required(&arguments, "--intent")?;
            let max_hops = positive_usize(&arguments, "--max-hops")?;
            let output = match required(&arguments, "--surface")? {
                "human" => compile_human_view(atlas, route, intent, max_hops)?,
                "gui" => compile_gui_view(atlas, route, intent, max_hops)?,
                value => return Err(format!("unsupported read surface: {value}")),
            };
            print!("{output}");
            Ok(ExitCode::SUCCESS)
        }
        Command::Invoke(Operation::ChartCreate, rest) => {
            let arguments = keyed_arguments(
                rest,
                &["--atlas", "--route", "--task", "--role", "--budget"],
            )?;
            print!(
                "{}",
                compile_task_chart(
                    Path::new(required(&arguments, "--atlas")?),
                    required(&arguments, "--route")?,
                    required(&arguments, "--task")?,
                    required(&arguments, "--role")?,
                    positive_usize(&arguments, "--budget")?,
                )?
            );
            Ok(ExitCode::SUCCESS)
        }
        Command::Invoke(Operation::ChartInspect, rest) => {
            let arguments = keyed_arguments(rest, &["--chart"])?;
            print!(
                "{}",
                inspect_projection(Path::new(required(&arguments, "--chart")?))?
            );
            Ok(ExitCode::SUCCESS)
        }
        Command::Invoke(Operation::ChartVerify, rest) => {
            let arguments = keyed_arguments(rest, &["--chart", "--atlas"])?;
            let (receipt, valid) = verify_projection(
                Path::new(required(&arguments, "--chart")?),
                Path::new(required(&arguments, "--atlas")?),
            )?;
            print!("{receipt}");
            Ok(if valid {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            })
        }
        Command::Invoke(Operation::Context, rest) => {
            let arguments = keyed_arguments(
                rest,
                &["--atlas", "--route", "--task", "--role", "--budget"],
            )?;
            print!(
                "{}",
                compile_task_chart(
                    Path::new(required(&arguments, "--atlas")?),
                    required(&arguments, "--route")?,
                    required(&arguments, "--task")?,
                    required(&arguments, "--role")?,
                    positive_usize(&arguments, "--budget")?,
                )?
            );
            Ok(ExitCode::SUCCESS)
        }
        Command::Invoke(Operation::Expand, rest) => {
            let arguments = keyed_arguments(rest, &["--atlas", "--view", "--handle", "--budget"])?;
            print!(
                "{}",
                expand_projection(
                    Path::new(required(&arguments, "--atlas")?),
                    Path::new(required(&arguments, "--view")?),
                    required(&arguments, "--handle")?,
                    positive_usize(&arguments, "--budget")?,
                )?
            );
            Ok(ExitCode::SUCCESS)
        }
        Command::Invoke(
            operation @ (Operation::Validate | Operation::Canonicalize | Operation::Compile),
            rest,
        ) => {
            if operation == Operation::Compile && rest.iter().any(|argument| argument == "--output")
            {
                let arguments =
                    keyed_arguments(rest, &["--project", "--output", "--root", "--visibility"])?;
                let reference = required(&arguments, "--project")?;
                let output = required(&arguments, "--output")?;
                let root = repository_root(reference, arguments.get("--root"))?;
                let visibility = arguments
                    .get("--visibility")
                    .map(String::as_str)
                    .unwrap_or("public");
                let bytes = read_project(reference)?;
                let outcome = compile_repository_pack_bytes(&bytes, reference, &root, visibility)?;
                if let Some(artifacts) = outcome.artifacts {
                    write_pack_directory(Path::new(output), &artifacts)?;
                    print!("{}", artifacts.receipt);
                    return Ok(ExitCode::SUCCESS);
                }
                print!("{}", outcome.receipt);
                return Ok(ExitCode::from(1));
            }
            let reference = project_argument(rest)?;
            let bytes = read_project(reference)?;
            let (output, valid) = match operation {
                Operation::Validate => validate_project_bytes_with_validity(&bytes, reference)?,
                Operation::Canonicalize => {
                    canonicalize_project_bytes_with_validity(&bytes, reference)?
                }
                Operation::Compile => compile_project_bytes_with_validity(&bytes, reference)?,
                _ => unreachable!(),
            };
            print!("{output}");
            Ok(if valid {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            })
        }
        Command::Invoke(operation @ (Operation::Inspect | Operation::Verify), rest) => {
            let arguments = keyed_arguments(rest, &["--pack"])?;
            let reference = Path::new(required(&arguments, "--pack")?);
            if operation == Operation::Inspect {
                print!("{}", inspect_pack(reference)?);
                Ok(ExitCode::SUCCESS)
            } else {
                let (receipt, valid) = verify_pack(reference)?;
                print!("{receipt}");
                Ok(if valid {
                    ExitCode::SUCCESS
                } else {
                    ExitCode::from(1)
                })
            }
        }
        Command::Invoke(Operation::Impact, rest) => {
            let arguments =
                keyed_arguments(rest, &["--since", "--project", "--root", "--visibility"])?;
            let since = Path::new(required(&arguments, "--since")?);
            let project = required(&arguments, "--project")?;
            let root = repository_root(project, arguments.get("--root"))?;
            let visibility = arguments
                .get("--visibility")
                .map(String::as_str)
                .unwrap_or("public");
            let bytes = read_project(project)?;
            let outcome = compile_repository_pack_bytes(&bytes, project, &root, visibility)?;
            let Some(artifacts) = outcome.artifacts else {
                print!("{}", outcome.receipt);
                return Ok(ExitCode::from(1));
            };
            let current = pack_value(&artifacts)?;
            print!("{}", impact_between(since, &current)?);
            Ok(ExitCode::SUCCESS)
        }
        Command::Diagnose => {
            println!("{}", diagnose()?);
            Ok(ExitCode::SUCCESS)
        }
        Command::Help => {
            println!("{}", usage());
            Ok(ExitCode::SUCCESS)
        }
        Command::Unknown => Err(format!("unsupported arguments\n{}", usage())),
    }
}

fn status(arguments: &[String]) -> u8 {
    match run(arguments) {
        Ok(code) if code == ExitCode::SUCCESS => 0,
        Ok(_) => 1,
        Err(error) => {
            eprintln!("xinfa: {error}");
            2
        }
    }
}

pub fn main_entry(arguments: &[String]) -> ExitCode {
    ExitCode::from(status(arguments))
}

pub fn main_and_exit(arguments: &[String]) -> ! {
    std::process::exit(status(arguments).into())
}

#[cfg(test)]
mod tests {
    use super::json_string;

    #[test]
    fn escapes_json_strings() {
        assert_eq!(json_string("a\n\"b\\c"), "\"a\\n\\\"b\\\\c\"");
    }
}
