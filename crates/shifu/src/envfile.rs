// SPDX-License-Identifier: Apache-2.0
//
// build-local.env loading — same two-layer model as the sh / cmd entrypoints:
// the user-global file first, then the optional repo-root override on top.
// Values are exported into this process's environment and therefore inherited
// by everything the launcher spawns.
//
// The parser accepts the file's documented shape (`export KEY='VALUE'` lines,
// optionally unquoted or double-quoted). It deliberately does not execute
// shell, matching the cmd entrypoint's pure parser rather than sh `source`.

use std::path::Path;

use crate::util;

/// Load the two-layer config: the user-global file always (rootless verbs
/// like `promote` and `builds` read configuration too), the repo-root
/// override only inside a checkout.
pub fn load(repo_root: Option<&Path>) {
    let user_global = util::xdg_dir("XDG_CONFIG_HOME", ".config")
        .join("kungfu")
        .join("build-local.env");
    apply_file(&user_global);
    if let Some(root) = repo_root {
        apply_file(&root.join("build-local.env"));
    }
}

fn apply_file(path: &Path) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    for line in text.lines() {
        if let Some((key, value)) = parse_line(line) {
            std::env::set_var(key, value);
        }
    }
}

pub(crate) fn parse_line(line: &str) -> Option<(&str, &str)> {
    let s = line.trim_start();
    if s.is_empty() || s.starts_with('#') {
        return None;
    }
    let s = s.strip_prefix("export ").map(str::trim_start).unwrap_or(s);
    let (key, value) = s.split_once('=')?;
    let key = key.trim_end();
    if key.is_empty()
        || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        || key.starts_with(|c: char| c.is_ascii_digit())
    {
        return None;
    }
    let mut value = value.trim();
    if value.len() >= 2
        && ((value.starts_with('\'') && value.ends_with('\''))
            || (value.starts_with('"') && value.ends_with('"')))
    {
        value = &value[1..value.len() - 1];
    }
    Some((key, value))
}

#[cfg(test)]
mod tests {
    use super::parse_line;

    #[test]
    fn parses_documented_shapes() {
        assert_eq!(
            parse_line("export FNM_NODE_DIST_MIRROR='https://example/node/'"),
            Some(("FNM_NODE_DIST_MIRROR", "https://example/node/"))
        );
        assert_eq!(
            parse_line("KUNGFU_BUILD_JOBS=\"12\""),
            Some(("KUNGFU_BUILD_JOBS", "12"))
        );
        assert_eq!(parse_line("PLAIN=value"), Some(("PLAIN", "value")));
    }

    #[test]
    fn rejects_comments_blanks_and_junk() {
        assert_eq!(parse_line("# export A=b"), None);
        assert_eq!(parse_line("   "), None);
        assert_eq!(parse_line("not a var line"), None);
        assert_eq!(parse_line("1BAD=x"), None);
        assert_eq!(parse_line("BAD KEY=x"), None);
    }
}
