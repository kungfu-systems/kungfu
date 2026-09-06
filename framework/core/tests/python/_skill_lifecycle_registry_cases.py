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
    "test_complete_closure_rejects_undeclared_payload_and_kfx_body",
    "test_plan_apply_install_is_guarded_atomic_and_idempotent",
    "test_cli_mutation_requires_and_applies_the_exact_plan_root",
    "test_lifecycle_states_and_work_history_remain_distinct",
    "test_exact_kfx_coordinates_are_retained_without_owning_package_body",
    "test_update_discovers_revision_diff_and_rejects_identity_collision",
    "test_stale_and_concurrent_writers_lose_visibly",
    "test_crash_recovery_never_publishes_half_state",
    "test_python_node_cli_and_agent_report_exact_parity",
    "test_outer_managers_have_no_authoritative_registry_writer",
    "test_effectful_operation_inventory_has_one_guarded_writer_boundary",
]


def test_complete_closure_rejects_undeclared_payload_and_kfx_body(tmp_path):
    package = _package(tmp_path / "package")
    normalized = normalize_package(package)
    assert (
        normalized["contentRoot"] == normalized["definition"]["identity"]["contentRoot"]
    )

    (package / "hidden.txt").write_text("hidden", encoding="utf-8")
    with pytest.raises(SkillRegistryError) as undeclared:
        normalize_package(package)
    assert undeclared.value.code == "undeclared-payload"
    (package / "hidden.txt").unlink()

    (package / "kfx").mkdir()
    (package / "kfx" / "body.bin").write_bytes(b"not-owned-here")
    with pytest.raises(SkillRegistryError) as kfx:
        normalize_package(package)
    assert kfx.value.code in {"kfx-payload-forbidden", "undeclared-payload"}


def test_plan_apply_install_is_guarded_atomic_and_idempotent(tmp_path):
    home = tmp_path / "home"
    package = _package(tmp_path / "package")
    plan = plan_operation(home, "install", source=package)
    assert plan["basis"]["generation"] == 0
    assert plan["execute"] is False
    with pytest.raises(SkillRegistryError) as mismatch:
        apply_plan(home, plan, expected_plan_root=_root({"wrong": True}))
    assert mismatch.value.code == "plan-root-mismatch"

    receipt = apply_plan(home, plan, expected_plan_root=plan["planRoot"])
    replay = apply_plan(home, plan, expected_plan_root=plan["planRoot"])
    assert replay == receipt
    assert receipt["result"]["generation"] == 1
    report = inspect_registry(home)
    entry = report["entries"]["exact-skill"]
    assert entry["status"] == "installed"
    assert entry["activeRevision"] == 1
    assert Path(report["activePayloadPaths"][0], "SKILL.md").is_file()
    assert [row["key"] for row in discover_skills(str(home))] == ["exact-skill"]
    assert diagnose_registry(home)["verdict"] == "pass"


def test_cli_mutation_requires_and_applies_the_exact_plan_root(tmp_path):
    home = tmp_path / "home"
    package = _package(tmp_path / "package")
    runner = CliRunner()
    planned = runner.invoke(
        kfc, ["-H", str(home), "skill", "install", str(package), "--json"]
    )
    assert planned.exit_code == 0, planned.output
    plan = json.loads(planned.output)
    refused = runner.invoke(
        kfc,
        ["-H", str(home), "skill", "install", str(package), "--execute", "--json"],
    )
    assert refused.exit_code == 1
    assert json.loads(refused.output)["code"] == "expected-plan-root-required"
    applied = runner.invoke(
        kfc,
        [
            "-H",
            str(home),
            "skill",
            "install",
            str(package),
            "--execute",
            "--expected-plan-root",
            plan["planRoot"],
            "--json",
        ],
    )
    assert applied.exit_code == 0, applied.output
    assert json.loads(applied.output)["planRoot"] == plan["planRoot"]


