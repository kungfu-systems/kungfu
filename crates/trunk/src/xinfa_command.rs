// SPDX-License-Identifier: Apache-2.0

use std::env;
use std::path::{Path, PathBuf};

const ATLAS_COMMANDS: &[&str] = &["compile", "diff", "impact", "inspect", "verify"];

fn has_option(arguments: &[String], name: &str) -> bool {
    let prefix = format!("{name}=");
    arguments
        .iter()
        .any(|argument| argument == name || argument.starts_with(&prefix))
}

fn workspace_and_forwarded(arguments: &[String]) -> Result<(PathBuf, Vec<String>), String> {
    let mut workspace =
        env::current_dir().map_err(|error| format!("cannot resolve cwd: {error}"))?;
    let mut forwarded = Vec::new();
    let mut index = 0;
    while index < arguments.len() {
        let value = &arguments[index];
        if value == "--workspace" {
            let Some(path) = arguments.get(index + 1) else {
                return Err("--workspace requires a path".to_string());
            };
            workspace = PathBuf::from(path);
            index += 2;
            continue;
        }
        if let Some(path) = value.strip_prefix("--workspace=") {
            workspace = PathBuf::from(path);
            index += 1;
            continue;
        }
        forwarded.push(value.clone());
        index += 1;
    }
    let workspace = if workspace.is_absolute() {
        workspace
    } else {
        env::current_dir()
            .map_err(|error| format!("cannot resolve cwd: {error}"))?
            .join(workspace)
    };
    Ok((
        workspace
            .canonicalize()
            .unwrap_or_else(|_| lexical_absolute(&workspace)),
        forwarded,
    ))
}

fn lexical_absolute(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

pub(crate) fn normalize(arguments: &[String]) -> Result<Vec<String>, String> {
    if arguments.first().map(String::as_str) == Some("--source-argv") {
        return Ok(arguments[1..].to_vec());
    }
    let Some(operation) = arguments.first() else {
        return Ok(Vec::new());
    };
    if !ATLAS_COMMANDS.contains(&operation.as_str()) {
        return Ok(arguments.to_vec());
    }

    let (workspace, forwarded) = workspace_and_forwarded(&arguments[1..])?;
    if operation != "compile" {
        return Ok(["atlas".to_string(), operation.clone()]
            .into_iter()
            .chain(forwarded)
            .collect());
    }

    let has_project = has_option(&forwarded, "--project");
    let has_pack = has_option(&forwarded, "--pack");
    let has_root = has_option(&forwarded, "--root");
    let has_output = has_option(&forwarded, "--output");
    let mut normalized = forwarded;
    normalized.retain(|argument| argument != "--json");
    if !has_project && !has_pack {
        normalized.splice(
            0..0,
            [
                "--project".to_string(),
                workspace.join(".xinfa/project.json").display().to_string(),
            ],
        );
    }
    if (has_project || !has_pack) && !has_root {
        normalized.splice(
            0..0,
            ["--root".to_string(), workspace.display().to_string()],
        );
    }
    if !has_output {
        normalized.extend([
            "--output".to_string(),
            workspace.join(".xinfa/atlas").display().to_string(),
        ]);
    }
    normalized.push("--json".to_string());
    Ok(["atlas".to_string(), "compile".to_string()]
        .into_iter()
        .chain(normalized)
        .collect())
}

pub(crate) fn run(arguments: &[String]) -> ! {
    match normalize(arguments) {
        Ok(normalized) => xinfa::cli::main_and_exit(&normalized),
        Err(error) => {
            eprintln!("xinfa: {error}");
            std::process::exit(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn non_atlas_commands_are_argv_transparent() {
        let arguments = strings(&["route", "resolve", "--atlas", "out", "--json"]);
        assert_eq!(normalize(&arguments).unwrap(), arguments);
    }

    #[test]
    fn source_entry_can_preserve_the_complete_engine_argv() {
        assert_eq!(
            normalize(&strings(&[
                "--source-argv",
                "compile",
                "--project",
                "project.json",
                "--json",
            ]))
            .unwrap(),
            strings(&["compile", "--project", "project.json", "--json"])
        );
    }

    #[test]
    fn atlas_lifecycle_shortcuts_gain_the_namespace() {
        assert_eq!(
            normalize(&strings(&["verify", "--atlas", "out", "--json"])).unwrap(),
            strings(&["atlas", "verify", "--atlas", "out", "--json"])
        );
    }

    #[test]
    fn bare_compile_gets_complete_workspace_defaults() {
        let workspace = env::current_dir().unwrap().canonicalize().unwrap();
        assert_eq!(
            normalize(&strings(&["compile"])).unwrap(),
            vec![
                "atlas".to_string(),
                "compile".to_string(),
                "--root".to_string(),
                workspace.display().to_string(),
                "--project".to_string(),
                workspace.join(".xinfa/project.json").display().to_string(),
                "--output".to_string(),
                workspace.join(".xinfa/atlas").display().to_string(),
                "--json".to_string(),
            ]
        );
    }

    #[test]
    fn workspace_requires_a_value() {
        let error = normalize(&strings(&["compile", "--workspace"])).unwrap_err();
        assert_eq!(error, "--workspace requires a path");
    }
}
