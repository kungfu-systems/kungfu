use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

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
const PRODUCT_CONTRACT: &str = include_str!("../contract/xinfa-product-v2.json");
const PROJECT_SCHEMA: &str = include_str!("../schema/project-v1.schema.json");
const SEMANTIC_PROJECT_SCHEMA: &str = include_str!("../schema/semantic-project-v1.schema.json");
const CONTEXT_IR_SCHEMA: &str = include_str!("../schema/context-ir-v1.schema.json");
const CONTEXT_PACK_SCHEMA: &str = include_str!("../schema/context-pack-v1.schema.json");
const PACK_MANIFEST_SCHEMA: &str = include_str!("../schema/context-pack-manifest-v1.schema.json");
const PACK_RECEIPT_SCHEMA: &str = include_str!("../schema/context-pack-receipt-v1.schema.json");
const ATLAS_SCHEMA: &str = include_str!("../schema/atlas-v1.schema.json");
const ATLAS_VIEW_SCHEMA: &str = include_str!("../schema/atlas-view-v1.schema.json");
const ATLAS_MANIFEST_SCHEMA: &str = include_str!("../schema/atlas-manifest-v1.schema.json");
const ATLAS_RECEIPT_SCHEMA: &str = include_str!("../schema/atlas-receipt-v1.schema.json");
const HUMAN_VIEW_SCHEMA: &str = include_str!("../schema/human-view-v1.schema.json");
const TASK_CHART_SCHEMA: &str = include_str!("../schema/task-chart-v1.schema.json");
const TASK_ENVELOPE_SCHEMA: &str = include_str!("../schema/task-envelope-v1.schema.json");
const ROUTE_RESOLUTION_SCHEMA: &str = include_str!("../schema/route-resolution-v1.schema.json");
const GUI_VIEW_SCHEMA: &str = include_str!("../schema/gui-view-v1.schema.json");
const PROJECTION_RECIPE_SCHEMA: &str = include_str!("../schema/projection-recipe-v1.schema.json");
const EPISODE_PROVIDER_SUBMISSION_SCHEMA: &str =
    include_str!("../schema/episode-provider-submission-v1.schema.json");
const REVIEW_CHART_SCHEMA: &str = include_str!("../schema/review-chart-v1.schema.json");

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
fn usage() -> &'static str {
    "Usage:\n  xinfa --version\n  xinfa contract --json\n  xinfa schema project|semantic-project|context-ir|context-pack|pack-manifest|pack-receipt|atlas|atlas-view|atlas-manifest|atlas-receipt|human-view|task-envelope|route-resolution|task-chart|gui-view|projection-recipe|episode-provider-submission|review-chart\n  xinfa project materialize --inventory FILE|- --json\n  xinfa validate --project FILE|- --json\n  xinfa canonicalize --project FILE|- --json\n  xinfa compile --project FILE|- --json\n  xinfa compile --project FILE --output DIR [--root DIR] [--visibility public|internal|private] --json\n  xinfa inspect --pack FILE|DIR --json\n  xinfa verify --pack FILE|DIR --json\n  xinfa impact --since FILE|DIR --project FILE [--root DIR] [--visibility public|internal|private] --json\n  xinfa atlas compile --project FILE --output DIR [--root DIR] [--visibility public|internal|private] --json\n  xinfa atlas compile --pack DIR --output DIR --json\n  xinfa atlas inspect --atlas FILE|DIR --json\n  xinfa atlas verify --atlas FILE|DIR --json\n  xinfa atlas diff --before DIR --after DIR --json\n  xinfa atlas impact --since DIR --project FILE [--root DIR] [--visibility public|internal|private] --json\n  xinfa route resolve --atlas DIR --task FILE|- --json\n  xinfa episode compile --before DIR --project FILE --submission RELATIVE_FILE --output DIR [--root DIR] --json\n  xinfa read --atlas DIR --route ID --intent TEXT --surface human|gui --max-hops N --json\n  xinfa chart create --atlas DIR --route ID --task TEXT --role ROLE --budget TOKENS --json\n  xinfa chart inspect --chart FILE --json\n  xinfa chart verify --chart FILE --atlas DIR --json\n  xinfa context --atlas DIR --route ID --task TEXT --role ROLE --budget TOKENS --json\n  xinfa expand --atlas DIR --view FILE --handle ID --budget TOKENS --json\n  xinfa diagnose --json"
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
    if arguments.last().map(String::as_str) != Some("--json") {
        return Err(format!("expected --json\n{}", usage()));
    }
    let allowed: BTreeSet<&str> = allowed.iter().copied().collect();
    let mut parsed = BTreeMap::new();
    let mut index = 0;
    while index + 1 < arguments.len() {
        let key = arguments[index].as_str();
        if !allowed.contains(key) || index + 1 >= arguments.len() - 1 {
            return Err(format!("unsupported or missing option: {key}\n{}", usage()));
        }
        if parsed
            .insert(key.to_owned(), arguments[index + 1].clone())
            .is_some()
        {
            return Err(format!("duplicate option: {key}"));
        }
        index += 2;
    }
    Ok(parsed)
}

