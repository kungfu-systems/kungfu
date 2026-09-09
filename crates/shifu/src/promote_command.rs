// SPDX-License-Identifier: Apache-2.0

//! Promotion CLI parsing, candidate selection, and transaction orchestration.

use super::*;

const PROMOTE_USAGE: &str =
    "usage: shifu promote [--build <id> [--preview] [--allow-nonlinear] | --rollback | --adopt-installed --build <id>] [--check] [--launch] [--force]";

#[derive(Default)]
struct PromoteOptions {
    launch: bool,
    force: bool,
    check: bool,
    rollback: bool,
    preview: bool,
    adopt_installed: bool,
    allow_nonlinear: bool,
    build_arg: Option<String>,
}

struct InstalledProduct {
    sha: String,
    build_id: String,
    release_cut_root: String,
}

fn select_product_build<'a>(
    entries: &'a [BuildEntry],
    installed: &str,
    selected: Option<&str>,
    allow_nonlinear: bool,
) -> &'a BuildEntry {
    if let Some(id) = selected {
        let entry = select_named_build(entries, id);
        if !build_valid(entry) {
            util::die(&format!(
                "build {} is invalid and cannot be promoted even with an override",
                entry.name
            ));
        }
        let relation = build_relation(entry, installed, entries.len());
        if !automatic(relation, build_valid(entry), false) && !allow_nonlinear {
            util::die(&format!(
                "build {} is {} and is manual-only; after review pass \
                 --build {} --allow-nonlinear",
                entry.name,
                relation.as_str(),
                entry.name
            ));
        }
        return entry;
    }
    let dispositions: Vec<_> = entries
        .iter()
        .map(|entry| {
            (
                build_relation(entry, installed, entries.len()),
                build_valid(entry),
                false,
            )
        })
        .collect();
    match select_unique_automatic(&dispositions) {
        Ok(index) => &entries[index],
        Err(SelectionError::None) => util::die(
            "no automatic product candidate: builds are older, divergent, or have unknown \
             provenance; inspect shifu builds and select --build <id> --allow-nonlinear",
        ),
        Err(SelectionError::Ambiguous) => util::die(
            "multiple automatic product candidates remain; inspect shifu builds and select \
             one explicitly with --build <id>",
        ),
    }
}

fn select_named_build<'a>(entries: &'a [BuildEntry], id: &str) -> &'a BuildEntry {
    let matches: Vec<_> = entries
        .iter()
        .filter(|entry| entry.name == id || entry.name.starts_with(id))
        .collect();
    if matches.len() != 1 {
        util::die(&format!(
            "--build {id} matched {} builds; use the exact id from shifu builds",
            matches.len()
        ));
    }
    matches[0]
}

fn select_preview_build<'a>(
    entries: &'a [BuildEntry],
    installed: &str,
    selected: Option<&str>,
    allow_nonlinear: bool,
) -> &'a BuildEntry {
    let Some(id) = selected else {
        util::die("--preview requires an explicit --build <id>");
    };
    let entry = select_named_build(entries, id);
    if !build_previewable(entry) {
        util::die(&format!(
            "build {} lacks exact clean product provenance and cannot be previewed",
            entry.name
        ));
    }
    let relation = build_relation(entry, installed, entries.len());
    if !matches!(relation, GitRelation::Same | GitRelation::Descendant) && !allow_nonlinear {
        util::die(&format!(
            "preview build {} is {} and requires --allow-nonlinear after review",
            entry.name,
            relation.as_str()
        ));
    }
    entry
}

/// Select the exact Product built by the current source checkout. This route
/// deliberately verifies product bytes, not remote delivery state: a developer
/// must be able to install and exercise their own exact build before it has
/// been merged or received any external delivery credential.
pub(super) fn select_current_source_build<'a>(
    entries: &'a [BuildEntry],
    current: &BuildEntry,
    installed: &str,
    allow_nonlinear: bool,
) -> &'a BuildEntry {
    let entry = select_named_build(entries, &current.name);
    if !current_payload_valid(entry) {
        util::die(&format!(
            "current source build {} failed exact payload verification",
            entry.name
        ));
    }
    let relation = build_relation(entry, installed, entries.len());
    if !matches!(relation, GitRelation::Same | GitRelation::Descendant) && !allow_nonlinear {
        util::die(&format!(
            "current source build {} is {} and requires --allow-nonlinear after review",
            entry.name,
            relation.as_str()
        ));
    }
    entry
}

