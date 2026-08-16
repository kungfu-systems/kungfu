// SPDX-License-Identifier: Apache-2.0

pub const SECONDARY_SOURCE_SIGNATURE: &str = "Kungfu UNGFU™";
pub const SOURCE_PRINCIPLE: &str = "Never Guess. Facts Unfold.";

pub fn version_banner(version: &str) -> String {
    format!("{version}\n{SECONDARY_SOURCE_SIGNATURE} · {SOURCE_PRINCIPLE}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_banner_preserves_the_version_first_line() {
        let banner = version_banner("4.0.0-alpha.3");
        let mut lines = banner.lines();
        assert_eq!(lines.next(), Some("4.0.0-alpha.3"));
        assert_eq!(
            lines.next(),
            Some("Kungfu UNGFU™ · Never Guess. Facts Unfold.")
        );
        assert_eq!(lines.next(), None);
    }
}