def test_lifecycle_states_and_work_history_remain_distinct(tmp_path):
    home = tmp_path / "home"
    package = _package(tmp_path / "package")
    _apply(home, "install", source=package)
    expected = [
        ("enable", "enabled", {}),
        (
            "select",
            "selected",
            {
                "work_ref": "kungfu:work:test/exact",
                "work_root": "sha256:" + "1" * 64,
            },
        ),
        ("load", "loaded", {}),
        ("invoke", "invoked", {}),
        ("suspend", "suspended", {}),
        ("retire", "retired", {}),
        ("remove", "historical", {}),
    ]
    for operation, status, extra in expected:
        _apply(home, operation, key="exact-skill", **extra)
        assert (
            inspect_registry(home, "exact-skill")["entries"]["exact-skill"]["status"]
            == status
        )
        if operation == "select":
            repeated = plan_operation(
                home,
                "select",
                key="exact-skill",
                work_ref="kungfu:work:test/exact",
                work_root="sha256:" + "1" * 64,
            )
            assert repeated["changed"] is False
            assert repeated["next"] == repeated["basis"]
    removed = inspect_registry(home)["entries"]["exact-skill"]
    assert removed["activeReference"] is False
    assert removed["activeRevision"] is None
    assert removed["workSelections"] == [
        {
            "workRef": "kungfu:work:test/exact",
            "workRoot": "sha256:" + "1" * 64,
            "revision": 1,
            "contentRoot": normalize_package(package)["contentRoot"],
            "active": False,
        }
    ]
    assert inspect_registry(home)["activePayloadPaths"] == []
    assert len(registry_history(home, "exact-skill")["events"]) == 8

    _apply(home, "rollback", key="exact-skill", target_revision=1)
    rolled_back = inspect_registry(home)["entries"]["exact-skill"]
    assert rolled_back["status"] == "installed"
    assert rolled_back["activeRevision"] == 1


def test_exact_kfx_coordinates_are_retained_without_owning_package_body(tmp_path):
    home = tmp_path / "home"
    root = "sha256:" + "a" * 64
    coordinate = {
        "key": "filesystem.read",
        "revision": 3,
        "root": root,
        "required": True,
        "capabilityRequests": ["filesystem.read"],
    }
    package = _package(
        tmp_path / "package",
        skill_class="operational",
        dependencies={"kfx": [coordinate], "profiles": []},
        effects={
            "mode": "declared",
            "declarations": [
                {
                    "id": "read-input",
                    "type": "filesystem-read",
                    "authorityRef": f"kfx:filesystem.read@3#{root}",
                }
            ],
        },
    )
    shared_body = home / "extensions" / "filesystem.read" / "body.bin"
    shared_body.parent.mkdir(parents=True)
    shared_body.write_bytes(b"shared-kfx-authority")
    _apply(home, "install", source=package)

    runner = CliRunner()
    deps = runner.invoke(
        kfc, ["-H", str(home), "skill", "deps", "exact-skill", "--json"]
    )
    assert deps.exit_code == 0, deps.output
    report = json.loads(deps.output)
    assert report["schema"] == "kungfu.skill-dependency-coordinates/v2"
    assert report["dependencies"]["kfx"] == [coordinate]
    assert report["admission"] == "not-evaluated"
    assert report["kfxRegistry"] == str(home / "extensions")

    _apply(home, "remove", key="exact-skill")
    assert shared_body.read_bytes() == b"shared-kfx-authority"


def test_update_discovers_revision_diff_and_rejects_identity_collision(tmp_path):
    home = tmp_path / "home"
    first = _package(tmp_path / "v1")
    first_normalized = normalize_package(first)
    _apply(home, "install", source=first)
    predecessor = {
        "key": "exact-skill",
        "revision": 1,
        "contentRoot": first_normalized["contentRoot"],
    }
    second = _package(
        tmp_path / "v2",
        revision=2,
        predecessor=predecessor,
        body="# Exact Skill\n\nUse the compatible second revision.\n",
    )
    _apply(home, "update", source=second)
    report = inspect_registry(home)["entries"]["exact-skill"]
    assert report["activeRevision"] == 2
    assert sorted(report["revisions"]) == ["1", "2"]
    assert any(
        row["path"] == "/identity/revision"
        for row in diff_revisions(home, "exact-skill", 1, 2)["changes"]
    )

    collision = _package(
        tmp_path / "collision",
        revision=2,
        predecessor=predecessor,
        body="# Exact Skill\n\nA different body cannot reuse revision two.\n",
    )
    with pytest.raises(SkillRegistryError) as error:
        plan_operation(home, "update", source=collision)
    assert error.value.code == "identity-collision"


def test_stale_and_concurrent_writers_lose_visibly(tmp_path):
    home = tmp_path / "home"
    package = _package(tmp_path / "package")
    _apply(home, "install", source=package)
    enable = plan_operation(home, "enable", key="exact-skill")
    suspend = plan_operation(home, "suspend", key="exact-skill")
    apply_plan(home, enable, expected_plan_root=enable["planRoot"])
    with pytest.raises(SkillRegistryError) as stale:
        apply_plan(home, suspend, expected_plan_root=suspend["planRoot"])
    assert stale.value.code == "stale-plan"

    invoke = plan_operation(home, "invoke", key="exact-skill")
    lock_root = registry_root(home) / "locks"
    assert locks.try_acquire(lock_root, "skill-registry-writer") is True
    try:
        script = """
import json, sys
from kungfu.skill import SkillRegistryError, apply_plan
try:
    apply_plan(sys.argv[1], json.loads(sys.argv[2]), expected_plan_root=sys.argv[3])
except SkillRegistryError as error:
    print(error.code)
    raise SystemExit(0)
raise SystemExit(2)
"""
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                script,
                str(home),
                json.dumps(invoke),
                invoke["planRoot"],
            ],
            text=True,
            capture_output=True,
            check=False,
            env=dict(os.environ),
        )
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == "writer-busy"
    finally:
        locks.release(lock_root, "skill-registry-writer")


