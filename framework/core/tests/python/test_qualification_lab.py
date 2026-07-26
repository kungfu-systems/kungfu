# SPDX-License-Identifier: Apache-2.0

import json
import os

from kungfu import qualification_lab


def _verified_query(canonical_work_count=0):
    projection_root = "sha256:" + "a" * 64
    proof_root = "sha256:" + "b" * 64
    return {
        "verification": {"ok": True},
        "aggregate": {
            "complete": True,
            "writes": 0,
            "canonical_work_count": canonical_work_count,
        },
        "global_work": {
            "writes": 0,
            "canonical_work_count": canonical_work_count,
            "projection_root": projection_root,
        },
        "proof": {"proof_root": proof_root},
        "writes": [],
    }


def test_absent_runtime_is_verified_empty_without_materializing_it(
    tmp_path, monkeypatch
):
    runtime = tmp_path / "home" / "runtime"
    before = list(tmp_path.rglob("*"))
    monkeypatch.setattr(
        qualification_lab,
        "query_federation",
        lambda *_args, **_kwargs: _verified_query(),
    )
    result = qualification_lab.inspect_startup(
        runtime,
        config_home=tmp_path / "config",
        env={"HOME": str(tmp_path / "user")},
    )
    assert result["route"] == "qualification-lab"
    assert result["state"] == "verified-empty"
    assert result["reasonCode"] == "global-work-verified-empty"
    assert result["writeOccurred"] is False
    assert list(tmp_path.rglob("*")) == before


def test_existing_global_work_routes_to_work_graph(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime"
    monkeypatch.setattr(
        qualification_lab,
        "query_federation",
        lambda *_args, **_kwargs: {
            **_verified_query(1),
            "aggregate": {
                "complete": False,
                "writes": 0,
                "canonical_work_count": 1,
            },
        },
    )
    result = qualification_lab.inspect_startup(
        runtime,
        config_home=tmp_path / "config",
        env={"HOME": str(tmp_path / "user")},
    )
    assert result["route"] == "work-graph"
    assert result["workGraphPresent"] is True
    assert result["reasonCode"] == "global-work-present"
    assert result["evidence"] == [
        "sha256:" + "a" * 64,
        "sha256:" + "b" * 64,
    ]


def test_unknown_or_incomplete_global_work_fails_closed_to_diagnostic(
    tmp_path, monkeypatch
):
    runtime = tmp_path / "runtime"
    monkeypatch.setattr(
        qualification_lab,
        "query_federation",
        lambda *_args, **_kwargs: {
            **_verified_query(),
            "aggregate": {
                "complete": False,
                "writes": 0,
                "canonical_work_count": 0,
            },
        },
    )
    result = qualification_lab.inspect_startup(
        runtime,
        config_home=tmp_path / "config",
        env={"HOME": str(tmp_path / "user")},
    )
    assert result["route"] == "diagnostic"
    assert result["workGraphPresent"] is None
    assert result["reasonCode"] == "global-work-unverified"

    runtime.mkdir()
    (runtime / ".migration-in-progress").touch()
    migrating = qualification_lab.inspect_startup(runtime)
    assert migrating["route"] == "diagnostic"
    assert migrating["reasonCode"] == "runtime-migration-in-progress"


def test_demo_uses_distinct_fresh_processes_and_exact_oracle(tmp_path):
    output = tmp_path / "evidence"
    report = qualification_lab.run_demo(output)
    assert report["status"] == "qualified"
    assert report["writeOccurred"] is True
    assert report["identity"]["provider"] == "kungfu-demo-agent"
    assert report["sessionAttempts"][0]["status"] == "ended-partial"
    assert report["sessionAttempts"][1]["observedState"] == "partial-first-attempt"
    assert all(
        attempt["priorTranscriptIncluded"] is False
        and attempt["humanExplanationIncluded"] is False
        for attempt in report["sessionAttempts"]
    )
    assert all(check["passed"] for check in report["assessment"]["oracleChecks"])
    retained = json.loads((output / "report.json").read_text(encoding="utf-8"))
    assert retained["reportRoot"] == report["reportRoot"]


def test_qualification_identity_change_marks_report_stale():
    identity = {"provider": "codex", "executableDigest": "sha256:one"}
    report = {
        "status": "qualified",
        "identityRoot": qualification_lab.content_root(identity),
    }
    assert qualification_lab.report_status(report, identity)["status"] == "qualified"
    changed = {**identity, "executableDigest": "sha256:two"}
    status = qualification_lab.report_status(report, changed)
    assert status["status"] == "stale"
    assert status["stale"] is True


def test_catalog_exposes_one_authority_for_cli_gui_and_tui(tmp_path, monkeypatch):
    monkeypatch.setattr(
        qualification_lab,
        "query_federation",
        lambda *_args, **_kwargs: _verified_query(),
    )
    catalog = qualification_lab.catalog(
        tmp_path / "missing",
        config_home=tmp_path / "config",
        env={"HOME": str(tmp_path / "user")},
    )
    assert catalog["authority"]["surfaces"] == ["cli", "gui", "tui"]
    assert catalog["authority"]["uiPrivateWrites"] is False
    assert [row["id"] for row in catalog["actions"]] == [
        "qualification-lab.demo.plan",
        "qualification-lab.demo.run",
        "qualification-lab.agent.plan",
        "qualification-lab.agent.run",
    ]


def test_provider_commands_are_exact_and_non_interactive():
    profile = {
        "provider": "codex",
        "launch": {"executable": "/usr/bin/codex", "argv": ["--profile", "lab"]},
    }
    assert qualification_lab._provider_command(profile, "fixture") == [
        "/usr/bin/codex",
        "--profile",
        "lab",
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "fixture",
    ]


def test_selected_agent_and_cross_profile_handoff_use_fresh_processes(
    tmp_path, monkeypatch
):
    executable = tmp_path / "fixture-agent"
    executable.write_text(
        """#!/usr/bin/env python3
import json
from pathlib import Path
path = Path("fixture-state.json")
state = json.loads(path.read_text())
if state["status"] == "unstarted":
    state["status"] = "partial"
    state["steps"] = ["claim-recorded"]
else:
    state["status"] = "complete"
    state["steps"] = ["claim-recorded", "continuation-completed"]
path.write_text(json.dumps(state))
""",
        encoding="utf-8",
    )
    os.chmod(executable, 0o755)

    def profile(profile_id, **_kwargs):
        return {
            "schema": "kungfu.agent-runtime-profile/v1",
            "id": profile_id,
            "label": profile_id,
            "provider": "codex",
            "launch": {
                "executable": str(executable),
                "argv": [],
                "shellMode": False,
            },
            "backendDefault": "direct",
        }

    monkeypatch.setattr(qualification_lab.runtime_profiles, "find_profile", profile)
    monkeypatch.setattr(
        qualification_lab.runtime_profiles,
        "verify_profile",
        lambda value: {
            "ok": True,
            "version": "1.2.3",
            "profileId": value["id"],
        },
    )
    report = qualification_lab.run_agent(
        "source",
        target_profile_id="target",
        output_dir=tmp_path / "evidence",
    )
    assert report["status"] == "qualified"
    assert report["runMode"] == "cross-provider-migration"
    assert report["identity"]["source"]["profileId"] == "source"
    assert report["identity"]["target"]["profileId"] == "target"
    assert len({row["processId"] for row in report["sessionAttempts"]}) == 2
