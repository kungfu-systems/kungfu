// SPDX-License-Identifier: Apache-2.0

use super::*;

#[derive(Default)]
struct ListOptions {
    verbose: bool,
    json: bool,
    no_truncate: bool,
    verify_current: bool,
}

fn print_builds_json(entries: &[BuildEntry], payload_verified: bool) {
    let installed = installed_sha();
    println!("{{");
    println!("  \"schema\": \"shifu.local-artifact-catalog/v1\",");
    println!("  \"product\": \"kungfu\",");
    println!("  \"platform\": \"{}\",", json_escape(&host::os_arch()));
    println!("  \"artifacts\": [");
    let rows: Vec<_> = entries
        .iter()
        .map(|entry| {
            let relation = build_relation(entry, &installed, entries.len());
            let valid = if payload_verified {
                current_payload_valid(entry)
            } else {
                build_recorded_valid(entry)
            };
            let state = state_for(relation, valid, false);
            format!(
                "    {{\"id\":\"{}\",\"kind\":\"{}\",\"version\":\"{}\",\"commit\":\"{}\",\"branch\":\"{}\",\"digest\":\"{}\",\"releaseCutRoot\":\"{}\",\"platformSliceRoot\":\"{}\",\"cliArchivePath\":\"{}\",\"cliArchiveDigest\":\"{}\",\"upgradeManifestPath\":\"{}\",\"upgradeManifestDigest\":\"{}\",\"builtAt\":\"{}\",\"state\":\"{}\",\"relation\":\"{}\",\"automatic\":{},\"rollbackOnly\":false,\"integrity\":\"{}\",\"dirty\":{},\"qualified\":{},\"integrated\":{},\"mainlineRef\":\"{}\",\"mainlineCommit\":\"{}\",\"repoPath\":\"{}\",\"worktreePath\":\"{}\",\"buildPath\":\"{}\",\"artifactPath\":\"{}\",\"pathDigest\":\"\",\"reason\":\"{}\"}}",
                json_escape(&entry.name),
                json_escape(schema_kind(entry)),
                json_escape(&entry.product_version),
                json_escape(&entry.sha),
                json_escape(&entry.branch),
                json_escape(&entry.digest),
                json_escape(&entry.release_cut_root),
                json_escape(&entry.platform_slice_root),
                json_escape(&entry.slot.join(&entry.cli_archive).display().to_string()),
                json_escape(&entry.cli_archive_digest),
                json_escape(
                    &entry
                        .slot
                        .join(&entry.upgrade_manifest)
                        .display()
                        .to_string()
                ),
                json_escape(&entry.upgrade_manifest_digest),
                json_escape(&entry.built_at),
                state.as_str(),
                relation.as_str(),
                automatic(relation, valid, false),
                if payload_verified {
                    "verified"
                } else {
                    "recorded"
                },
                entry.sha.ends_with("-dirty"),
                entry.qualified,
                entry.integrated,
                json_escape(&entry.mainline_ref),
                json_escape(&entry.mainline_sha),
                json_escape(&entry.repo),
                json_escape(&entry.worktree),
                json_escape(&entry.worktree),
                json_escape(&entry.slot.join(&entry.artifact).display().to_string()),
                relation.as_str()
            )
        })
        .collect();
    println!("{}", rows.join(",\n"));
    println!("  ]");
    println!("}}");
}

fn parse_list_options(args: &[String]) -> ListOptions {
    let mut options = ListOptions::default();
    for arg in args {
        match arg.as_str() {
            "--verbose" => options.verbose = true,
            "--json" => options.json = true,
            "--no-truncate" => options.no_truncate = true,
            "--verify-current" => options.verify_current = true,
            _ => util::die(
                "usage: shifu builds [--verbose] [--json] [--no-truncate] [--verify-current]",
            ),
        }
    }
    options
}

fn selected_build_entries(root: Option<&Path>, verify_current: bool) -> Vec<BuildEntry> {
    if verify_current {
        let root =
            root.unwrap_or_else(|| util::die("--verify-current requires a Kungfu source checkout"));
        let expected_sha = git_head(root);
        let entry = current_entry_at(root, &registry_dir(), &expected_sha)
            .unwrap_or_else(|error| util::die(&error));
        if !current_payload_valid(&entry) {
            util::die(&format!(
                "current registered build {} failed exact payload verification",
                entry.name
            ));
        }
        vec![entry]
    } else {
        entries()
    }
}

fn print_human_builds(entries: &[BuildEntry], options: &ListOptions) {
    let installed = installed_sha();
    println!(
        "{}",
        style::cyan(&format!(
            "Registered dev builds ({}, newest first):",
            host::os_arch()
        ))
    );
    for (index, entry) in entries.iter().enumerate() {
        let relation = build_relation(entry, &installed, entries.len());
        let valid = if options.verify_current {
            current_payload_valid(entry)
        } else {
            build_recorded_valid(entry)
        };
        let state = state_for(relation, valid, false);
        println!(
            "  {} {:10} {:9} {:34} {:10}",
            style::bold(&format!("[{index}]")),
            state.as_str(),
            short_sha(&entry.sha),
            compact_branch(&entry.branch, options.no_truncate),
            relation.as_str(),
        );
        if options.verbose {
            print_build_detail(entry);
        }
    }
    println!(
        "\n{} shifu promote installs the unique descendant; use --build <id> for manual selection",
        style::cyan("Next:")
    );
}

fn print_build_detail(entry: &BuildEntry) {
    let worktree_state = if Path::new(&entry.worktree).is_dir() {
        ""
    } else {
        " (worktree cleaned; stash still usable)"
    };
    println!(
        "      id={} built={} kind={} digest={}\n      artifact={}\n      repo={}\n      worktree={}{}",
        entry.name,
        entry.built_at,
        entry.kind,
        if entry.digest.is_empty() {
            "unknown"
        } else {
            &entry.digest
        },
        entry.slot.join(&entry.artifact).display(),
        if entry.repo.is_empty() {
            "unknown"
        } else {
            &entry.repo
        },
        entry.worktree,
        worktree_state
    );
}

pub fn run_builds(root: Option<&Path>, args: &[String]) -> ! {
    let options = parse_list_options(args);
    let entries = selected_build_entries(root, options.verify_current);
    if entries.is_empty() {
        no_builds_hint();
    }
    if options.json {
        print_builds_json(&entries, options.verify_current);
        std::process::exit(0);
    }
    print_human_builds(&entries, &options);
    std::process::exit(0)
}
