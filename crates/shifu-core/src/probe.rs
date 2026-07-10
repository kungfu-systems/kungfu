// SPDX-License-Identifier: Apache-2.0
//
// Declarative environment probes — the diagnostic leg of the shifu role.
//
// Reports, never repairs: running a probe changes nothing about the machine.
// A probe that knows the exact fix names it in `repair_cmd`, and the reporter
// prints that command next to the failure — but executing a repair is a human
// (or explicit verb) decision, never a diagnostic side effect. This is
// framework discipline: do not add a probe that mutates state.
//
// A `Probe` declares label / probe (the check itself) / required / hint /
// repair_cmd; `run` evaluates it into a `Finding`; the reporting helpers
// render findings uniformly, so every bearer of the role — the dev launcher's
// doctor today, the product trunk's doctor next (ADR-0046) — speaks the same
// checklist language, and a new diagnostic need is a new probe, not a new
// checklist implementation.

use std::process::Command;

use crate::{host, style};

/// What a probe observed. `Present` / `Missing` carry pass/fail semantics;
/// `Info` is a context row — a fact worth showing that cannot fail.
pub enum Status {
    Present(String),
    Missing,
    Info(String),
}

pub struct Probe {
    pub label: &'static str,
    /// The check itself: pure observation, no side effects on the machine.
    pub probe: Box<dyn FnOnce() -> Status>,
    /// Required probes decide the exit code; optional ones only inform.
    pub required: bool,
    /// Where to get it or what the row means — shown on failure.
    pub hint: String,
    /// The exact command that fixes the failure, when one can be named
    /// precisely for this platform. Reported, never executed.
    pub repair_cmd: Option<String>,
}

/// The evaluated result of one probe: everything a reporter needs.
pub struct Finding {
    pub label: &'static str,
    pub status: Status,
    pub required: bool,
    pub hint: String,
    pub repair_cmd: Option<String>,
}

impl Probe {
    pub fn run(self) -> Finding {
        Finding {
            label: self.label,
            status: (self.probe)(),
            required: self.required,
            hint: self.hint,
            repair_cmd: self.repair_cmd,
        }
    }

    /// Canned probe: the first of `candidates` resolvable on PATH answers
    /// with its `--version` line as evidence.
    pub fn command_version(
        label: &'static str,
        candidates: &'static [&'static str],
        hint: &str,
        required: bool,
    ) -> Probe {
        Probe {
            label,
            probe: Box::new(move || {
                for name in candidates {
                    if host::find_on_path(name).is_some() {
                        if let Some(v) = version_line(name) {
                            return Status::Present(v);
                        }
                    }
                }
                Status::Missing
            }),
            required,
            hint: hint.to_string(),
            repair_cmd: None,
        }
    }

    pub fn with_repair(mut self, cmd: impl Into<String>) -> Probe {
        self.repair_cmd = Some(cmd.into());
        self
    }
}

pub fn run_all(probes: Vec<Probe>) -> Vec<Finding> {
    probes.into_iter().map(Probe::run).collect()
}

pub fn any_required_missing(findings: &[Finding]) -> bool {
    findings
        .iter()
        .any(|f| f.required && matches!(f.status, Status::Missing))
}

/// First non-empty line of `<program> --version` — the conventional evidence
/// for "present, at this version". `program` may be a bare name or a path.
pub fn version_line(program: &str) -> Option<String> {
    let out = Command::new(program).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    first_stdout_line(&out.stdout)
}

pub(crate) fn first_stdout_line(stdout: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(stdout);
    let line = text.lines().find(|l| !l.trim().is_empty())?;
    Some(line.trim().to_string())
}

/// Render one finding in the checklist voice all shifu doctors share.
pub fn print_finding(f: &Finding) {
    match &f.status {
        Status::Present(evidence) => {
            println!("  \u{2705} {:<14} {}", f.label, style::dim(evidence))
        }
        Status::Info(evidence) => println!("  \u{1f9f0} {:<14} {evidence}", f.label),
        Status::Missing if f.required => {
            println!(
                "  \u{274c} {:<14} {} - {}",
                f.label,
                style::red("not found"),
                style::yellow(&f.hint)
            );
            print_repair(f);
        }
        Status::Missing => {
            println!(
                "  \u{2796} {:<14} {} - {}",
                f.label,
                style::dim("not found"),
                style::dim(&f.hint)
            );
            print_repair(f);
        }
    }
}

fn print_repair(f: &Finding) {
    if let Some(cmd) = &f.repair_cmd {
        println!("     {} {}", style::dim("repair:"), style::bold(cmd));
    }
}
