# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from _skill_lifecycle_scaffold_cases import (  # noqa: F401
    CliRunner,
    Path,
    SkillAuthorityError,
    SkillRegistryError,
    _admitted_kfx_plan,
    _apply,
    _install_and_select,
    _package,
    _root,
    agent_command_module,
    apply_plan,
    build_skill_runtime_audit,
    canonical_json_bytes,
    dependency_audit_event,
    diagnose_registry,
    diff_revisions,
    discover_skills,
    hashlib,
    inspect_registry,
    invoke_dependency_plan,
    json,
    kfc,
    locks,
    normalize_package,
    os,
    plan_dependency_invocation,
    plan_operation,
    project_skill_runtime_audit,
    pytest,
    refresh_native_skill_runtime_audit,
    registry_history,
    registry_root,
    skill_authority,
    skill_command_module,
    skill_registry_module,
    subprocess,
    sys,
)

__all__ = [
    "test_runtime_audit_projects_one_root_across_every_surface",
    "test_runtime_audit_retains_removed_skill_identity_and_history",
    "test_runtime_audit_strictly_isolates_run_and_work_evidence",
    "test_native_runtime_audit_refresh_roots_loaded_skill_evidence",
    "test_runtime_audit_cli_returns_the_verified_shared_document",
]


def test_runtime_audit_projects_one_root_across_every_surface(tmp_path):
    home = tmp_path / "home"
    package = _package(tmp_path / "package")
    work_root = _root({"work": "shared-runtime-audit"})
    _install_and_select(home, package, "work:shared-runtime-audit", work_root)
    _apply(home, "load", key="exact-skill")
    _apply(home, "invoke", key="exact-skill")
    _apply(home, "retire", key="exact-skill")
    audit_document = {
        "schema": "kungfu.skill-audit/v1",
        "run_id": "run-shared",
        "work_id": "work:shared-runtime-audit",
        "events": [
            {
                "schema": "kungfu.skill-audit-event/v1",
                "type": "SkillAdvertised",
                "run_id": "run-shared",
                "advertisedSkillsHash": _root({"catalog": "shared"}),
                "skills": [{"key": "exact-skill"}],
            },
            {
                "schema": "kungfu.skill-audit-event/v1",
                "type": "SkillTrustRefused",
                "run_id": "run-shared",
                "skill": {"key": "exact-skill"},
                "work": {"workRef": "work:shared-runtime-audit"},
                "planRoot": _root({"plan": "refused"}),
                "decision": {"status": "refused", "code": "KF_TEST_REFUSED"},
            },
            {
                "schema": "kungfu.skill-audit-event/v1",
                "type": "ProviderSelfReport",
                "run_id": "run-shared",
                "skill": {"key": "exact-skill"},
            },
        ],
    }

    document = build_skill_runtime_audit(
        home,
        audit_documents=[audit_document],
        run_id="run-shared",
        work_ref="work:shared-runtime-audit",
    )

    surfaces = ("agent", "cli", "gui", "tui", "managed-run")
    projections = {
        surface: project_skill_runtime_audit(document, surface) for surface in surfaces
    }
    shared_fields = {
        surface: {key: value for key, value in projection.items() if key != "surface"}
        for surface, projection in projections.items()
    }
    assert (
        len({json.dumps(value, sort_keys=True) for value in shared_fields.values()})
        == 1
    )
    assert next(iter(shared_fields.values())) == {
        "runtimeAuditRoot": document["runtimeAuditRoot"],
        "registryStateRoot": document["roots"]["registryStateRoot"],
        "historyRoot": document["roots"]["historyRoot"],
        "diagnosisRoot": document["roots"]["diagnosisRoot"],
        "auditRoots": document["roots"]["auditRoots"],
        "dependencyRoots": document["roots"]["dependencyRoots"],
        "authority": "read-only-projection",
    }
    skill = document["skills"][0]
    assert skill["identity"]["contentRoot"].startswith("sha256:")
    assert skill["lifecycle"] == "retired"
    assert skill["workBindings"][0]["workRef"] == "work:shared-runtime-audit"
    assert {"advertised", "selected", "loaded", "invoked", "blocked", "retired"} <= set(
        skill["observedStates"]
    )
    self_report = next(
        row
        for row in document["evidence"]
        if row["source"]["type"] == "ProviderSelfReport"
    )
    assert self_report["state"] == "unproved"
    assert self_report["proof"] == {"status": "unproved", "roots": []}


