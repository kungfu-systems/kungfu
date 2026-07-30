// SPDX-License-Identifier: Apache-2.0

pub(crate) fn run(arguments: &[String]) -> ! {
    shifu::main_and_exit(arguments, shifu::InvocationContext::embedded_kungfu())
}
