// SPDX-License-Identifier: Apache-2.0

use kungfu_sdk::{ActionBindingRoots, NativeStorage, REQUIRED_CAPABILITIES};
use std::env;
use std::process::ExitCode;
use std::thread;
use std::time::Duration;

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
    let capabilities = storage.capabilities()?;
    if capabilities & REQUIRED_CAPABILITIES != REQUIRED_CAPABILITIES {
        return Err(format!("incomplete native capability mask: {capabilities:#x}").into());
    }
    println!("{}", storage.execute_json(&operation, &request_json)?);
    if let Ok(milliseconds) = env::var("KUNGFU_QUALIFICATION_HOLD_MS") {
        thread::sleep(Duration::from_millis(milliseconds.parse()?));
    }
    Ok(())
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
