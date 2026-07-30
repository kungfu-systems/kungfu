// SPDX-License-Identifier: Apache-2.0
//
// Minimal ANSI styling for launcher-owned output (usage, doctor, clone).
// std-only, and honest about where color belongs: enabled only when stdout is
// a terminal, NO_COLOR is unset, and TERM is not "dumb" — piped output stays
// plain text so scripts can parse it. Task output is untouched; only the few
// lines shifu itself speaks get styled.

use std::io::IsTerminal;
use std::sync::OnceLock;

fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var_os("NO_COLOR").is_none()
            && std::env::var("TERM").map(|t| t != "dumb").unwrap_or(true)
            && std::io::stdout().is_terminal()
    })
}

fn wrap(code: &str, text: &str) -> String {
    if enabled() {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.to_string()
    }
}

pub fn bold(text: &str) -> String {
    wrap("1", text)
}

pub fn dim(text: &str) -> String {
    wrap("2", text)
}

pub fn green(text: &str) -> String {
    wrap("32", text)
}

pub fn red(text: &str) -> String {
    wrap("31", text)
}

pub fn yellow(text: &str) -> String {
    wrap("33", text)
}

pub fn cyan(text: &str) -> String {
    wrap("36", text)
}
