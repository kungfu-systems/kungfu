// SPDX-License-Identifier: Apache-2.0
//
// Unified `--help` rendered from a declarative manifest (ADR-0046 stage 3/4).
//
// `kungfu --help` should list the whole command surface without waking a
// satellite — the front door stays usable (and fast) even when the domain
// runtime is broken (ADR-0046 driver 1). The command surface lives in the Python
// click tree, so it is introspected once at build time into a small tagged-line
// manifest shipped next to the binary (dist/kungfu/help-manifest.txt); the trunk
// reads and renders it here, initializing no Python.
//
// It degrades gracefully: when the manifest is absent (a dev checkout without the
// assembled product), `render` returns None and the caller falls through to the
// launch path, where the Python CLI prints its own help. The manifest is the
// single source of truth — generated from the live click tree, never hand-authored
// (see framework/core/src/python/kungfu/cli/help_manifest.py and the assemble leg
// in run-freeze.js), so it cannot drift from the real CLI.
//
// Manifest format (tab-separated, one record per line; `#` comments and blank
// lines ignored):
//   VERSION <version>
//   OPT     <flags>         <summary>
//   CMD     <name>  <summary>        <priority>
// Records may arrive in any order; the trunk groups and sorts them.

use std::env;
use std::fs;
use std::path::PathBuf;

/// The generated manifest shipped next to the front-door binary.
const MANIFEST_FILE: &str = "help-manifest.txt";

/// Default help-ordering priority (mirrors the click PrioritizedCommandGroup
/// default) for commands whose record omits one.
const DEFAULT_PRIORITY: u32 = 100;

/// Commands the trunk owns natively and the Python click tree does not know about,
/// so they are not in the generated manifest. `env` is deliberately absent here:
/// it is a Python command that forwards to the trunk, so it already appears in the
/// manifest.
const TRUNK_ONLY_COMMANDS: &[(&str, &str)] = &[
    (
        "doctor",
        "read-only runtime inspection via the embedding membrane",
    ),
    ("prewarm", "pre-fetch the pinned uv + satellite CPython"),
];

struct Command {
    name: String,
    summary: String,
    priority: u32,
}

/// Render the unified `kungfu` help from the shipped manifest, or `None` if the
/// manifest is not present (the caller then falls through to the Python CLI help).
pub fn render() -> Option<String> {
    let manifest = manifest_path()?;
    let text = fs::read_to_string(&manifest).ok()?;
    Some(render_from(&text))
}

fn manifest_path() -> Option<PathBuf> {
    Some(env::current_exe().ok()?.parent()?.join(MANIFEST_FILE))
}

fn render_from(text: &str) -> String {
    let mut version: Option<String> = None;
    let mut options: Vec<(String, String)> = Vec::new();
    let mut commands: Vec<Command> = Vec::new();

    for line in text.lines() {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split('\t');
        match fields.next() {
            Some("VERSION") => version = fields.next().map(str::to_string),
            Some("OPT") => {
                if let (Some(flags), summary) = (fields.next(), fields.next().unwrap_or("")) {
                    options.push((flags.to_string(), summary.to_string()));
                }
            }
            Some("CMD") => {
                if let Some(name) = fields.next() {
                    let summary = fields.next().unwrap_or("");
                    let priority = fields
                        .next()
                        .and_then(|p| p.parse().ok())
                        .unwrap_or(DEFAULT_PRIORITY);
                    commands.push(Command {
                        name: name.to_string(),
                        summary: summary.to_string(),
                        priority,
                    });
                }
            }
            _ => {}
        }
    }

    // Merge the trunk-only commands the manifest cannot know about.
    for (name, summary) in TRUNK_ONLY_COMMANDS {
        if !commands.iter().any(|c| c.name == *name) {
            commands.push(Command {
                name: (*name).to_string(),
                summary: (*summary).to_string(),
                priority: DEFAULT_PRIORITY,
            });
        }
    }

    // Help order mirrors the click PrioritizedCommandGroup: by priority, then name.
    commands.sort_by(|a, b| {
        a.priority
            .cmp(&b.priority)
            .then_with(|| a.name.cmp(&b.name))
    });

    let mut out = String::new();
    match &version {
        Some(v) => out.push_str(&format!("kungfu {v}\n\n")),
        None => out.push_str("kungfu\n\n"),
    }
    out.push_str("usage: kungfu [options] <command> [<args>]\n");

    if !options.is_empty() {
        let width = options.iter().map(|(f, _)| f.len()).max().unwrap_or(0);
        out.push_str("\noptions:\n");
        for (flags, summary) in &options {
            out.push_str(&format!("  {flags:<width$}  {summary}\n"));
        }
    }

    if !commands.is_empty() {
        let width = commands.iter().map(|c| c.name.len()).max().unwrap_or(0);
        out.push_str("\ncommands:\n");
        for c in &commands {
            out.push_str(&format!(
                "  {name:<width$}  {summary}\n",
                name = c.name,
                summary = c.summary
            ));
        }
    }

    out.push_str("\nrun 'kungfu <command> --help' for command-specific help.\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
# kungfu help manifest (generated; do not edit)
VERSION\t4.0.0-alpha.0
OPT\t-H, --home <path>\tkungfu runtime home folder
OPT\t-h, --help\tshow this help and exit
CMD\tenv\tmanage runtime environments\t10
CMD\ttrace\ttrace a running runtime\t100
CMD\tagent\tagent bridge\t100
";

    #[test]
    fn renders_version_options_and_sorted_commands() {
        let out = render_from(SAMPLE);
        assert!(out.contains("kungfu 4.0.0-alpha.0"));
        assert!(out.contains("usage: kungfu [options] <command>"));
        assert!(out.contains("-H, --home <path>"));
        // env has priority 10, so it lists before the priority-100 commands.
        let env_at = out.find("\n  env ").unwrap();
        let trace_at = out.find("\n  trace ").unwrap();
        assert!(env_at < trace_at);
        // same priority (100) → alphabetical: agent before trace.
        let agent_at = out.find("\n  agent ").unwrap();
        assert!(agent_at < trace_at);
    }

    #[test]
    fn merges_trunk_only_commands() {
        let out = render_from(SAMPLE);
        // doctor/prewarm are not in the manifest but the trunk owns them.
        assert!(out.contains("\n  doctor "));
        assert!(out.contains("\n  prewarm "));
    }

    #[test]
    fn does_not_duplicate_a_trunk_command_already_in_manifest() {
        let text = "CMD\tdoctor\tfrom manifest\t100\n";
        let out = render_from(text);
        assert_eq!(out.matches("\n  doctor ").count(), 1);
        assert!(out.contains("from manifest"));
    }

    #[test]
    fn ignores_comments_and_blank_lines() {
        let out = render_from("# just a comment\n\n\nVERSION\t1.2.3\n");
        assert!(out.contains("kungfu 1.2.3"));
    }
}
