use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use xinfa::{
    canonicalize_project_bytes_with_validity, compile_project_bytes_with_validity,
    compile_repository_atlas_bytes, compile_repository_pack_bytes, diff_atlases, impact_between,
    impact_from_atlas, import_context_pack, inspect_atlas, inspect_pack, pack_value,
    validate_project_bytes_with_validity, verify_atlas, verify_pack, write_atlas_directory,
    write_pack_directory,
};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const PRODUCT_CONTRACT: &str = include_str!("../contract/xinfa-product-v1.json");
const PROJECT_SCHEMA: &str = include_str!("../schema/project-v1.schema.json");
const CONTEXT_IR_SCHEMA: &str = include_str!("../schema/context-ir-v1.schema.json");
const CONTEXT_PACK_SCHEMA: &str = include_str!("../schema/context-pack-v1.schema.json");
const PACK_MANIFEST_SCHEMA: &str = include_str!("../schema/context-pack-manifest-v1.schema.json");
const PACK_RECEIPT_SCHEMA: &str = include_str!("../schema/context-pack-receipt-v1.schema.json");
const ATLAS_SCHEMA: &str = include_str!("../schema/atlas-v1.schema.json");
const ATLAS_VIEW_SCHEMA: &str = include_str!("../schema/atlas-view-v1.schema.json");
const ATLAS_MANIFEST_SCHEMA: &str = include_str!("../schema/atlas-manifest-v1.schema.json");
const ATLAS_RECEIPT_SCHEMA: &str = include_str!("../schema/atlas-receipt-v1.schema.json");

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
    "Usage:\n  xinfa --version\n  xinfa contract --json\n  xinfa schema project|context-ir|context-pack|pack-manifest|pack-receipt|atlas|atlas-view|atlas-manifest|atlas-receipt\n  xinfa validate --project FILE|- --json\n  xinfa canonicalize --project FILE|- --json\n  xinfa compile --project FILE|- --json\n  xinfa compile --project FILE --output DIR [--root DIR] [--visibility public|internal|private] --json\n  xinfa inspect --pack FILE|DIR --json\n  xinfa verify --pack FILE|DIR --json\n  xinfa impact --since FILE|DIR --project FILE [--root DIR] [--visibility public|internal|private] --json\n  xinfa atlas compile --project FILE --output DIR [--root DIR] [--visibility public|internal|private] --json\n  xinfa atlas compile --pack DIR --output DIR --json\n  xinfa atlas inspect --atlas FILE|DIR --json\n  xinfa atlas verify --atlas FILE|DIR --json\n  xinfa atlas diff --before DIR --after DIR --json\n  xinfa atlas impact --since DIR --project FILE [--root DIR] [--visibility public|internal|private] --json\n  xinfa diagnose --json"
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

fn run() -> Result<ExitCode, String> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    match arguments.as_slice() {
        [flag] if flag == "--version" || flag == "-V" => {
            println!("xinfa {VERSION}");
            Ok(ExitCode::SUCCESS)
        }
        [command, format] if command == "contract" && format == "--json" => {
            print!("{PRODUCT_CONTRACT}");
            Ok(ExitCode::SUCCESS)
        }
        [command, name] if command == "schema" && name == "project" => {
            print!("{PROJECT_SCHEMA}");
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

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("xinfa: {error}");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::json_string;

    #[test]
    fn escapes_json_strings() {
        assert_eq!(json_string("a\n\"b\\c"), "\"a\\n\\\"b\\\\c\"");
    }
}
