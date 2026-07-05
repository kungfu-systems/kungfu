# SPDX-License-Identifier: Apache-2.0

from pathlib import Path

from kungfu.skill import build_catalog, build_context_envelope, parse_skill


def _repo_root():
    return Path(__file__).resolve().parents[4]


def _fixture(name):
    return _repo_root() / "framework" / "skill" / "fixtures" / name


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
