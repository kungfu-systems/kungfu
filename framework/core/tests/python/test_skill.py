# SPDX-License-Identifier: Apache-2.0

from pathlib import Path
import json

from kungfu.config import contract_hash, load_contract, resolve_config
from kungfu.skill import (
    append_audit_event,
    build_skill_dependency_binding,
    build_catalog,
    build_context_envelope,
    build_skill_context,
    inject_skill_context,
    parse_skill,
    read_audit_file,
    skill_advertised_event,
    skill_audit_document,
    skill_dependencies_bound_event,
    skill_loaded_event,
    write_skill_dependency_binding,
    write_audit_document,
)


def _repo_root():
    return Path(__file__).resolve().parents[4]


def _fixture(name):
    return _repo_root() / "framework" / "skill" / "fixtures" / name


def _golden(name):
    with open(_fixture("golden") / name, encoding="utf-8") as f:
        return json.load(f)


def test_minimal_skill_is_instruction_only():
    skill = parse_skill(_fixture("minimal"))

    assert skill["schema"] == "kungfu.skill/v1"
    assert skill["key"] == "minimal"
    assert skill["title"] == "Trace Failure Investigator"
    assert skill["kind"] == "instruction-only"
    assert skill["capabilities"] == []
    assert skill["kfx"] == []
    assert skill["source"]["hash"].startswith("sha256:")


def test_frontmatter_skill_declares_kfx_and_capabilities():
    skill = parse_skill(_fixture("with-frontmatter"))

    assert skill["key"] == "trace-failure-investigator"
    assert skill["kind"] == "kfx-backed"
    assert skill["triggers"] == ["trace failed", "replay failed"]
    assert skill["capabilities"] == ["rewind", "ledger"]
    assert [row["key"] for row in skill["kfx"]] == [
        "rewind-inspector",
        "journal-manager",
    ]


def test_catalog_and_context_envelope_are_compact():
    skill = parse_skill(_fixture("minimal"))
    catalog = build_catalog([skill])
    envelope = build_context_envelope(
        catalog,
        {"source": "test", "manager": "python"},
    )

    assert catalog["schema"] == "kungfu.skill-catalog/v1"
    assert catalog["skills"][0]["loadPolicy"] == "on-demand"
    assert "source" not in catalog["skills"][0]
    assert envelope["schema"] == "kungfu.skill-context/v1"
    assert envelope["tools"][0]["name"] == "kungfu.skill.read"
    assert envelope["audit"]["advertisedSkillsHash"].startswith("sha256:")


def test_python_skill_context_matches_golden_fixture():
    catalog = build_catalog(
        [parse_skill(_fixture("minimal")), parse_skill(_fixture("with-frontmatter"))]
    )
    envelope = build_context_envelope(
        catalog,
        {"source": "test", "manager": "python"},
    )

    assert catalog == _golden("catalog.json")
    assert envelope == _golden("context-python.json")
    assert (
        envelope["audit"]["advertisedSkillsHash"]
        == _golden("context-node.json")["audit"]["advertisedSkillsHash"]
    )


def test_provider_builds_and_injects_skill_context():
    envelope = build_skill_context(
        str(_repo_root() / "framework" / "skill"),
        source="test",
        manager="python",
        extra_paths=[str(_fixture("minimal"))],
    )
    injected = inject_skill_context("hello", envelope)

    assert envelope["catalog"][0]["key"] == "minimal"
    assert envelope["kungfu"]["schema"] == "kungfu.environment/v1"
    assert envelope["kungfu"]["environment"] == "test"
    assert envelope["kungfu"] == {
        "schema": "kungfu.environment/v1",
        "environment": "test",
        "agentEntrypoint": "kungfu agent context --json",
    }
    assert "Kungfu Skill context envelope" in injected
    assert "You are running under Kungfu managed-run" in injected
    assert injected.endswith("\n\nUser task:\nhello")


def test_provider_injects_environment_when_catalog_is_empty(tmp_path):
    home = tmp_path / "home"
    envelope = build_skill_context(str(home), source="cli", manager="python")
    injected = inject_skill_context("hello", envelope)

    assert envelope["catalog"] == []
    assert envelope["kungfu"]["environment"] == "managed-run"
    assert envelope["kungfu"]["agentEntrypoint"] == "kungfu agent context --json"
    assert "Kungfu Skill context envelope" in injected
    assert "You are running under Kungfu managed-run" in injected
    assert injected.endswith("\n\nUser task:\nhello")


def test_provider_uses_configured_agent_entrypoint(tmp_path):
    home = tmp_path / "home"
    config_home = tmp_path / "config"
    config_home.mkdir()
    (config_home / "config.json").write_text(
        json.dumps({"agent": {"entrypoint": "kungfu agent custom --json"}}),
        encoding="utf-8",
    )

    envelope = build_skill_context(
        str(home),
        source="cli",
        manager="python",
        env={"KF_CONFIG_HOME": str(config_home)},
    )

    assert envelope["kungfu"]["agentEntrypoint"] == "kungfu agent custom --json"


