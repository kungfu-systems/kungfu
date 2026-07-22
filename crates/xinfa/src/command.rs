// SPDX-License-Identifier: Apache-2.0

#[cfg(not(target_arch = "wasm32"))]
use std::collections::{BTreeMap, BTreeSet};

pub(crate) const PRODUCT_CONTRACT: &str = include_str!("../contract/xinfa-product-v2.json");

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Operation {
    ProjectDiscover,
    ProjectCandidate,
    ProjectExplain,
    ProjectAccept,
    ProjectMaterialize,
    Validate,
    Canonicalize,
    Compile,
    Inspect,
    Verify,
    Impact,
    AtlasCompile,
    AtlasInspect,
    AtlasVerify,
    AtlasDiff,
    AtlasImpact,
    RouteResolve,
    EpisodeCompile,
    Read,
    ChartCreate,
    ChartInspect,
    ChartVerify,
    Context,
    Expand,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Command<'a> {
    Version,
    Help,
    Contract,
    Schema(&'a str),
    Diagnose,
    Invoke(Operation, &'a [String]),
    Unknown,
}

pub(crate) fn parse(arguments: &[String]) -> Command<'_> {
    match arguments {
        [flag] if flag == "--version" || flag == "-V" => Command::Version,
        [flag] if flag == "--help" || flag == "-h" => Command::Help,
        [command, format] if command == "contract" && format == "--json" => Command::Contract,
        [command, name] if command == "schema" => Command::Schema(name),
        [command, format] if command == "diagnose" && format == "--json" => Command::Diagnose,
        [namespace, operation, rest @ ..]
            if namespace == "project" && operation == "materialize" =>
        {
            Command::Invoke(Operation::ProjectMaterialize, rest)
        }
        [namespace, operation, rest @ ..] if namespace == "project" => match operation.as_str() {
            "discover" => Command::Invoke(Operation::ProjectDiscover, rest),
            "candidate" => Command::Invoke(Operation::ProjectCandidate, rest),
            "explain" => Command::Invoke(Operation::ProjectExplain, rest),
            "accept" => Command::Invoke(Operation::ProjectAccept, rest),
            _ => Command::Unknown,
        },
        [command, rest @ ..] if command == "validate" => Command::Invoke(Operation::Validate, rest),
        [command, rest @ ..] if command == "canonicalize" => {
            Command::Invoke(Operation::Canonicalize, rest)
        }
        [command, rest @ ..] if command == "compile" => Command::Invoke(Operation::Compile, rest),
        [command, rest @ ..] if command == "inspect" => Command::Invoke(Operation::Inspect, rest),
        [command, rest @ ..] if command == "verify" => Command::Invoke(Operation::Verify, rest),
        [command, rest @ ..] if command == "impact" => Command::Invoke(Operation::Impact, rest),
        [namespace, operation, rest @ ..] if namespace == "atlas" => match operation.as_str() {
            "compile" => Command::Invoke(Operation::AtlasCompile, rest),
            "inspect" => Command::Invoke(Operation::AtlasInspect, rest),
            "verify" => Command::Invoke(Operation::AtlasVerify, rest),
            "diff" => Command::Invoke(Operation::AtlasDiff, rest),
            "impact" => Command::Invoke(Operation::AtlasImpact, rest),
            _ => Command::Unknown,
        },
        [namespace, operation, rest @ ..] if namespace == "route" && operation == "resolve" => {
            Command::Invoke(Operation::RouteResolve, rest)
        }
        [namespace, operation, rest @ ..] if namespace == "episode" && operation == "compile" => {
            Command::Invoke(Operation::EpisodeCompile, rest)
        }
        [command, rest @ ..] if command == "read" => Command::Invoke(Operation::Read, rest),
        [namespace, operation, rest @ ..] if namespace == "chart" => match operation.as_str() {
            "create" => Command::Invoke(Operation::ChartCreate, rest),
            "inspect" => Command::Invoke(Operation::ChartInspect, rest),
            "verify" => Command::Invoke(Operation::ChartVerify, rest),
            _ => Command::Unknown,
        },
        [command, rest @ ..] if command == "context" => Command::Invoke(Operation::Context, rest),
        [command, rest @ ..] if command == "expand" => Command::Invoke(Operation::Expand, rest),
        _ => Command::Unknown,
    }
}

pub(crate) fn schema(name: &str) -> Option<&'static str> {
    Some(match name {
        "project" => include_str!("../schema/project-v1.schema.json"),
        "semantic-project" => include_str!("../schema/semantic-project-v1.schema.json"),
        "repository-discovery-request" => {
            include_str!("../schema/repository-discovery-request-v1.schema.json")
        }
        "repository-inventory" => {
            include_str!("../schema/repository-inventory-v1.schema.json")
        }
        "onboarding-candidate" => {
            include_str!("../schema/onboarding-candidate-v1.schema.json")
        }
        "onboarding-explanation" => {
            include_str!("../schema/onboarding-explanation-v1.schema.json")
        }
        "onboarding-selection" => {
            include_str!("../schema/onboarding-selection-v1.schema.json")
        }
        "onboarding-acceptance" => {
            include_str!("../schema/onboarding-acceptance-v1.schema.json")
        }
        "context-ir" => include_str!("../schema/context-ir-v1.schema.json"),
        "context-pack" => include_str!("../schema/context-pack-v1.schema.json"),
        "pack-manifest" => include_str!("../schema/context-pack-manifest-v1.schema.json"),
        "pack-receipt" => include_str!("../schema/context-pack-receipt-v1.schema.json"),
        "atlas" => include_str!("../schema/atlas-v1.schema.json"),
        "atlas-view" => include_str!("../schema/atlas-view-v1.schema.json"),
        "atlas-manifest" => include_str!("../schema/atlas-manifest-v1.schema.json"),
        "atlas-receipt" => include_str!("../schema/atlas-receipt-v1.schema.json"),
        "human-view" => include_str!("../schema/human-view-v1.schema.json"),
        "task-envelope" => include_str!("../schema/task-envelope-v1.schema.json"),
        "route-resolution" => include_str!("../schema/route-resolution-v1.schema.json"),
        "task-chart" => include_str!("../schema/task-chart-v1.schema.json"),
        "gui-view" => include_str!("../schema/gui-view-v1.schema.json"),
        "projection-recipe" => include_str!("../schema/projection-recipe-v1.schema.json"),
        "episode-provider-submission" => {
            include_str!("../schema/episode-provider-submission-v1.schema.json")
        }
        "review-chart" => include_str!("../schema/review-chart-v1.schema.json"),
        _ => return None,
    })
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn keyed_options(
    arguments: &[String],
    allowed: &[&str],
    usage: &str,
) -> Result<BTreeMap<String, String>, String> {
    if arguments.last().map(String::as_str) != Some("--json") {
        return Err(format!("expected --json\n{usage}"));
    }
    let allowed: BTreeSet<&str> = allowed.iter().copied().collect();
    let mut parsed = BTreeMap::new();
    let mut index = 0;
    while index + 1 < arguments.len() {
        let key = arguments[index].as_str();
        if !allowed.contains(key) || index + 1 >= arguments.len() - 1 {
            return Err(format!("unsupported or missing option: {key}\n{usage}"));
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

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn required<'a>(
    arguments: &'a BTreeMap<String, String>,
    key: &str,
) -> Result<&'a str, String> {
    arguments
        .get(key)
        .map(String::as_str)
        .ok_or_else(|| format!("missing required option: {key}"))
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn positive_usize(
    arguments: &BTreeMap<String, String>,
    key: &str,
) -> Result<usize, String> {
    positive_value(required(arguments, key)?, key)
}

pub(crate) fn option<'a>(arguments: &'a [String], name: &str) -> Option<&'a str> {
    arguments
        .windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].as_str())
}

