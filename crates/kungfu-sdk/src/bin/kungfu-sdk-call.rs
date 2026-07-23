// SPDX-License-Identifier: Apache-2.0

use kungfu_sdk::generated::{runtime_action_v1, work_lifecycle_v1};
use kungfu_sdk::{ActionBindingRoots, NativeStorage, WireResponse, REQUIRED_CAPABILITIES};
use serde_json::json;
use std::env;
use std::process::ExitCode;
use std::thread;
use std::time::Duration;

fn qualification_hold() -> Result<(), Box<dyn std::error::Error>> {
    if let Ok(milliseconds) = env::var("KUNGFU_QUALIFICATION_HOLD_MS") {
        thread::sleep(Duration::from_millis(milliseconds.parse()?));
    }
    Ok(())
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let runtime_dir = args
        .next()
        .ok_or("usage: kungfu-sdk-call RUNTIME_DIR OPERATION REQUEST_JSON")?;
    let operation = args
        .next()
        .ok_or("usage: kungfu-sdk-call RUNTIME_DIR OPERATION REQUEST_JSON")?;
    let request_json = args
        .next()
        .ok_or("usage: kungfu-sdk-call RUNTIME_DIR OPERATION REQUEST_JSON")?;
    if args.next().is_some() {
        return Err("usage: kungfu-sdk-call RUNTIME_DIR OPERATION REQUEST_JSON".into());
    }

    if operation == "__runtime_action_projection_semantic__" {
        let root = format!("sha256:{}", "a".repeat(64));
        let bytes = match request_json.as_str() {
            "reordered-envelope" => format!(
                r#"{{"schema":"kungfu.action-runtime.result/v1","result":{{"geometryRoot":"{root}"}}}}"#
            ),
            "whitespace-envelope" => format!(
                r#"{{ "result" : {{ "geometryRoot" : "{root}" }}, "schema" : "kungfu.action-runtime.result/v1" }}"#
            ),
            _ => return Err("unsupported projection-semantic case".into()),
        };
        let result = runtime_action_v1::parse_geometry_root(WireResponse {
            protocol_id: "kungfu.runtime.action".to_owned(),
            protocol_version: 1,
            schema_ref: "kungfu.action-runtime.result/v1".to_owned(),
            encoding: "application/json".to_owned(),
            bytes: bytes.into_bytes(),
        })?;
        println!(
            "{}",
            json!({
                "geometryRoot": result.geometry_root,
                "bytesHex": hex(&result.wire.bytes),
            })
        );
        qualification_hold()?;
        return Ok(());
    }
    if operation == "__runtime_action_projection_negative__" {
        let root = format!("sha256:{}", "a".repeat(64));
        let mut wire = WireResponse {
            protocol_id: "kungfu.runtime.action".to_owned(),
            protocol_version: 1,
            schema_ref: "kungfu.action-runtime.result/v1".to_owned(),
            encoding: "application/json".to_owned(),
            bytes: format!(
                r#"{{"result":{{"geometryRoot":"{root}"}},"schema":"kungfu.action-runtime.result/v1"}}"#
            )
            .into_bytes(),
        };
        match request_json.as_str() {
            "wrong-metadata" => {
                wire.schema_ref = "kungfu.action-runtime.wrong/v1".to_owned();
            }
            "extra-result-field" => {
                wire.bytes = format!(
                    r#"{{"result":{{"geometryRoot":"{root}","unexpected":true}},"schema":"kungfu.action-runtime.result/v1"}}"#
                )
                .into_bytes();
            }
            "wrong-layer" => {
                wire.bytes = format!(r#"{{"geometryRoot":"{root}"}}"#).into_bytes();
            }
            "schema-punctuation-mutation" => {
                wire.bytes = format!(
                    r#"{{"result":{{"geometryRoot":"{root}"}},"schema":"kungfuXaction-runtimeXresult/v1"}}"#
                )
                .into_bytes();
            }
            "short-root" => {
                wire.bytes = br#"{"result":{"geometryRoot":"sha256:a"},"schema":"kungfu.action-runtime.result/v1"}"#
                    .to_vec();
            }
            "trailing-comma" => {
                wire.bytes = format!(
                    r#"{{"result":{{"geometryRoot":"{root}"}},"schema":"kungfu.action-runtime.result/v1",}}"#
                )
                .into_bytes();
            }
            _ => return Err("unsupported projection-negative case".into()),
        }
        if runtime_action_v1::parse_geometry_root(wire).is_err() {
            println!(r#"{{"rejected":true}}"#);
            qualification_hold()?;
            return Ok(());
        }
        return Err("generated projection accepted an invalid response".into());
    }

    let mut storage = NativeStorage::open(runtime_dir)?;
    if env::var_os("KUNGFU_FACT_CUT_ROOT").is_some() {
        let root = |name: &'static str| -> Result<String, Box<dyn std::error::Error>> {
            Ok(env::var(name)
                .map_err(|_| format!("{name} is required when opening an ActionBinding"))?)
        };
        let roots = [
            root("KUNGFU_FACT_CUT_ROOT")?,
            root("KUNGFU_PURSUIT_ROOT")?,
            root("KUNGFU_ATLAS_ROOT")?,
            root("KUNGFU_WARRANT_ROOT")?,
            root("KUNGFU_CANDIDATE_ACTION_ROOT")?,
            root("KUNGFU_PRECONDITIONS_ROOT")?,
            root("KUNGFU_RESOURCES_ROOT")?,
        ];
        storage.bind_action(&ActionBindingRoots {
            fact_cut_root: &roots[0],
            pursuit_root: &roots[1],
            atlas_root: &roots[2],
            warrant_root: &roots[3],
            candidate_action_root: &roots[4],
            preconditions_root: &roots[5],
            resources_root: &roots[6],
        })?;
    }
    if operation == "__runtime_action_wire__" || operation == "__runtime_action_geometry_root__" {
        let typed = if operation == "__runtime_action_geometry_root__" {
            Some(runtime_action_v1::geometry_root(&mut storage)?)
        } else {
            None
        };
        let wire = match typed.as_ref() {
            Some(value) => &value.wire,
            None => {
                let value = storage.call_runtime_action_json(&request_json)?;
                println!(
                    "{}",
                    json!({
                        "protocolId": value.protocol_id,
                        "protocolVersion": value.protocol_version,
                        "schemaRef": value.schema_ref,
                        "encoding": value.encoding,
                        "bytesHex": hex(&value.bytes),
                    })
                );
                qualification_hold()?;
                return Ok(());
            }
        };
        println!(
            "{}",
            json!({
                "protocolId": wire.protocol_id,
                "protocolVersion": wire.protocol_version,
                "schemaRef": wire.schema_ref,
                "encoding": wire.encoding,
                "bytesHex": hex(&wire.bytes),
                "geometryRoot": typed.as_ref().map(|value| value.geometry_root.as_str()),
            })
        );
        qualification_hold()?;
        return Ok(());
    }
    if operation == "__work_lifecycle_runtime__" {
        let request: serde_json::Value = serde_json::from_str(&request_json)?;
        let wire =
            if request.get("mode").and_then(serde_json::Value::as_str) == Some("capabilities") {
                work_lifecycle_v1::capabilities(&mut storage)
            } else {
                work_lifecycle_v1::invoke(
                    &mut storage,
                    request
                        .get("operationId")
                        .and_then(serde_json::Value::as_str)
                        .ok_or("Work lifecycle operationId is required")?,
                    request.get("input").cloned().unwrap_or_else(|| json!({})),
                    request
                        .get("execute")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                )
            };
        match wire {
            Ok(value) => println!(
                "{}",
                json!({
                    "protocolId": value.protocol_id,
                    "protocolVersion": value.protocol_version,
                    "schemaRef": value.schema_ref,
                    "encoding": value.encoding,
                    "bytesHex": hex(&value.bytes),
                })
            ),
            Err(error) => println!("{}", json!({ "rawError": error.to_string() })),
        }
        qualification_hold()?;
        return Ok(());
    }
    let capabilities = storage.capabilities()?;
    if capabilities & REQUIRED_CAPABILITIES != REQUIRED_CAPABILITIES {
        return Err(format!("incomplete native capability mask: {capabilities:#x}").into());
    }
    println!("{}", storage.execute_json(&operation, &request_json)?);
    qualification_hold()?;
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(DIGITS[(byte >> 4) as usize] as char);
        result.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    result
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("kungfu-sdk-call: {error}");
            ExitCode::FAILURE
        }
    }
}
