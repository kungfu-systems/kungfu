# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timezone
import hashlib
import json
import os


AUDIT_SCHEMA = "kungfu.skill-audit/v1"
AUDIT_EVENT_SCHEMA = "kungfu.skill-audit-event/v1"


def skill_advertised_event(
    envelope,
    *,
    run_id,
    provider=None,
    work_id=None,
    context_file=None,
):
    session = dict(envelope.get("session") or {})
    audit = dict(envelope.get("audit") or {})
    return {
        "schema": AUDIT_EVENT_SCHEMA,
        "type": "SkillAdvertised",
        "at": _now(),
        "run_id": run_id,
        "work_id": work_id,
        "provider": provider,
        "source": session.get("source"),
        "manager": session.get("manager"),
        "profile": session.get("profile"),
        "agent": session.get("agent"),
        "context_file": context_file,
        "advertisedSkillsHash": audit.get("advertisedSkillsHash"),
        "tool_names": [tool.get("name") for tool in envelope.get("tools", [])],
        "skills": [_advertised_skill(row) for row in envelope.get("catalog", [])],
    }


def skill_loaded_event(
    skill,
    markdown,
    *,
    run_id=None,
    source="cli",
    manager="python",
    agent=None,
):
    content_hash = "sha256:" + hashlib.sha256(markdown.encode()).hexdigest()
    return {
        "schema": AUDIT_EVENT_SCHEMA,
        "type": "SkillLoaded",
        "at": _now(),
        "run_id": run_id,
        "source": source,
        "manager": manager,
        "agent": agent,
        "skill": {
            "key": skill["key"],
            "title": skill["title"],
            "kind": skill["kind"],
            "sourceHash": skill["source"]["hash"],
            "contentHash": content_hash,
            "sourcePath": skill["source"]["path"],
        },
        "load_method": "kungfu.skill.read",
    }


def skill_dependencies_bound_event(
    binding,
    *,
    source="cli",
    manager="python",
    agent=None,
):
    return {
        "schema": AUDIT_EVENT_SCHEMA,
        "type": "SkillDependenciesBound",
        "at": _now(),
        "source": source,
        "manager": manager,
        "agent": agent,
        "skill": dict(binding.get("skill") or {}),
        "summary": dict(binding.get("summary") or {}),
        "dependencies": [
            {
                "kfxKey": row.get("kfxKey"),
                "role": row.get("role"),
                "required": row.get("required"),
                "status": row.get("status"),
                "registryKey": row.get("registryKey"),
                "registryPath": row.get("registryPath"),
                "reason": row.get("reason"),
            }
            for row in binding.get("dependencies", [])
        ],
    }


def skill_audit_document(*, run_id=None, provider=None, work_id=None, events=None):
    rows = list(events or [])
    return {
        "schema": AUDIT_SCHEMA,
        "run_id": run_id,
        "provider": provider,
        "work_id": work_id,
        "event_count": len(rows),
        "events": rows,
    }


def write_audit_document(path, document):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(document, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")
    return file_sha256(path)


def append_audit_event(path, event):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False, sort_keys=True))
        f.write("\n")


def read_audit_file(path):
    with open(path, encoding="utf-8") as f:
        text = f.read().strip()
    if not text:
        return skill_audit_document(events=[])
    if text.startswith("{"):
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict) and parsed.get("schema") == AUDIT_SCHEMA:
            return parsed
    events = [json.loads(line) for line in text.splitlines() if line.strip()]
    run_id = events[-1].get("run_id") if events else None
    return skill_audit_document(run_id=run_id, events=events)


def file_sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def _advertised_skill(row):
    return {
        "key": row.get("key"),
        "title": row.get("title"),
        "kind": row.get("kind"),
        "loadPolicy": row.get("loadPolicy"),
        "sourceHash": row.get("sourceHash"),
    }


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