pub(crate) fn positive(arguments: &[String], name: &str) -> Result<usize, String> {
    let value =
        option(arguments, name).ok_or_else(|| format!("missing required option: {name}"))?;
    positive_value(value, name)
}

fn positive_value(value: &str, name: &str) -> Result<usize, String> {
    let value = value
        .parse::<usize>()
        .map_err(|_| format!("{name} must be a positive integer"))?;
    if value == 0 {
        return Err(format!("{name} must be a positive integer"));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn native_and_wasm_adapters_share_one_command_classifier() {
        assert_eq!(parse(&args(&["--version"])), Command::Version);
        let verify = args(&["atlas", "verify", "--atlas", "out", "--json"]);
        assert!(matches!(
            parse(&verify),
            Command::Invoke(Operation::AtlasVerify, rest)
                if rest == args(&["--atlas", "out", "--json"])
        ));
        assert_eq!(parse(&args(&["atlas", "unknown"])), Command::Unknown);
        assert!(matches!(
            parse(&args(&["project", "discover", "--root", ".", "--json"])),
            Command::Invoke(Operation::ProjectDiscover, _)
        ));
    }

    #[test]
    fn option_validation_rejects_duplicates_and_non_positive_values() {
        assert_eq!(
            keyed_options(
                &args(&["--project", "a", "--project", "b", "--json"]),
                &["--project"],
                "usage"
            ),
            Err("duplicate option: --project".to_owned())
        );
        assert_eq!(
            positive(&args(&["--budget", "0"]), "--budget"),
            Err("--budget must be a positive integer".to_owned())
        );
    }
}