fn apply_promote_flag(options: &mut PromoteOptions, arg: &str) -> bool {
    match arg {
        "--launch" => options.launch = true,
        "--force" => options.force = true,
        "--check" => options.check = true,
        "--rollback" => options.rollback = true,
        "--preview" => options.preview = true,
        "--adopt-installed" => options.adopt_installed = true,
        "--allow-nonlinear" => options.allow_nonlinear = true,
        _ => return false,
    }
    true
}

fn parse_promote_options(args: &[String]) -> PromoteOptions {
    let mut options = PromoteOptions::default();
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--build" {
            options.build_arg = Some(
                iter.next()
                    .unwrap_or_else(|| util::die(PROMOTE_USAGE))
                    .clone(),
            );
        } else if !apply_promote_flag(&mut options, arg) {
            util::die(PROMOTE_USAGE);
        }
    }
    options
}

fn validate_promote_options(options: &PromoteOptions) {
    if options.adopt_installed
        && (options.build_arg.is_none()
            || [
                options.rollback,
                options.preview,
                options.allow_nonlinear,
                options.launch,
                options.force,
            ]
            .contains(&true))
    {
        util::die(
            "--adopt-installed requires --build <id>; --check is its only optional companion",
        );
    }
    if options.rollback
        && (options.build_arg.is_some()
            || [options.allow_nonlinear, options.preview, options.force].contains(&true))
    {
        util::die(
            "--rollback identifies the exact retained Product; do not combine it with \
             --build, --preview, --allow-nonlinear, or --force",
        );
    }
}

fn installed_product() -> InstalledProduct {
    let mut release_cut_root = installed_value("KUNGFU_INSTALLED_RELEASE_CUT_ROOT");
    if release_cut_root.is_empty() {
        release_cut_root = native_update::LEGACY_BOOTSTRAP_ROOT.to_string();
    }
    InstalledProduct {
        sha: installed_sha(),
        build_id: installed_value("KUNGFU_INSTALLED_BUILD_ID"),
        release_cut_root,
    }
}

fn require_rollback_coordinate(installed: &InstalledProduct) {
    if !rollback_entry_valid(&registry_dir(), &installed.build_id, &installed.sha) {
        util::die(
            "installed Product has no verified rollback coordinate; refusing dogfood promotion",
        );
    }
}

fn select_promotion_entry<'a>(
    root: Option<&Path>,
    entries: &'a [BuildEntry],
    options: &PromoteOptions,
    installed: &InstalledProduct,
) -> &'a BuildEntry {
    if options.preview {
        require_rollback_coordinate(installed);
        return select_preview_build(
            entries,
            &installed.sha,
            options.build_arg.as_deref(),
            options.allow_nonlinear,
        );
    }
    if let Some(root) = root.filter(|root| root.join(CURRENT_REGISTRATION_RELATIVE).is_file()) {
        let current = current_entry_at(root, &registry_dir(), &git_head(root))
            .unwrap_or_else(|error| util::die(&error));
        return select_current_source_build(
            entries,
            &current,
            &installed.sha,
            options.allow_nonlinear,
        );
    }
    require_rollback_coordinate(installed);
    select_product_build(
        entries,
        &installed.sha,
        options.build_arg.as_deref(),
        options.allow_nonlinear,
    )
}

fn finish_adopted_install(
    entries: &[BuildEntry],
    options: &PromoteOptions,
    lock: &mut Option<PromotionLock>,
) -> ! {
    let build_id = options.build_arg.as_deref().expect("validated build id");
    let entry = entries
        .iter()
        .find(|candidate| candidate.name == build_id)
        .unwrap_or_else(|| util::die("--adopt-installed build id is not registered"));
    let result = adopt_installed_product(entry, !options.check)
        .unwrap_or_else(|error| util::die(&format!("installed Product adoption failed: {error}")));
    if let Some(lock) = lock.take() {
        lock.release().unwrap_or_else(|error| util::die(&error));
    }
    println!("{result}");
    std::process::exit(0);
}

fn promotion_already_finished(
    entry: &BuildEntry,
    installed: &InstalledProduct,
    options: &PromoteOptions,
    lock: &mut Option<PromotionLock>,
) -> bool {
    !options.preview
        && promote_convergence::try_finish(
            entry,
            &registry_dir(),
            &installed.sha,
            options.check,
            options.launch,
            lock,
        )
        .unwrap_or_else(|error| util::die(&error))
}

fn preflight_native_promotion(
    entry: &BuildEntry,
    lock: &mut Option<PromotionLock>,
) -> native_update::NativeUpdateResult {
    run_native(entry, false, false).unwrap_or_else(|error| {
        promote_convergence::release_lock(lock)
            .unwrap_or_else(|release_error| util::die(&release_error));
        util::die(&format!("native updater preflight failed: {error}"));
    })
}