def test_resolved_config_uses_defaults_without_writing_user_file(tmp_path):
    runtime_home = tmp_path / "runtime-home"
    config_home = tmp_path / "config-home"

    config = resolve_config(
        runtime_home=str(runtime_home),
        config_home=str(config_home),
        env={},
    )

    assert config["schema"] == "kungfu.config.resolved/v1"
    assert config["contract"]["id"] == "kungfu-config"
    assert config["contract"]["hash"] == contract_hash()
    assert config["sources"][0]["type"] == "contract"
    assert config["sources"][0]["hash"] == config["contract"]["hash"]
    assert config["configHome"] == str(config_home)
    assert config["configPath"] == str(config_home / "config.json")
    assert config["sources"][1]["exists"] is False
    assert not (config_home / "config.json").exists()
    assert config["config"]["ui"]["fontSize"] == 14
    assert config["config"]["ui"]["scale"] == 1.0
    assert config["config"]["agent"]["entrypoint"] == "kungfu agent context --json"


def test_resolved_config_merges_user_override(tmp_path):
    runtime_home = tmp_path / "runtime-home"
    config_home = tmp_path / "config-home"
    config_home.mkdir()
    (config_home / "config.json").write_text(
        json.dumps(
            {
                "schema": "kungfu.config.override/v1",
                "ui": {"fontSize": 18, "scale": 1.25},
                "shortcuts": {"commandPalette": "Ctrl+K"},
            }
        ),
        encoding="utf-8",
    )

    config = resolve_config(
        runtime_home=str(runtime_home),
        config_home=str(config_home),
        env={},
    )

    assert config["sources"][1]["exists"] is True
    assert config["config"]["ui"]["fontSize"] == 18
    assert config["config"]["ui"]["scale"] == 1.25
    assert config["config"]["ui"]["fontFamily"] == "system"
    assert config["config"]["shortcuts"]["commandPalette"] == "Ctrl+K"
    assert config["config"]["shortcuts"]["quickOpen"] == "Mod+P"


def test_resolved_config_rejects_unknown_override_keys(tmp_path):
    runtime_home = tmp_path / "runtime-home"
    config_home = tmp_path / "config-home"
    config_home.mkdir()
    (config_home / "config.json").write_text(
        json.dumps({"unknown": True}),
        encoding="utf-8",
    )

    try:
        resolve_config(
            runtime_home=str(runtime_home),
            config_home=str(config_home),
            env={},
        )
    except ValueError as e:
        assert "Additional properties are not allowed" in str(e)
    else:
        raise AssertionError("expected invalid config override to fail")


def test_config_contract_schema_rejects_missing_resolution_key(tmp_path):
    contract_path = (
        _repo_root() / "framework" / "config" / "kungfu-config.contract.json"
    )
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    del contract["resolution"]["userOverrideFile"]
    broken = tmp_path / "kungfu-config.contract.json"
    broken.write_text(json.dumps(contract), encoding="utf-8")

    try:
        load_contract(str(broken))
    except ValueError as e:
        assert "contract validation failed" in str(e)
        assert "userOverrideFile" in str(e)
    else:
        raise AssertionError("expected invalid config contract to fail")


def test_skill_audit_records_advertised_and_loaded_events(tmp_path):
    skill = parse_skill(_fixture("minimal"))
    envelope = build_context_envelope(
        build_catalog([skill]),
        {"source": "test", "manager": "python", "agent": "codex"},
    )
    advertised = skill_advertised_event(
        envelope,
        run_id="run-1",
        provider="codex",
        context_file="/tmp/context.json",
    )
    markdown = Path(skill["source"]["path"]).read_text(encoding="utf-8")
    loaded = skill_loaded_event(skill, markdown, run_id="run-1")
    document = skill_audit_document(
        run_id="run-1",
        provider="codex",
        events=[advertised, loaded],
    )
    audit_path = tmp_path / "skill-audit.json"
    digest = write_audit_document(audit_path, document)

    assert digest
    assert advertised["type"] == "SkillAdvertised"
    assert advertised["skills"][0]["key"] == "minimal"
    assert (
        advertised["advertisedSkillsHash"] == envelope["audit"]["advertisedSkillsHash"]
    )
    assert loaded["type"] == "SkillLoaded"
    assert loaded["skill"]["sourceHash"] == skill["source"]["hash"]
    assert loaded["skill"]["contentHash"] == skill["source"]["hash"]
    assert read_audit_file(audit_path)["event_count"] == 2


def test_skill_audit_reads_jsonl_events(tmp_path):
    skill = parse_skill(_fixture("minimal"))
    markdown = Path(skill["source"]["path"]).read_text(encoding="utf-8")
    event = skill_loaded_event(skill, markdown, run_id="run-jsonl")
    audit_path = tmp_path / "skill-audit.jsonl"

    append_audit_event(audit_path, event)

    document = read_audit_file(audit_path)
    assert document["schema"] == "kungfu.skill-audit/v1"
    assert document["run_id"] == "run-jsonl"
    assert document["events"][0]["skill"]["key"] == "minimal"


