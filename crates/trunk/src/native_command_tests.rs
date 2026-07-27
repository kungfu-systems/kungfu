// SPDX-License-Identifier: Apache-2.0

use super::NATIVE_COMMANDS;

#[test]
fn native_command_table_is_unique_and_complete() {
    let mut names: Vec<_> = NATIVE_COMMANDS.iter().map(|spec| spec.name).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), NATIVE_COMMANDS.len());
    assert_eq!(
        names,
        vec![
            "compact-plan",
            "doctor",
            "env",
            "fsck",
            "gc-plan",
            "prewarm",
            "repair-plan",
            "shifu",
            "storage-status",
            "verify",
            "xinfa",
        ]
    );
}