def test_runtime_audit_retains_removed_skill_identity_and_history(tmp_path):
    home = tmp_path / "home"
    package = _package(tmp_path / "package")
    install_plan, _ = _apply(home, "install", source=package)
    content_root = install_plan["affected"][0]["contentRoot"]
    _apply(home, "remove", key="exact-skill")

    document = build_skill_runtime_audit(home)

    skill = document["skills"][0]
    assert skill["lifecycle"] == "historical"
    assert skill["identity"]["active"] is False
    assert skill["identity"]["contentRoot"] == content_root
    assert skill["historyPreserved"] is True


def test_runtime_audit_strictly_isolates_run_and_work_evidence(tmp_path):
    home = tmp_path / "home"
    package = _package(tmp_path / "package")
    work_root = _root({"work": "target"})
    _install_and_select(home, package, "work:target", work_root)
    target = {
        "schema": "kungfu.skill-audit/v1",
        "run_id": "run-target",
        "work_id": "work:target",
        "events": [
            {
                "schema": "kungfu.skill-audit-event/v1",
                "type": "SkillLoaded",
                "skill": {
                    "key": "exact-skill",
                    "contentHash": _root({"content": "target"}),
                },
            }
        ],
    }
    foreign = {
        "schema": "kungfu.skill-audit/v1",
        "run_id": "run-foreign",
        "work_id": "work:foreign",
        "events": [
            {
                "schema": "kungfu.skill-audit-event/v1",
                "type": "SkillTrustRefused",
                "skill": {"key": "exact-skill"},
                "planRoot": _root({"plan": "foreign"}),
                "decision": {"status": "refused", "code": "KF_FOREIGN"},
            }
        ],
    }

    document = build_skill_runtime_audit(
        home,
        audit_documents=[foreign, target],
        run_id="run-target",
        work_ref="work:target",
    )

    run_evidence = [
        row
        for row in document["evidence"]
        if row["source"]["kind"] == "run-audit-event"
    ]
    assert [(row["runId"], row["workRef"], row["state"]) for row in run_evidence] == [
        ("run-target", "work:target", "loaded")
    ]
    assert document["skills"][0]["observedStates"].count("blocked") == 0
    assert document["roots"]["auditRoots"] == [_root(target)]


def test_native_runtime_audit_refresh_roots_loaded_skill_evidence(tmp_path):
    home = tmp_path / "home"
    work_ref = "assignment:runtime-audit"
    install_plan, _ = _apply(home, "install", source=_package(tmp_path / "package"))
    content_root = install_plan["affected"][0]["contentRoot"]
    _apply(
        home,
        "select",
        key="exact-skill",
        work_ref=work_ref,
        work_root=_root({"work": work_ref}),
    )
    audit_path = tmp_path / "runtime" / "skill-audit.jsonl"
    audit_path.parent.mkdir(parents=True)
    audit_path.write_text(
        json.dumps(
            {
                "schema": "kungfu.skill-audit-event/v1",
                "type": "SkillLoaded",
                "run_id": "attempt:runtime-audit",
                "work_id": work_ref,
                "skill": {"key": "exact-skill", "contentHash": content_root},
            }
        )
        + "\n",
        encoding="utf-8",
    )
    final_path = tmp_path / "runtime" / "skill-runtime-audit-final.json"

    refresh_native_skill_runtime_audit(
        {
            "KF_HOME": str(home),
            "KUNGFU_SKILL_AUDIT_FILE": str(audit_path),
            "KUNGFU_SKILL_RUN_ID": "attempt:runtime-audit",
            "KUNGFU_SKILL_WORK_REF": work_ref,
            "KUNGFU_SKILL_RUNTIME_AUDIT_FINAL_FILE": str(final_path),
        }
    )

    document = json.loads(final_path.read_text(encoding="utf-8"))
    assert document["scope"] == {
        "runId": "attempt:runtime-audit",
        "workRef": work_ref,
    }
    assert "loaded" in document["skills"][0]["observedStates"]
    proof = document["evidence"][0]["proof"]
    assert proof["status"] == "rooted"
    assert content_root in proof["roots"]


def test_runtime_audit_cli_returns_the_verified_shared_document(tmp_path):
    home = tmp_path / "home"
    _apply(home, "install", source=_package(tmp_path / "package"))

    result = CliRunner().invoke(
        kfc,
        ["-H", str(home), "skill", "runtime-audit", "--json"],
    )

    assert result.exit_code == 0, result.output
    document = json.loads(result.output)
    assert document["schema"] == "kungfu.skill-runtime-audit/v2"
    assert (
        project_skill_runtime_audit(document, "cli")["runtimeAuditRoot"]
        == document["runtimeAuditRoot"]
    )