def test_crash_recovery_never_publishes_half_state(tmp_path):
    home = tmp_path / "home"
    package = _package(tmp_path / "package")
    install = plan_operation(home, "install", source=package)
    with pytest.raises(RuntimeError, match="after payload"):
        apply_plan(
            home,
            install,
            expected_plan_root=install["planRoot"],
            fault="after-payload",
        )
    assert inspect_registry(home)["generation"] == 0
    assert inspect_registry(home)["entries"] == {}
    apply_plan(home, install, expected_plan_root=install["planRoot"])

    enable = plan_operation(home, "enable", key="exact-skill")
    with pytest.raises(RuntimeError, match="after state"):
        apply_plan(
            home,
            enable,
            expected_plan_root=enable["planRoot"],
            fault="after-state",
        )
    assert inspect_registry(home)["entries"]["exact-skill"]["status"] == "enabled"
    recovered = apply_plan(home, enable, expected_plan_root=enable["planRoot"])
    assert recovered["result"]["recovered"] is True
    assert diagnose_registry(home)["verdict"] == "pass"


def test_python_node_cli_and_agent_report_exact_parity(tmp_path, monkeypatch):
    home = tmp_path / "home"
    package = _package(tmp_path / "package")
    _apply(home, "install", source=package)
    python_report = inspect_registry(home)
    repo = Path(__file__).resolve().parents[4]
    node = subprocess.run(
        [
            "node",
            "--experimental-transform-types",
            str(repo / "framework" / "skill" / "scripts" / "registry.mjs"),
            "--home",
            str(home),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert node.returncode == 0, node.stderr
    node_report = json.loads(node.stdout)
    assert node_report == python_report
    runner = CliRunner()
    cli = runner.invoke(kfc, ["-H", str(home), "skill", "inspect", "--json"])
    assert cli.exit_code == 0, cli.output
    cli_report = json.loads(cli.output)
    monkeypatch.delenv("KUNGFU_AGENT_CONTEXT", raising=False)
    monkeypatch.delenv("KUNGFU_AGENT_CONSOLE_ENVELOPE", raising=False)
    agent = runner.invoke(kfc, ["-H", str(home), "agent", "context", "--json"])
    assert agent.exit_code == 0, agent.output
    agent_report = json.loads(agent.output)["skillRegistry"]
    assert cli_report == agent_report == python_report


def test_outer_managers_have_no_authoritative_registry_writer():
    repo = Path(__file__).resolve().parents[4]
    cli = (repo / "framework/core/src/python/kungfu/cli/commands/skill.py").read_text(
        encoding="utf-8"
    )
    node = (repo / "framework/skill/src/index.ts").read_text(encoding="utf-8")
    assert "shutil.rmtree" not in cli
    assert "shutil.copytree" not in cli
    assert "_copy_skill_source" not in cli
    assert "renameSync" not in node
    assert "rmSync" not in node
    assert "copyFileSync" not in node


def test_effectful_operation_inventory_has_one_guarded_writer_boundary():
    repo = Path(__file__).resolve().parents[4]
    contract = json.loads(
        (repo / "framework/skill/kungfu-skill.contract.json").read_text(
            encoding="utf-8"
        )
    )
    inventory = contract["effectfulOperationInventory"]
    assert set(inventory["lifecycleOperations"]) == {
        "install",
        "update",
        "enable",
        "select",
        "load",
        "invoke",
        "suspend",
        "retire",
        "remove",
        "rollback",
    }
    assert inventory["requiredGuard"] == "expected-plan-root"
    assert inventory["directStoreWrites"] is False
    assert set(inventory["clients"]) == {
        "agent",
        "cli",
        "gui",
        "tui",
        "managed-run",
    }
    assert set(inventory["clients"].values()) == {"read-only-projection"}
    assert inventory["registryWriter"].endswith("registry.py::apply_plan")
    assert inventory["dependencyExecutor"].endswith(
        "dependencies.py::invoke_dependency_plan"
    )
