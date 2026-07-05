# SPDX-License-Identifier: Apache-2.0

from pathlib import Path
import json

from kungfu.skill import (
    append_audit_event,
    build_catalog,
    build_context_envelope,
    build_skill_context,
    inject_skill_context,
    parse_skill,
    read_audit_file,
    skill_advertised_event,
    skill_audit_document,
    skill_loaded_event,
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
    assert "Kungfu Skill context envelope" in injected
    assert injected.endswith("\n\nUser task:\nhello")


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
