extern crate shifu;

use kungfu::runtime;

const PRIVATE_PATH: &str = "../framework/core";

pub fn compile() {
    runtime::start();
    println!("{PRIVATE_PATH}");
}
