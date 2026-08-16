// SPDX-License-Identifier: Apache-2.0
//
// Unified `--help` rendered from a declarative manifest (KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 stage 3/4).
//
// `kungfu --help` should expose the first-layer Project → Work → Agent model
// without waking a satellite — the front door stays usable (and fast) even
// when the domain runtime is broken
// (KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05 driver 1). The complete command
// surface remains discoverable through `--help-all` and `--help-section`. The
// command surface lives in the Python click tree, so it is introspected once at
// build time into a small tagged-line manifest shipped next to the binary
// (dist/kungfu/help-manifest.txt); the trunk reads and renders it here,
// initializing no Python.
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
//   PROJECTION <schema> <projection-root> <contract-root> <registry-root>
//   OPT     <flags>         <summary>
//   SECTION <id>    <title>          <summary>
//   CMD     <name>  <summary>        <priority> <section> <visibility>
//           <availability> <reason>
//   ROOTOPT <name>  <arity>  <envvar> <comma-separated flags> <choices>
// Records may arrive in any order; the trunk groups and sorts them.

use std::env;
use std::fs;
use std::path::PathBuf;

/// The generated manifest shipped next to the front-door binary.
const MANIFEST_FILE: &str = "help-manifest.txt";

/// Default help-ordering priority (mirrors the click PrioritizedCommandGroup
/// default) for commands whose record omits one.
const DEFAULT_PRIORITY: u32 = 100;

/// Help metadata for one command implemented by the Rust trunk. The caller
/// supplies this from the same table used for dispatch, so discovery cannot
/// drift from execution when another native command lands.
pub struct NativeCommandHelp {
    pub name: &'static str,
    pub summary: &'static str,
    pub section: &'static str,
    pub visibility: &'static str,
}

/// Machine-readable root option emitted from the live Click group. The trunk
/// uses these records only while routing to a native command; domain command
/// arguments remain opaque and are forwarded byte-for-byte.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootOption {
    pub name: String,
    pub arity: usize,
    pub envvar: Option<String>,
    pub flags: Vec<String>,
    pub choices: Vec<String>,
}

struct Command {
    name: String,
    summary: String,
    priority: u32,
    section: String,
    visibility: String,
    availability: String,
    reason: String,
}

struct Section {
    id: String,
    title: String,
    summary: String,
}

/// Render the unified `kungfu` help from the shipped manifest, or `None` if the
/// manifest is not present (the caller then falls through to the Python CLI help).
pub fn render(native_commands: &[NativeCommandHelp]) -> Option<String> {
    Some(render_from(&manifest_text()?, native_commands))
}

/// Return the product version recorded by the assembled runtime manifest.
/// A bare development trunk may not have a manifest; the caller owns that
/// informational fallback.
pub fn version() -> Option<String> {
    manifest_text()?.lines().find_map(|line| {
        let mut fields = line.trim_end_matches(['\r', '\n']).split('\t');
        (fields.next() == Some("VERSION"))
            .then(|| fields.next().map(str::to_string))
            .flatten()
    })
}

/// Load the generated root-routing contract. Absence is tolerated for a bare
/// development binary; assembled product builds make generation mandatory.
pub fn root_options() -> Option<Vec<RootOption>> {
    Some(parse_root_options(&manifest_text()?))
}

fn manifest_path() -> Option<PathBuf> {
    Some(env::current_exe().ok()?.parent()?.join(MANIFEST_FILE))
}

fn manifest_text() -> Option<String> {
    fs::read_to_string(manifest_path()?).ok()
}

