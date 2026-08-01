// SPDX-License-Identifier: Apache-2.0

const BRIEF: &str = include_str!("../agent/brief.md");
const MAP: &str = include_str!("../agent/intent-map.json");
const CAPABILITIES: &str = include_str!("../agent/capabilities.json");
const SCHEMA: &str = include_str!("../agent/kfd3_api.schema.json");
const REGISTRY: &str = include_str!("../agent/kfd3_api.registry.json");

pub(crate) fn response(arguments: &[String]) -> Result<(String, bool), String> {
    let values = arguments.iter().map(String::as_str).collect::<Vec<_>>();
    Ok(match values.as_slice() {
        ["brief"] => (BRIEF.to_owned(), true),
        ["map", "--json"] => (MAP.to_owned(), true),
        ["capabilities", "--json"] => (CAPABILITIES.to_owned(), true),
        ["schema", "--json"] => (SCHEMA.to_owned(), true),
        ["registry", "--json"] => (REGISTRY.to_owned(), true),
        ["verify", "--json"] => {
            let required_routes = ["route-resolution", "verified-context", "budget-control", "expansion", "diagnosis", "schema-discovery"];
            let required_apis = ["xinfa.agent.brief", "xinfa.agent.map", "xinfa.agent.capabilities", "xinfa.agent.schema", "xinfa.agent.verify", "xinfa.context", "xinfa.expand"];
            let valid_json = [MAP, CAPABILITIES, SCHEMA, REGISTRY].iter().all(|value| serde_json::from_str::<serde_json::Value>(value).is_ok());
            let ok = valid_json && required_routes.iter().all(|id| MAP.contains(id) && CAPABILITIES.contains(id)) && required_apis.iter().all(|id| REGISTRY.contains(id));
            (format!("{{\"schema\":\"xinfa.agent-verification/v1\",\"ok\":{ok},\"registryId\":\"xinfa-agent-interface\",\"authority\":\"xinfa\"}}\n"), ok)
        }
        _ => return Err("expected agent brief|map --json|capabilities --json|schema --json|registry --json|verify --json".to_owned()),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn agent_registry_covers_every_context_route() {
        let (_, ok) = super::response(&["verify".into(), "--json".into()]).unwrap();
        assert!(ok);
    }
}
