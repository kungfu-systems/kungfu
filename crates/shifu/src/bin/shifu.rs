// SPDX-License-Identifier: Apache-2.0

use std::env;

fn main() {
    let arguments: Vec<String> = env::args().skip(1).collect();
    shifu::main_and_exit(&arguments, shifu::InvocationContext::standalone())
}