fn parse_root_options(text: &str) -> Vec<RootOption> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.trim_end_matches(['\r', '\n']).split('\t');
            if fields.next() != Some("ROOTOPT") {
                return None;
            }
            let name = fields.next()?.to_string();
            let arity = fields.next()?.parse().ok()?;
            let envvar = fields
                .next()
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let flags = fields
                .next()
                .unwrap_or("")
                .split(',')
                .filter(|flag| !flag.is_empty())
                .map(str::to_string)
                .collect();
            let choices = fields
                .next()
                .unwrap_or("")
                .split(',')
                .filter(|choice| !choice.is_empty())
                .map(str::to_string)
                .collect();
            Some(RootOption {
                name,
                arity,
                envvar,
                flags,
                choices,
            })
        })
        .collect()
}

fn render_from(text: &str, native_commands: &[NativeCommandHelp]) -> String {
    let width = env::var("COLUMNS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(100)
        .max(60);
    render_from_with_width(text, native_commands, width)
}

fn render_from_with_width(
    text: &str,
    native_commands: &[NativeCommandHelp],
    width: usize,
) -> String {
    let mut version: Option<String> = None;
    let mut progressive_projection = false;
    let mut options: Vec<(String, String)> = Vec::new();
    let mut commands: Vec<Command> = Vec::new();
    let mut sections: Vec<Section> = Vec::new();

    for line in text.lines() {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split('\t');
        match fields.next() {
            Some("VERSION") => version = fields.next().map(str::to_string),
            Some("PROJECTION") => progressive_projection = true,
            Some("OPT") => {
                if let (Some(flags), summary) = (fields.next(), fields.next().unwrap_or("")) {
                    options.push((flags.to_string(), summary.to_string()));
                }
            }
            Some("SECTION") => {
                if let Some(id) = fields.next() {
                    sections.push(Section {
                        id: id.to_string(),
                        title: fields.next().unwrap_or(id).to_string(),
                        summary: fields.next().unwrap_or("").to_string(),
                    });
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
                        section: fields
                            .next()
                            .unwrap_or("advanced-compatibility")
                            .to_string(),
                        visibility: fields.next().unwrap_or("advanced").to_string(),
                        availability: fields.next().unwrap_or("available").to_string(),
                        reason: fields.next().unwrap_or("").to_string(),
                    });
                }
            }
            _ => {}
        }
    }

    // Merge the native command table used by dispatch. `env` is also present in
    // the Click manifest as a forwarding compatibility surface; de-duplicate it.
    for native in native_commands {
        if !commands.iter().any(|c| c.name == native.name) {
            commands.push(Command {
                name: native.name.to_string(),
                summary: native.summary.to_string(),
                priority: DEFAULT_PRIORITY,
                section: native.section.to_string(),
                visibility: native.visibility.to_string(),
                availability: "available".to_string(),
                reason: String::new(),
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
    if progressive_projection {
        out.push_str("\nproduct model: Project → Work → Agent\n");
    }

    let visible_options: Vec<_> = options
        .iter()
        .filter(|(flags, _)| !progressive_projection || is_first_layer_option(flags))
        .collect();
    if !visible_options.is_empty() {
        let label_width = visible_options
            .iter()
            .map(|(flags, _)| flags.len())
            .max()
            .unwrap_or(0)
            .min((width / 3).max(20));
        out.push_str("\noptions:\n");
        for (flags, summary) in visible_options {
            push_row(&mut out, flags, summary, label_width, width);
        }
    }

    if sections.is_empty() && !commands.is_empty() {
        sections.push(Section {
            id: "commands".to_string(),
            title: "COMMANDS".to_string(),
            summary: String::new(),
        });
        for command in &mut commands {
            command.section = "commands".to_string();
            command.visibility = "public".to_string();
        }
    }

    for section in &sections {
        let section_rows: Vec<_> = commands
            .iter()
            .filter(|command| command.section == section.id)
            .collect();
        let rows: Vec<_> = if progressive_projection {
            section_rows
                .into_iter()
                .filter(|command| command.visibility == "start-here")
                .collect()
        } else {
            section_rows
        };
        if progressive_projection && rows.is_empty() {
            continue;
        }
        let expanded = progressive_projection
            || rows
                .iter()
                .any(|command| matches!(command.visibility.as_str(), "start-here" | "public"));
        out.push_str(&format!("\n{}  [{}]\n", section.title, section.id));
        for line in wrap_words(&section.summary, width.saturating_sub(2).max(20)) {
            out.push_str(&format!("  {line}\n"));
        }
        if expanded {
            let label_width = rows
                .iter()
                .map(|command| command.name.len())
                .max()
                .unwrap_or(0)
                .min((width / 4).max(12));
            for command in rows {
                let summary = if command.availability == "available" {
                    command.summary.clone()
                } else {
                    format!(
                        "[{}: {}] {}",
                        command.availability, command.reason, command.summary
                    )
                };
                push_row(&mut out, &command.name, &summary, label_width, width);
            }
        } else {
            let hint = format!(
                "{} command families; expand with 'kungfu --help-section {}'.",
                rows.len(),
                section.id
            );
            for line in wrap_words(&hint, width.saturating_sub(2).max(20)) {
                out.push_str(&format!("  {line}\n"));
            }
        }
    }

    out.push_str("\ndiscovery:\n");
    for (label, summary) in [
        ("kungfu --help-all", "expand every command family"),
        (
            "kungfu --help-section <section>",
            "expand one stable section",
        ),
        ("kungfu --help-json", "emit the offline discovery contract"),
    ] {
        push_row(&mut out, label, summary, 34, width);
    }
    out.push_str("\nrun 'kungfu <command> --help' for command-specific help.\n");
    out
}

fn is_first_layer_option(flags: &str) -> bool {
    matches!(
        flags,
        "--help-all" | "--help-section SECTION" | "--help-json" | "-h, --help" | "--version"
    )
}

fn push_row(out: &mut String, label: &str, summary: &str, label_width: usize, width: usize) {
    if label.len() > label_width {
        out.push_str(&format!("  {label}\n"));
        for line in wrap_words(summary, width.saturating_sub(4).max(20)) {
            out.push_str(&format!("    {line}\n"));
        }
        return;
    }
    let prefix = format!("  {label:<label_width$}  ");
    let lines = wrap_words(summary, width.saturating_sub(prefix.len()).max(20));
    let mut lines = lines.into_iter();
    out.push_str(&format!("{}{}\n", prefix, lines.next().unwrap_or_default()));
    for line in lines {
        out.push_str(&format!("{}{}\n", " ".repeat(prefix.len()), line));
    }
}

fn wrap_words(text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        if !line.is_empty() && line.len() + 1 + word.len() > width {
            lines.push(line);
            line = String::new();
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(word);
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
# kungfu help manifest (generated; do not edit)
VERSION\t4.0.0-alpha.3
PROJECTION\tkungfu.cli-help-projection/v1\tsha256:projection\tsha256:contract\tsha256:registry
OPT\t-H, --home <path>\tkungfu runtime home folder
OPT\t--help-all\texpand every governed command family and exit
OPT\t--help-section SECTION\texpand one governed help section and exit
OPT\t--help-json\temit the offline discovery contract as JSON and exit
OPT\t-h, --help\tshow this help and exit
OPT\t--version\tshow the version and exit
SECTION\tstart-here\tSTART HERE\tBegin with a governed workspace.
SECTION\tsystem-maintenance\tSYSTEM & MAINTENANCE\tInspect and maintain runtime state.
SECTION\tadvanced-compatibility\tADVANCED & COMPATIBILITY\tSupported compatibility surfaces.
SECTION\tdeveloper\tDEVELOPER\tDeveloper-owned tools.
CMD\tenv\tmanage runtime environments\t10\tdeveloper\tadvanced\tavailable\t
CMD\ttrace\ttrace a running runtime\t100\tadvanced-compatibility\tadvanced\tavailable\t
CMD\tagent\tagent bridge\t100\tstart-here\tstart-here\tavailable\t
ROOTOPT\thome\t1\tKF_HOME\t-H,--home\t
ROOTOPT\tenv_verify_location\t0\tKF_VERIFY_LOCATION\t-ENV-verify-location\t
";

    const NATIVE: &[NativeCommandHelp] = &[
        NativeCommandHelp {
            name: "env",
            summary: "manage runtime environments",
            section: "developer",
            visibility: "advanced",
        },
        NativeCommandHelp {
            name: "doctor",
            summary: "read-only runtime inspection via the embedding membrane",
            section: "system-maintenance",
            visibility: "advanced",
        },
        NativeCommandHelp {
            name: "prewarm",
            summary: "pre-fetch the pinned uv + satellite CPython",
            section: "system-maintenance",
            visibility: "advanced",
        },
        NativeCommandHelp {
            name: "fsck",
            summary: "read-only storage integrity check via the embedding membrane",
            section: "system-maintenance",
            visibility: "advanced",
        },
    ];

    #[test]
    fn renders_version_options_and_sorted_commands() {
        let out = render_from(SAMPLE, NATIVE);
        assert!(out.contains("kungfu 4.0.0-alpha.3"));
        assert!(out.contains("usage: kungfu [options] <command>"));
        assert!(out.contains("product model: Project → Work → Agent"));
        assert!(!out.contains("-H, --home <path>"));
        assert!(out.contains("--help-all"));
        assert!(out.contains("START HERE  [start-here]"));
        assert!(out.contains("\n  agent "));
        assert!(!out.contains("SYSTEM & MAINTENANCE"));
        assert!(!out.contains("ADVANCED & COMPATIBILITY"));
        assert!(!out.contains("DEVELOPER"));
        assert!(!out.contains("\n  env "));
        assert!(!out.contains("\n  trace "));
        assert!(!out.contains("\n  doctor "));
    }

    #[test]
    fn merges_trunk_only_commands() {
        let out = render_from("CMD\tagent\tagent bridge\t100\n", NATIVE);
        // Every command in the dispatch table must be discoverable, including
        // fsck (the regression that prompted the shared source of truth).
        assert!(out.contains("\n  fsck "));
        assert!(out.contains("\n  doctor "));
        assert!(out.contains("\n  prewarm "));
    }

    #[test]
    fn does_not_duplicate_a_trunk_command_already_in_manifest() {
        let text = "CMD\tdoctor\tfrom manifest\t100\n";
        let out = render_from(text, NATIVE);
        assert_eq!(out.matches("\n  doctor ").count(), 1);
        assert!(out.contains("from manifest"));
    }

    #[test]
    fn width_changes_wrapping_without_ansi_output() {
        let narrow = render_from_with_width(SAMPLE, NATIVE, 60);
        let wide = render_from_with_width(SAMPLE, NATIVE, 120);
        assert_ne!(narrow, wide);
        assert!(!narrow.contains("\u{1b}["));
        assert!(narrow.lines().all(|line| line.len() <= 60));
    }

    #[test]
    fn ignores_comments_and_blank_lines() {
        let out = render_from("# just a comment\n\n\nVERSION\t1.2.3\n", NATIVE);
        assert!(out.contains("kungfu 1.2.3"));
    }

    #[test]
    fn parses_generated_root_routing_records() {
        assert_eq!(
            parse_root_options(SAMPLE),
            vec![
                RootOption {
                    name: "home".to_string(),
                    arity: 1,
                    envvar: Some("KF_HOME".to_string()),
                    flags: vec!["-H".to_string(), "--home".to_string()],
                    choices: vec![],
                },
                RootOption {
                    name: "env_verify_location".to_string(),
                    arity: 0,
                    envvar: Some("KF_VERIFY_LOCATION".to_string()),
                    flags: vec!["-ENV-verify-location".to_string()],
                    choices: vec![],
                },
            ]
        );
    }
}
