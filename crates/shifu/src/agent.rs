// SPDX-License-Identifier: Apache-2.0

use std::process::exit;

const BRIEF: &str = include_str!("../agent/brief.md");
const MAP: &str = include_str!("../agent/intent-map.json");
const CAPABILITIES: &str = include_str!("../agent/capabilities.json");
const SCHEMA: &str = include_str!("../agent/kfd3_api.schema.json");
const REGISTRY: &str = include_str!("../agent/kfd3_api.registry.json");

fn json_surface(value: &str) {
    print!("{}", value);
    if !value.ends_with('\n') {
        println!();
    }
}

fn verified() -> bool {
    [
        "shifu.agent.brief",
        "shifu.agent.map",
        "shifu.agent.capabilities",
        "shifu.agent.schema",
        "shifu.agent.verify",
    ]
    .iter()
    .all(|id| REGISTRY.contains(id))
        && [
            "acquire",
            "doctor-bootstrap",
            "toolchain",
            "dependencies",
            "build",
            "check",
            "verify",
            "artifacts",
            "promotion",
            "recovery",
        ]
        .iter()
        .all(|route| MAP.contains(route) && CAPABILITIES.contains(route))
}

pub(crate) fn run(arguments: &[String]) -> ! {
    match arguments
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["brief"] => print!("{BRIEF}"),
        ["map", "--json"] => json_surface(MAP),
        ["capabilities", "--json"] => json_surface(CAPABILITIES),
        ["schema", "--json"] => json_surface(SCHEMA),
        ["registry", "--json"] => json_surface(REGISTRY),
        ["verify", "--json"] => {
            let ok = verified();
            println!("{{\"schema\":\"shifu.agent-verification/v1\",\"ok\":{ok},\"registryId\":\"shifu-agent-interface\",\"authority\":\"shifu\"}}");
            exit(if ok { 0 } else { 1 });
        }
        _ => {
            eprintln!("usage: shifu agent brief|map --json|capabilities --json|schema --json|registry --json|verify --json");
            exit(2);
        }
    }
    exit(0)
}

#[cfg(test)]
mod tests {
    #[test]
    fn agent_registry_covers_every_development_route() {
        assert!(super::verified());
    }
}
