// SPDX-License-Identifier: Apache-2.0

use kungfu_sdk::{NativeStorage, REQUIRED_CAPABILITIES};
use std::env;
use std::process::ExitCode;

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
    let capabilities = storage.capabilities()?;
    if capabilities & REQUIRED_CAPABILITIES != REQUIRED_CAPABILITIES {
        return Err(format!("incomplete native capability mask: {capabilities:#x}").into());
    }
    println!("{}", storage.execute_json(&operation, &request_json)?);
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