fn required<'a>(arguments: &'a BTreeMap<String, String>, key: &str) -> Result<&'a str, String> {
    arguments
        .get(key)
        .map(String::as_str)
        .ok_or_else(|| format!("missing required option: {key}"))
}

fn positive_usize(arguments: &BTreeMap<String, String>, key: &str) -> Result<usize, String> {
    let value = required(arguments, key)?;
    let parsed = value
        .parse::<usize>()
        .map_err(|_| format!("{key} must be a positive integer"))?;
    if parsed == 0 {
        return Err(format!("{key} must be a positive integer"));
    }
    Ok(parsed)
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
    match arguments {
        [flag] if flag == "--version" || flag == "-V" => {
            println!("xinfa {VERSION}");
            Ok(ExitCode::SUCCESS)
        }
        [command, format] if command == "contract" && format == "--json" => {
            print!("{PRODUCT_CONTRACT}");
            Ok(ExitCode::SUCCESS)
        }
        [namespace, operation, rest @ ..]
            if namespace == "project" && operation == "materialize" =>
        {
            let arguments = keyed_arguments(rest, &["--inventory"])?;
            let reference = required(&arguments, "--inventory")?;
            let bytes = read_project(reference)?;
            print!(
                "{}",
                materialize_surface_inventory_bytes(&bytes, reference)?
            );
            Ok(ExitCode::SUCCESS)
        }
        [command, name] if command == "schema" && name == "project" => {
            print!("{PROJECT_SCHEMA}");
            Ok(ExitCode::SUCCESS)
        }
        [command, name] if command == "schema" && name == "semantic-project" => {
            print!("{SEMANTIC_PROJECT_SCHEMA}");
            Ok(ExitCode::SUCCESS)
        }
        [command, name] if command == "schema" && name == "context-ir" => {
            print!("{CONTEXT_IR_SCHEMA}");
            Ok(ExitCode::SUCCESS)
        }
        [command, name] if command == "schema" && name == "context-pack" => {
            print!("{CONTEXT_PACK_SCHEMA}");
            Ok(ExitCode::SUCCESS)
        }
        [command, name] if command == "schema" && name == "pack-manifest" => {
            print!("{PACK_MANIFEST_SCHEMA}");
            Ok(ExitCode::SUCCESS)
        }
        [command, name] if command == "schema" && name == "pack-receipt" => {
            print!("{PACK_RECEIPT_SCHEMA}");
            Ok(ExitCode::SUCCESS)
        }
        [command, name] if command == "schema" && name == "atlas" => {
            print!("{ATLAS_SCHEMA}");
            Ok(ExitCode::SUCCESS)
        }
        [command, name] if command == "schema" && name == "atlas-view" => {
            print!("{ATLAS_VIEW_SCHEMA}");
            Ok(ExitCode::SUCCESS)
        }
        [command, name] if command == "schema" && name == "atlas-manifest" => {
            print!("{ATLAS_MANIFEST_SCHEMA}");
            Ok(ExitCode::SUCCESS)
        }
        [command, name] if command == "schema" && name == "atlas-receipt" => {
            print!("{ATLAS_RECEIPT_SCHEMA}");
            Ok(ExitCode::SUCCESS)
        }
        [command, name] if command == "schema" && name == "human-view" => {
            print!("{HUMAN_VIEW_SCHEMA}");
            Ok(ExitCode::SUCCESS)
        }
        [command, name] if command == "schema" && name == "task-chart" => {
            print!("{TASK_CHART_SCHEMA}");
            Ok(ExitCode::SUCCESS)
        }
        [command, name] if command == "schema" && name == "task-envelope" => {
            print!("{TASK_ENVELOPE_SCHEMA}");
            Ok(ExitCode::SUCCESS)
        }
        [command, name] if command == "schema" && name == "route-resolution" => {
            print!("{ROUTE_RESOLUTION_SCHEMA}");
            Ok(ExitCode::SUCCESS)
        }
        [command, name] if command == "schema" && name == "gui-view" => {
            print!("{GUI_VIEW_SCHEMA}");
            Ok(ExitCode::SUCCESS)
        }
        [command, name] if command == "schema" && name == "projection-recipe" => {
            print!("{PROJECTION_RECIPE_SCHEMA}");
            Ok(ExitCode::SUCCESS)
        }
        [command, name] if command == "schema" && name == "episode-provider-submission" => {
            print!("{EPISODE_PROVIDER_SUBMISSION_SCHEMA}");
            Ok(ExitCode::SUCCESS)
        }
        [command, name] if command == "schema" && name == "review-chart" => {
            print!("{REVIEW_CHART_SCHEMA}");
            Ok(ExitCode::SUCCESS)
        }
        [namespace, operation, rest @ ..] if namespace == "episode" && operation == "compile" => {
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
        [namespace, operation, rest @ ..] if namespace == "atlas" && operation == "compile" => {
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
        [namespace, operation, rest @ ..]
            if namespace == "atlas" && (operation == "inspect" || operation == "verify") =>
        {
            let arguments = keyed_arguments(rest, &["--atlas"])?;
            let reference = Path::new(required(&arguments, "--atlas")?);
            if operation == "inspect" {
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
        [namespace, operation, rest @ ..] if namespace == "atlas" && operation == "diff" => {
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
        [namespace, operation, rest @ ..] if namespace == "atlas" && operation == "impact" => {
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
        [namespace, operation, rest @ ..] if namespace == "route" && operation == "resolve" => {
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
        [command, rest @ ..] if command == "read" => {
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
        [namespace, operation, rest @ ..] if namespace == "chart" && operation == "create" => {
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
        [namespace, operation, rest @ ..] if namespace == "chart" && operation == "inspect" => {
            let arguments = keyed_arguments(rest, &["--chart"])?;
            print!(
                "{}",
                inspect_projection(Path::new(required(&arguments, "--chart")?))?
            );
            Ok(ExitCode::SUCCESS)
        }
        [namespace, operation, rest @ ..] if namespace == "chart" && operation == "verify" => {
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
        [command, rest @ ..] if command == "context" => {
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
        [command, rest @ ..] if command == "expand" => {
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
        [command, rest @ ..]
            if command == "validate" || command == "canonicalize" || command == "compile" =>
        {
            if command == "compile" && rest.iter().any(|argument| argument == "--output") {
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
            let (output, valid) = match command.as_str() {
                "validate" => validate_project_bytes_with_validity(&bytes, reference)?,
                "canonicalize" => canonicalize_project_bytes_with_validity(&bytes, reference)?,
                "compile" => compile_project_bytes_with_validity(&bytes, reference)?,
                _ => unreachable!(),
            };
            print!("{output}");
            Ok(if valid {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            })
        }
        [command, rest @ ..] if command == "inspect" || command == "verify" => {
            let arguments = keyed_arguments(rest, &["--pack"])?;
            let reference = Path::new(required(&arguments, "--pack")?);
            if command == "inspect" {
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
        [command, rest @ ..] if command == "impact" => {
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
        [command, format] if command == "diagnose" && format == "--json" => {
            println!("{}", diagnose()?);
            Ok(ExitCode::SUCCESS)
        }
        [flag] if flag == "--help" || flag == "-h" => {
            println!("{}", usage());
            Ok(ExitCode::SUCCESS)
        }
        _ => Err(format!("unsupported arguments\n{}", usage())),
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