def test_skill_audit_reads_multi_event_jsonl(tmp_path):
    skill = parse_skill(_fixture("minimal"))
    markdown = Path(skill["source"]["path"]).read_text(encoding="utf-8")
    audit_path = tmp_path / "skill-audit.jsonl"

    append_audit_event(audit_path, skill_loaded_event(skill, markdown, run_id="run-1"))
    append_audit_event(audit_path, skill_loaded_event(skill, markdown, run_id="run-2"))

    document = read_audit_file(audit_path)
    assert document["event_count"] == 2
    assert [event["run_id"] for event in document["events"]] == ["run-1", "run-2"]


def test_skill_dependency_binding_resolves_installed_kfx(tmp_path):
    home = tmp_path / "home"
    extension = home / "extensions" / "journal-manager"
    extension.mkdir(parents=True)
    (extension / "package.json").write_text(
        json.dumps(
            {
                "name": "@kungfu-tech/kfx-view-journal-manager",
                "version": "4.0.0-alpha.0",
                "kungfuConfig": {
                    "key": "journal-manager",
                    "config": {"view": {}},
                },
            }
        ),
        encoding="utf-8",
    )
    skill = parse_skill(_fixture("with-frontmatter"))

    binding_path, binding = write_skill_dependency_binding(home, skill)

    assert Path(binding_path).name == "trace-failure-investigator.json"
    assert binding["schema"] == "kungfu.skill-dependencies/v1"
    assert binding["summary"] == {"total": 2, "resolved": 1, "unresolved": 1}
    by_key = {row["kfxKey"]: row for row in binding["dependencies"]}
    assert by_key["journal-manager"]["status"] == "resolved"
    assert by_key["journal-manager"]["package"]["kind"] == "view"
    assert by_key["rewind-inspector"]["status"] == "unresolved"
    assert by_key["rewind-inspector"]["reason"] == "not installed in kfx registry"


def test_multiple_skills_bind_one_shared_kfx_without_duplicate_registry(tmp_path):
    home = tmp_path / "home"
    extension = home / "extensions" / "shared-view"
    extension.mkdir(parents=True)
    (extension / "package.json").write_text(
        json.dumps(
            {
                "name": "@kungfu-tech/kfx-view-shared",
                "version": "1.2.3",
                "kungfuConfig": {
                    "key": "shared-view",
                    "config": {"view": {}},
                },
            }
        ),
        encoding="utf-8",
    )
    skill_dirs = []
    for key in ("first-skill", "second-skill"):
        skill_dir = tmp_path / key
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text(
            "\n".join(
                [
                    "---",
                    f"key: {key}",
                    "kfx:",
                    "  - key: shared-view",
                    "    role: shared-tool",
                    "---",
                    "",
                    f"# {key}",
                    "",
                    "Use the shared view.",
                ]
            ),
            encoding="utf-8",
        )
        skill_dirs.append(skill_dir)

    bindings = [
        write_skill_dependency_binding(home, parse_skill(skill_dir))
        for skill_dir in skill_dirs
    ]

    assert len(list((home / "extensions").iterdir())) == 1
    assert bindings[0][0] != bindings[1][0]
    first = bindings[0][1]["dependencies"][0]
    second = bindings[1][1]["dependencies"][0]
    assert first["status"] == "resolved"
    assert second["status"] == "resolved"
    assert first["registryPath"] == second["registryPath"]
    assert first["package"] == second["package"]


def test_skill_dependency_binding_marks_version_mismatch_unresolved(tmp_path):
    home = tmp_path / "home"
    extension = home / "extensions" / "versioned-view"
    extension.mkdir(parents=True)
    (extension / "package.json").write_text(
        json.dumps(
            {
                "name": "@kungfu-tech/kfx-view-versioned",
                "version": "1.0.0",
                "kungfuConfig": {
                    "key": "versioned-view",
                    "config": {"view": {}},
                },
            }
        ),
        encoding="utf-8",
    )
    skill_dir = tmp_path / "versioned-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                "key: versioned-skill",
                "kfx:",
                "  - key: versioned-view",
                "    version: 2.0.0",
                "    required: false",
                "---",
                "",
                "# versioned-skill",
            ]
        ),
        encoding="utf-8",
    )

    binding = build_skill_dependency_binding(home, parse_skill(skill_dir))
    row = binding["dependencies"][0]

    assert binding["summary"] == {"total": 1, "resolved": 0, "unresolved": 1}
    assert row["status"] == "unresolved"
    assert row["required"] is False
    assert "does not match 2.0.0" in row["reason"]


def test_skill_audit_records_dependency_binding_event(tmp_path):
    skill = parse_skill(_fixture("with-frontmatter"))
    binding = build_skill_dependency_binding(tmp_path / "home", skill)
    event = skill_dependencies_bound_event(binding)

    assert event["type"] == "SkillDependenciesBound"
    assert event["skill"]["key"] == "trace-failure-investigator"
    assert event["summary"]["total"] == 2
    assert [row["status"] for row in event["dependencies"]] == [
        "unresolved",
        "unresolved",
    ]
