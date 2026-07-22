"""Read-only Project Cut discovery for the public Cut/Work facade."""

from __future__ import annotations

import json
import io
import subprocess
import tarfile
from pathlib import Path
from typing import Any


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=False
    )


def _tracked_documents(repo: Path) -> dict[str, dict[str, Any] | None]:
    """Read Project Cut bytes from HEAD, never from mutable working-tree files."""

    result = subprocess.run(
        ["git", "archive", "--format=tar", "HEAD", "--", ".kungfu/project-cuts"],
        cwd=repo,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        return {}
    documents: dict[str, dict[str, Any] | None] = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as archive:
            for member in archive.getmembers():
                if not member.isfile() or not member.name.endswith(".json"):
                    continue
                source = archive.extractfile(member)
                if source is None:
                    documents[member.name] = None
                    continue
                try:
                    value = json.loads(source.read().decode("utf-8"))
                except (UnicodeError, json.JSONDecodeError):
                    value = None
                documents[member.name] = value if isinstance(value, dict) else None
    except tarfile.TarError:
        return {}
    return documents


def _publication_index(repo: Path) -> dict[str, tuple[str, int]]:
    result = _git(
        repo,
        "log",
        "--format=commit:%H",
        "--name-only",
        "--",
        ".kungfu/project-cuts",
    )
    if result.returncode != 0:
        return {}
    current = ""
    rank = -1
    publications: dict[str, tuple[str, int]] = {}
    for line in result.stdout.splitlines():
        if line.startswith("commit:"):
            current = line.removeprefix("commit:")
            rank += 1
        elif line.endswith("/manifest.json") and line not in publications and current:
            publications[line] = (current, rank)
    return publications


def _source_dirty(repo: Path) -> bool:
    result = _git(repo, "status", "--porcelain", "--untracked-files=normal")
    if result.returncode != 0:
        return True
    ignored = (".kungfu/project-cuts/", ".kungfu/runtime/")
    return any(
        row[3:] and not row[3:].startswith(ignored)
        for row in result.stdout.splitlines()
    )


def inspect_project_cut(repo_input: str | Path = ".") -> dict[str, Any]:
    """Return one semantic read model without creating runtime state."""

    repo = Path(repo_input).resolve()
    if _git(repo, "rev-parse", "--is-inside-work-tree").stdout.strip() != "true":
        return {
            "schema": "kungfu.cut.read-model/v1",
            "status": "uninitialized",
            "confidence": "none",
            "current": None,
            "candidates": [],
            "gaps": ["git-workspace-missing"],
            "nextActions": ["open-or-initialize-git-workspace"],
            "authority": "git-tracked-project-cut",
        }

    rows: list[dict[str, Any]] = []
    gaps: list[str] = []
    publications = _publication_index(repo)
    documents = _tracked_documents(repo)
    manifests = sorted(name for name in documents if name.endswith("/manifest.json"))
    for manifest in manifests:
        cut = documents[manifest]
        if cut is None or cut.get("schema") != "project.cut/v1":
            gaps.append(f"invalid-manifest:{manifest}")
            continue
        cut_root = str(cut.get("cutRoot") or "")
        receipt_path = str(Path(manifest).with_name("receipt.json")).replace("\\", "/")
        receipt = documents.get(receipt_path)
        receipt_valid = bool(
            receipt
            and receipt.get("schema") == "project.cut.receipt/v1"
            and receipt.get("cutRoot") == cut_root
            and receipt.get("verdict") == "valid"
        )
        publication = publications.get(manifest)
        rows.append(
            {
                "cutRoot": cut_root,
                "parentCutRoots": list(cut.get("parentCutRoots") or []),
                "sourceRoot": (cut.get("sourceProjection") or {}).get("root"),
                "atlasRoot": (cut.get("atlas") or {}).get("root"),
                "episodeRoots": [
                    row.get("root")
                    for row in (cut.get("episodeDelta") or {}).get("nativeRoots", [])
                    if isinstance(row, dict) and row.get("root")
                ],
                "omissions": list(cut.get("omissions") or []),
                "conflicts": list(cut.get("conflicts") or []),
                "unknowns": list(cut.get("unknowns") or []),
                "manifest": manifest,
                "receipt": receipt_path if receipt is not None else None,
                "receiptValid": receipt_valid,
                "publicationCommit": publication[0] if publication else None,
                "publicationReachable": publication is not None,
                "publicationDistance": publication[1] if publication else None,
            }
        )

    reachable = [row for row in rows if row["publicationReachable"]]
    distances = [row["publicationDistance"] for row in reachable]
    nearest = min((value for value in distances if value is not None), default=None)
    cohort = [row for row in reachable if row["publicationDistance"] == nearest]
    cohort_parents = {
        parent for row in cohort for parent in row["parentCutRoots"] if parent
    }
    contenders = [row for row in cohort if row["cutRoot"] not in cohort_parents]
    current = contenders[0] if len(contenders) == 1 else None
    dirty = _source_dirty(repo)

    if not rows:
        status = "missing"
        gaps.append("project-cut-missing")
        next_actions = ["begin"]
        confidence = "none"
    elif len(contenders) > 1:
        status = "conflicted"
        gaps.append("multiple-current-project-cuts")
        next_actions = ["reconcile-project-cut-history"]
        confidence = "low"
    elif current is None:
        status = "stale"
        gaps.append("no-reachable-current-project-cut")
        next_actions = ["recover"]
        confidence = "low"
    elif dirty:
        status = "stale"
        gaps.append("source-changed-after-current-project-cut")
        next_actions = ["checkpoint", "complete", "recover"]
        confidence = "medium" if current["receiptValid"] else "low"
    elif not current["receiptValid"]:
        status = "thin"
        gaps.append("current-project-cut-receipt-missing-or-invalid")
        next_actions = ["recover", "export"]
        confidence = "medium"
    elif current["conflicts"] or current["unknowns"]:
        status = "degraded"
        next_actions = ["inspect-gaps", "recover"]
        confidence = "medium"
    else:
        status = "current"
        next_actions = ["begin", "resume", "export"]
        confidence = "high" if not current["omissions"] else "medium"

    return {
        "schema": "kungfu.cut.read-model/v1",
        "status": status,
        "confidence": confidence,
        "current": current,
        "candidates": contenders,
        "historyCount": len(rows),
        "sourceDirty": dirty,
        "gaps": sorted(set(gaps)),
        "nextActions": next_actions,
        "authority": "git-tracked-project-cut",
    }
