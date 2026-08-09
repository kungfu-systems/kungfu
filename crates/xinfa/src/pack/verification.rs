// SPDX-License-Identifier: Apache-2.0

use super::*;

fn pack_core(pack: &Value) -> Result<Value, String> {
    let mut core = pack.clone();
    core.pointer_mut("/roots")
        .and_then(Value::as_object_mut)
        .and_then(|roots| roots.remove("pack"))
        .ok_or_else(|| "pack is missing roots.pack".to_owned())?;
    Ok(core)
}

pub(super) fn verify_value(pack: &Value) -> Vec<PackDiagnostic> {
    let mut diagnostics = Vec::new();
    if pack["schema"] != "xinfa.context-pack/v1" {
        diagnostics.push(PackDiagnostic::error(
            "pack-schema",
            "/schema",
            "must be xinfa.context-pack/v1",
        ));
        return diagnostics;
    }
    let expected = pack
        .pointer("/roots/pack")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match pack_core(pack) {
        Ok(core) if digest(&core) != expected => diagnostics.push(PackDiagnostic::error(
            "pack-root",
            "/roots/pack",
            "pack root does not match canonical pack content",
        )),
        Err(message) => {
            diagnostics.push(PackDiagnostic::error("pack-root", "/roots/pack", message))
        }
        _ => {}
    }
    if let Some(inventory) = pack["inventory"].as_array() {
        for item in inventory {
            let path = item["path"].as_str().unwrap_or_default();
            let content = item["content"].as_str();
            if item["encoding"] != "utf-8" || content.is_none() {
                diagnostics.push(PackDiagnostic::error(
                    "source-encoding",
                    format!("/inventory/{path}"),
                    "source unit must contain UTF-8 payload",
                ));
                continue;
            }
            let bytes = content.expect("checked content").as_bytes();
            if byte_digest(bytes) != item["contentRoot"].as_str().unwrap_or_default()
                || item["size"].as_u64() != Some(bytes.len() as u64)
            {
                diagnostics.push(PackDiagnostic::error(
                    "source-content-root",
                    format!("/inventory/{path}"),
                    "source payload does not match its content root and size",
                ));
            }
        }
    } else {
        diagnostics.push(PackDiagnostic::error(
            "source-inventory",
            "/inventory",
            "pack inventory must be an array",
        ));
    }
    for (field, value) in [
        ("source", &pack["inventory"]),
        ("coverage", &pack["coverage"]),
        ("cut", &pack["cut"]),
    ] {
        let expected = pack["roots"][field].as_str().unwrap_or_default();
        if digest(value) != expected {
            diagnostics.push(PackDiagnostic::error(
                "component-root",
                format!("/roots/{field}"),
                format!("{field} root does not match content"),
            ));
        }
    }
    let authority = json!({"cut": pack["cut"], "nodes": pack["nodes"], "edges": pack["edges"]});
    if digest(&authority) != pack["roots"]["authority"].as_str().unwrap_or_default() {
        diagnostics.push(PackDiagnostic::error(
            "component-root",
            "/roots/authority",
            "authority root does not match content",
        ));
    }
    let policy = json!({"policies": pack["policies"], "visibility": pack["visibility"], "routes": pack["routes"]});
    if digest(&policy) != pack["roots"]["policy"].as_str().unwrap_or_default() {
        diagnostics.push(PackDiagnostic::error(
            "component-root",
            "/roots/policy",
            "policy root does not match content",
        ));
    }
    let mut groups: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
    let nodes: BTreeMap<&str, &Value> = pack["nodes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter_map(|node| Some((node["id"].as_str()?, node)))
        .collect();
    if let Some(routes) = pack["routes"].as_array() {
        for route in routes {
            let selected: Vec<Value> = route["nodes"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .filter_map(|id| {
                    let id = id.as_str()?;
                    let node = nodes.get(id)?;
                    Some(json!({
                        "id": id,
                        "revision": node["revision"],
                        "status": node["verification"]["status"],
                    }))
                })
                .collect();
            if selected.len() != route["nodes"].as_array().map(Vec::len).unwrap_or_default()
                || digest(&Value::Array(selected))
                    != route["authorityRoot"].as_str().unwrap_or_default()
            {
                diagnostics.push(PackDiagnostic::error(
                    "route-authority-root",
                    format!("/routes/{}", route["id"].as_str().unwrap_or_default()),
                    "route authority root does not match selected nodes",
                ));
            }
            let mut source_route = route.clone();
            if let Some(object) = source_route.as_object_mut() {
                object.remove("authorityRoot");
                object.remove("routeRoot");
                object.remove("status");
            }
            if digest(&source_route) != route["routeRoot"].as_str().unwrap_or_default() {
                diagnostics.push(PackDiagnostic::error(
                    "route-root",
                    format!("/routes/{}", route["id"].as_str().unwrap_or_default()),
                    "route root does not match route declaration",
                ));
            }
            let expected_status = if route["nodes"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or(&[])
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|id| nodes.get(id))
                .any(|node| {
                    matches!(
                        node["verification"]["status"].as_str(),
                        Some("stale" | "invalidated")
                    )
                }) {
                "stale"
            } else {
                "current"
            };
            if route["status"] != expected_status {
                diagnostics.push(PackDiagnostic::error(
                    "route-status",
                    format!("/routes/{}", route["id"].as_str().unwrap_or_default()),
                    "route status does not match selected node status",
                ));
            }
            groups
                .entry(route["parityGroup"].as_str().unwrap_or_default())
                .or_default()
                .push(route);
        }
    }
    for (group, routes) in groups {
        if routes.len() != 2
            || routes
                .iter()
                .map(|route| route["audience"].as_str())
                .collect::<BTreeSet<_>>()
                .len()
                != 2
            || routes[0]["authorityRoot"] != routes[1]["authorityRoot"]
            || routes[0]["status"] != routes[1]["status"]
        {
            diagnostics.push(PackDiagnostic::error(
                "route-parity",
                "/routes",
                format!("parity group {group} does not preserve dual-first authority"),
            ));
        }
    }
    if let (Some(nodes), Some(edges), Some(routes)) = (
        pack["nodes"].as_array(),
        pack["edges"].as_array(),
        pack["routes"].as_array(),
    ) {
        let (coverage, _) = coverage_index(nodes, edges, routes);
        if coverage != pack["coverage"] {
            diagnostics.push(PackDiagnostic::error(
                "coverage-index",
                "/coverage",
                "coverage index does not match the authority graph",
            ));
        }
    }
    diagnostics
}

pub fn inspect_pack_value(pack: &Value) -> Result<String, String> {
    let statuses: BTreeMap<String, usize> = pack["nodes"]
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .fold(BTreeMap::new(), |mut counts, node| {
            let status = node
                .pointer("/verification/status")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned();
            *counts.entry(status).or_default() += 1;
            counts
        });
    Ok(stable_json(&json!({
        "schema": "xinfa.context-pack-inspection/v1",
        "project": pack["project"],
        "cut": pack["cut"],
        "visibility": pack["visibility"],
        "roots": pack["roots"],
        "counts": {
            "sources": pack["inventory"].as_array().map(Vec::len).unwrap_or(0),
            "nodes": pack["nodes"].as_array().map(Vec::len).unwrap_or(0),
            "edges": pack["edges"].as_array().map(Vec::len).unwrap_or(0),
            "routes": pack["routes"].as_array().map(Vec::len).unwrap_or(0),
        },
        "statuses": statuses,
        "coverage": {
            "claims": pack.pointer("/coverage/claims").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
            "orphans": pack.pointer("/coverage/orphans").cloned().unwrap_or_else(|| json!([])),
        },
        "diagnostics": pack["diagnostics"],
    })))
}

pub fn verify_pack_artifacts(
    pack_bytes: &[u8],
    manifest_bytes: Option<&[u8]>,
    receipt_bytes: Option<&[u8]>,
) -> Result<(String, bool), String> {
    let pack: Value = serde_json::from_slice(pack_bytes)
        .map_err(|error| format!("invalid pack JSON: {error}"))?;
    let mut diagnostics = verify_value(&pack);
    match (manifest_bytes, receipt_bytes) {
        (Some(manifest_bytes), Some(receipt_bytes)) => {
            let manifest: Value = serde_json::from_slice(manifest_bytes)
                .map_err(|error| format!("invalid manifest JSON: {error}"))?;
            if manifest["schema"] != "xinfa.context-pack-manifest/v1"
                || manifest["packRoot"] != pack["roots"]["pack"]
                || manifest["artifacts"][0]["contentRoot"] != byte_digest(pack_bytes)
                || manifest["artifacts"][0]["size"].as_u64() != Some(pack_bytes.len() as u64)
            {
                diagnostics.push(PackDiagnostic::error(
                    "artifact-root",
                    "/artifacts/0",
                    "manifest does not bind the exact pack.json artifact",
                ));
            }
            let mut manifest_core = manifest.clone();
            manifest_core
                .as_object_mut()
                .and_then(|object| object.remove("manifestRoot"));
            if digest(&manifest_core) != manifest["manifestRoot"].as_str().unwrap_or_default() {
                diagnostics.push(PackDiagnostic::error(
                    "manifest-root",
                    "/manifestRoot",
                    "manifest root does not match content",
                ));
            }
            let receipt: Value = serde_json::from_slice(receipt_bytes)
                .map_err(|error| format!("invalid receipt JSON: {error}"))?;
            if receipt["schema"] != "xinfa.context-pack-compile-receipt/v1"
                || receipt["verdict"] != "pass"
                || receipt["packRoot"] != pack["roots"]["pack"]
                || receipt["manifestRoot"] != manifest["manifestRoot"]
                || receipt["qualifying"] != false
                || receipt["selfCertified"] != false
            {
                diagnostics.push(PackDiagnostic::error(
                    "receipt-binding",
                    "/receipt",
                    "compile receipt does not bind the verified Pack and manifest",
                ));
            }
            let mut receipt_core = receipt.clone();
            receipt_core
                .as_object_mut()
                .and_then(|object| object.remove("receiptRoot"));
            if digest(&receipt_core) != receipt["receiptRoot"].as_str().unwrap_or_default() {
                diagnostics.push(PackDiagnostic::error(
                    "receipt-root",
                    "/receiptRoot",
                    "receipt root does not match content",
                ));
            }
        }
        (None, None) => {}
        _ => {
            return Err("pack verification requires both manifest and receipt artifacts".to_owned())
        }
    }
    diagnostics.sort_by(|left, right| (&left.path, &left.code).cmp(&(&right.path, &right.code)));
    let valid = diagnostics.is_empty();
    let receipt = json!({
        "schema": "xinfa.context-pack-verification-receipt/v1",
        "valid": valid,
        "qualifying": false,
        "selfCertified": false,
        "packRoot": pack.pointer("/roots/pack"),
        "diagnostics": diagnostics_value(&diagnostics),
    });
    Ok((stable_json(&receipt), valid))
}
