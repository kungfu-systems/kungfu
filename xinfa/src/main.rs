// SPDX-License-Identifier: Apache-2.0

use std::env;
use std::process::ExitCode;

fn main() -> ExitCode {
    let arguments: Vec<String> = env::args().skip(1).collect();
    xinfa::cli::main_entry(&arguments)
}