fn print_promotion_plan(
    action: &str,
    entry: &BuildEntry,
    installed: &InstalledProduct,
    native_plan: &native_update::NativeUpdateResult,
) -> ! {
    println!(
        "{{\"schema\":\"shifu.local-promotion-plan/v1\",\"ok\":true,\
         \"action\":\"{}\",\"artifactId\":\"{}\",\"sourceCommit\":\"{}\",\
         \"mainlineRef\":\"{}\",\"mainlineCommit\":\"{}\",\"qualified\":{},\
         \"integrated\":{},\"currentCommit\":\"{}\",\"currentReleaseCutRoot\":\"{}\",\
         \"targetReleaseCutRoot\":\"{}\",\"platformSliceRoot\":\"{}\",\
         \"cutTransitionRoot\":\"{}\",\"wouldWrite\":false}}",
        action,
        json_escape(&entry.name),
        json_escape(&entry.sha),
        json_escape(&entry.mainline_ref),
        json_escape(&entry.mainline_sha),
        entry.qualified,
        entry.integrated,
        json_escape(&installed.sha),
        json_escape(&installed.release_cut_root),
        json_escape(&entry.release_cut_root),
        json_escape(&entry.platform_slice_root),
        json_escape(&native_plan.transition_root),
    );
    std::process::exit(0);
}

fn promotion_action_label(options: &PromoteOptions) -> &str {
    if options.rollback {
        "rolling back to"
    } else if options.preview {
        "previewing"
    } else {
        "promoting"
    }
}

fn start_promotion_transaction(
    entries: &[BuildEntry],
    entry: &BuildEntry,
    action: &str,
    installed: InstalledProduct,
    options: &PromoteOptions,
    native_plan: native_update::NativeUpdateResult,
) -> ! {
    eprintln!(
        "\u{1f94b} {}",
        style::bold(&format!(
            "{} dev build {} ({} @ {})",
            promotion_action_label(options),
            entry.name,
            entry.sha,
            entry.branch
        ))
    );
    write_pending_transaction(&PendingTransaction {
        state: "desktop-commit-pending".to_string(),
        action: action.to_string(),
        artifact_id: entry.name.clone(),
        target_release_cut_root: entry.release_cut_root.clone(),
        cut_transition_root: native_plan.transition_root,
        native_receipt_root: String::new(),
        previous_build_id: installed.build_id,
        previous_sha: installed.sha,
        previous_release_cut_root: installed.release_cut_root,
        installed_path: String::new(),
        desktop_backup_path: String::new(),
        force: options.force,
        launch: options.launch,
    });
    resume_pending_transaction(entries, false);
    unreachable!()
}

pub(crate) fn run_promote(root: Option<&Path>, args: &[String]) -> ! {
    let options = parse_promote_options(args);
    validate_promote_options(&options);
    let mut promotion_lock = if options.check {
        None
    } else {
        Some(
            acquire_promotion_lock_at(&promotion_lock_path())
                .unwrap_or_else(|error| util::die(&error)),
        )
    };
    let entries = entries();
    resume_pending_transaction(&entries, options.check);
    if options.rollback {
        start_retained_rollback(options.check, options.launch);
    }
    if entries.is_empty() {
        no_builds_hint();
    }
    if options.adopt_installed {
        finish_adopted_install(&entries, &options, &mut promotion_lock);
    }
    let installed = installed_product();
    let entry = select_promotion_entry(root, &entries, &options, &installed);
    let action = if options.preview {
        "preview"
    } else {
        "promote"
    };
    if promotion_already_finished(entry, &installed, &options, &mut promotion_lock) {
        std::process::exit(0);
    }
    let native_plan = preflight_native_promotion(entry, &mut promotion_lock);
    if options.check {
        print_promotion_plan(action, entry, &installed, &native_plan);
    }
    start_promotion_transaction(&entries, entry, action, installed, &options, native_plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn promote_options_preserve_every_supported_flag_and_build_value() {
        let args = [
            "--launch",
            "--force",
            "--check",
            "--rollback",
            "--preview",
            "--adopt-installed",
            "--allow-nonlinear",
            "--build",
            "build-42",
        ]
        .map(String::from);

        let options = parse_promote_options(&args);

        assert!(options.launch);
        assert!(options.force);
        assert!(options.check);
        assert!(options.rollback);
        assert!(options.preview);
        assert!(options.adopt_installed);
        assert!(options.allow_nonlinear);
        assert_eq!(options.build_arg.as_deref(), Some("build-42"));
    }
}
