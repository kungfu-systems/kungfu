#  SPDX-License-Identifier: Apache-2.0

import json
import subprocess
from pathlib import Path

from kungfu.project_cut_read_model import inspect_project_cut


ROOT_A = f"sha256:{'a' * 64}"
ROOT_B = f"sha256:{'b' * 64}"
ROOT_C = f"sha256:{'c' * 64}"


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


def initialize(repo: Path) -> None:
    git(repo, "init")
    git(repo, "config", "user.name", "Project Cut Test")
    git(repo, "config", "user.email", "project-cut@example.invalid")


def write_cut(repo: Path, cut_root: str, parents=None, receipt=True) -> None:
    directory = (
        repo / ".kungfu" / "project-cuts" / "sha256" / cut_root[7:9] / cut_root[7:]
    )
    directory.mkdir(parents=True)
    manifest = {
        "schema": "project.cut/v1",
        "project": {"id": "fixture", "identityRoot": ROOT_C},
        "parentCutRoots": parents or [],
        "sourceProjection": {
            "schema": "project.source-projection-ref/v1",
            "root": ROOT_A,
            "policyRoot": ROOT_B,
        },
        "atlas": {
            "schema": "xinfa.atlas-ref/v1",
            "root": ROOT_B,
            "compilerRoot": ROOT_C,
        },
        "episodeDelta": {
            "schema": "kungfu.episode-delta-ref/v1",
            "empty": True,
            "nativeRoots": [],
            "semanticRoot": None,
            "equivalenceProfileRoot": None,
        },
        "omissions": [],
        "conflicts": [],
        "unknowns": [],
        "cutRoot": cut_root,
    }
    (directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    if receipt:
        (directory / "receipt.json").write_text(
            json.dumps(
                {
                    "schema": "project.cut.receipt/v1",
                    "cutRoot": cut_root,
                    "verdict": "valid",
                }
            ),
            encoding="utf-8",
        )


def commit_cuts(repo: Path, message="publish Project Cut") -> None:
    git(repo, "add", ".kungfu/project-cuts")
    git(repo, "commit", "-m", message)


def publish(repo: Path, cut_root: str, parents=None, receipt=True) -> None:
    write_cut(repo, cut_root, parents, receipt)
    commit_cuts(repo, f"publish {cut_root[7:15]}")


def test_uninitialized_and_missing_are_explicit_and_read_only(tmp_path):
    assert inspect_project_cut(tmp_path)["status"] == "uninitialized"
    assert list(tmp_path.iterdir()) == []

    initialize(tmp_path)
    projection = inspect_project_cut(tmp_path)
    assert projection["status"] == "missing"
    assert projection["nextActions"] == ["begin"]
    assert not (tmp_path / ".kungfu").exists()


def test_one_reachable_leaf_is_current(tmp_path):
    initialize(tmp_path)
    publish(tmp_path, ROOT_A)
    publish(tmp_path, ROOT_B, [ROOT_A])

    projection = inspect_project_cut(tmp_path)
    assert projection["status"] == "current"
    assert projection["confidence"] == "high"
    assert projection["current"]["cutRoot"] == ROOT_B
    assert projection["current"]["receiptValid"] is True


def test_multiple_reachable_leaves_fail_visible(tmp_path):
    initialize(tmp_path)
    write_cut(tmp_path, ROOT_A)
    write_cut(tmp_path, ROOT_B)
    commit_cuts(tmp_path)

    projection = inspect_project_cut(tmp_path)
    assert projection["status"] == "conflicted"
    assert projection["current"] is None
    assert "multiple-current-project-cuts" in projection["gaps"]


def test_latest_publication_wins_over_unrelated_historical_chain(tmp_path):
    initialize(tmp_path)
    publish(tmp_path, ROOT_A)
    publish(tmp_path, ROOT_B)

    projection = inspect_project_cut(tmp_path)
    assert projection["status"] == "current"
    assert projection["current"]["cutRoot"] == ROOT_B
    assert projection["historyCount"] == 2


def test_missing_receipt_is_thin_not_current(tmp_path):
    initialize(tmp_path)
    publish(tmp_path, ROOT_A, receipt=False)

    projection = inspect_project_cut(tmp_path)
    assert projection["status"] == "thin"
    assert projection["confidence"] == "medium"
    assert projection["current"]["receiptValid"] is False


def test_untracked_or_modified_receipt_cannot_raise_or_lower_published_confidence(
    tmp_path,
):
    initialize(tmp_path)
    publish(tmp_path, ROOT_A, receipt=False)
    receipt_path = next(
        tmp_path.glob(".kungfu/project-cuts/**/manifest.json")
    ).with_name("receipt.json")
    receipt_path.write_text(
        json.dumps(
            {
                "schema": "project.cut.receipt/v1",
                "cutRoot": ROOT_A,
                "verdict": "valid",
            }
        ),
        encoding="utf-8",
    )
    assert inspect_project_cut(tmp_path)["status"] == "thin"

    git(tmp_path, "add", str(receipt_path.relative_to(tmp_path)))
    git(tmp_path, "commit", "-m", "publish receipt")
    receipt_path.write_text("{}", encoding="utf-8")
    projection = inspect_project_cut(tmp_path)
    assert projection["status"] == "current"
    assert projection["current"]["receiptValid"] is True
