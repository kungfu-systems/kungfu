#  SPDX-License-Identifier: Apache-2.0
#
# Read-only reader over an Atlas-style control-plane repository. It touches
# exactly three source surfaces, tolerates missing directories, unreadable
# files and unknown fields, and never writes to the source repository:
#
#   agent-journal/missions/registry/{active,archive}/*.json  mission cards
#   agent-journal/goals/registry/{active,archive}/*.json     goal cards
#   reviews/worktree-status/*.json                           ready markers
#
# Only known, pointer-like fields are extracted (identifiers, statuses,
# paths, refs, short summaries); everything else in the source files is
# ignored by construction.

import json
import os
import subprocess


def _read_json(path, warnings):
    try:
        with open(path) as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
        warnings.append(f"{path}: not a JSON object")
    except (OSError, json.JSONDecodeError) as e:
        warnings.append(f"{path}: {e}")
    return None


def _cards(root, warnings, required=True):
    if not os.path.isdir(root):
        # a missing archive/ is a normal empty state; only required
        # surfaces are worth a diagnostic
        if required:
            warnings.append(f"{root}: missing directory")
        return
    for name in sorted(os.listdir(root)):
        if not name.endswith(".json"):
            continue
        card = _read_json(os.path.join(root, name), warnings)
        if card is not None:
            yield card


def _text(value):
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def repo_head(repo_root):
    """Best-effort source revision; None when the root is not a Git repo."""
    try:
        out = subprocess.run(
            ["git", "-C", repo_root, "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
        return out.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def read_missions(repo_root, warnings):
    missions = []
    base = os.path.join(repo_root, "agent-journal", "missions", "registry")
    for state in ("active", "archive"):
        for card in _cards(
            os.path.join(base, state), warnings, required=state == "active"
        ):
            stage = card.get("current_stage")
            stage = stage if isinstance(stage, dict) else {}
            missions.append(
                {
                    "mission_id": _text(card.get("mission_id")),
                    "title": _text(card.get("title")),
                    "status": _text(card.get("status")),
                    "active_lens": _text(card.get("active_lens")),
                    "stage_name": _text(stage.get("name")),
                    "next_review": _text(stage.get("next_review")),
                    "next_action": _text(card.get("next_action")),
                }
            )
    return [card for card in missions if card["mission_id"]]


def read_goals(repo_root, warnings):
    goals = []
    base = os.path.join(repo_root, "agent-journal", "goals", "registry")
    for state, archived in (("active", False), ("archive", True)):
        for card in _cards(
            os.path.join(base, state), warnings, required=state == "active"
        ):
            goals.append(
                {
                    "goal_id": _text(card.get("goal_id")),
                    "status": _text(card.get("status")),
                    "title": _text(card.get("title")),
                    "owner_agent": _text(card.get("owner_agent")),
                    "mission_id": _text(card.get("mission_id")),
                    "lens": _text(card.get("lens")),
                    "mission_stage": _text(card.get("mission_stage")),
                    "source_branch": _text(card.get("source_branch")),
                    "worktree_path": _text(card.get("worktree_path")),
                    "external_repo_path": _text(card.get("external_repo_path")),
                    "external_branch": _text(card.get("external_branch")),
                    "external_head": _text(card.get("external_head")),
                    "external_ready_ref": _text(card.get("external_ready_ref")),
                    "latest_marker": _text(card.get("latest_marker")),
                    "summary": _text(card.get("summary")),
                    "next_action": _text(card.get("next_action")),
                    "archived": bool(card.get("archived", archived)),
                }
            )
    return [card for card in goals if card["goal_id"]]


def read_markers(repo_root, warnings):
    markers = []
    base = os.path.join(repo_root, "reviews", "worktree-status")
    if not os.path.isdir(base):
        warnings.append(f"{base}: missing directory")
        return markers
    for name in sorted(os.listdir(base)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(base, name)
        card = _read_json(path, warnings)
        if card is None:
            continue
        markers.append(
            {
                "branch": _text(card.get("branch")),
                "status": _text(card.get("status")),
                "ready": bool(card.get("ready")),
                "ready_scope": _text(card.get("ready_scope")),
                "keep_source_worktree": bool(card.get("keep_source_worktree")),
                "worktree_path": _text(card.get("worktree_path")),
                "summary": _text(card.get("summary")),
                "risk": _text(card.get("risk")),
                "marker_path": os.path.relpath(path, repo_root),
            }
        )
    return [card for card in markers if card["branch"]]


def read_control_plane(repo_root):
    """One defensive pass over the three source surfaces.

    Returns (missions, goals, markers, warnings); warnings are diagnostic
    strings, never raised.
    """
    warnings = []
    missions = read_missions(repo_root, warnings)
    goals = read_goals(repo_root, warnings)
    markers = read_markers(repo_root, warnings)
    return missions, goals, markers, warnings
