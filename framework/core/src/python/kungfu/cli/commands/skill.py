# SPDX-License-Identifier: Apache-2.0

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import click

from kungfu.cli.commands import PrioritizedCommandGroup, kfc
from kungfu.rewind.managed_cli import run_and_report
from kungfu.rewind.managed_run import managed_providers
from kungfu.skill import (
    SkillError,
    append_audit_event,
    build_catalog,
    build_context_envelope,
    build_skill_context,
    discover_skills,
    find_skill,
    has_advertised_skills,
    load_skill_context_file,
    parse_skill,
    read_audit_file,
    read_skill_markdown,
    skill_loaded_event,
)

skill_command_context = kfc.pass_context()


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="manage Kungfu Skills and build agent context catalogs",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def skill(ctx):
    pass


def _json(data):
    click.echo(json.dumps(data, indent=2, sort_keys=True))


def _extra_paths(paths):
    return [os.path.abspath(path) for path in paths]


def _repo_root():
    return Path(__file__).resolve().parents[7]


def _node_context_script():
    return _repo_root() / "framework" / "skill" / "scripts" / "context.mjs"


def _write_envelope_file(envelope):
    fd, path = tempfile.mkstemp(prefix="kungfu-skill-context-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(envelope, f, indent=2, sort_keys=True)
        f.write("\n")
    return path


def _write_node_envelope_file(ctx, paths, source, profile, agent):
    node = shutil.which("node")
    if not node:
        raise SkillError("node manager requested, but node is not available on PATH")
    script = _node_context_script()
    if not script.exists():
        raise SkillError(
            "node manager script is not available in this runtime; "
            "pass --skill-context-file from a GUI/Node manager instead"
        )
    fd, out = tempfile.mkstemp(prefix="kungfu-skill-context-node-", suffix=".json")
    os.close(fd)
    argv = [
        node,
        "--experimental-transform-types",
        str(script),
        "--home",
        ctx.home,
        "--source",
        source,
        "--manager",
        "node",
        "--out",
        out,
    ]
    if profile:
        argv.extend(["--profile", profile])
    if agent:
        argv.extend(["--agent", agent])
    for path in paths:
        argv.extend(["--path", path])
    proc = subprocess.run(argv, text=True, capture_output=True, check=False)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip()
        raise SkillError(f"node manager context failed: {detail}")
    return out


def _default_skill_audit_log(ctx):
    return os.path.join(ctx.runtime_dir, "skill-audit.jsonl")


def _bundle_audit_path(ctx, run_id, bundle_dir=None, audit_file=None):
    if audit_file:
        return audit_file
    if bundle_dir:
        return os.path.join(bundle_dir, "skill-audit.json")
    if run_id:
        return os.path.join(
            ctx.runtime_dir, "rewind", run_id, "bundle", "skill-audit.json"
        )
    raise SkillError("pass --run-id, --bundle, or --audit-file")


def _verify_response_text(text, expected_schema, expected_key, expected_hash):
    if not text:
        return ["provider response text is empty"]
    failures = []
    parsed = None
    try:
        parsed = json.loads(text)
    except ValueError:
        parsed = None
    if parsed and isinstance(parsed, dict):
        if parsed.get("schema") != expected_schema:
            failures.append(f"schema mismatch: {parsed.get('schema')!r}")
        if parsed.get("skill_key") != expected_key:
            failures.append(f"skill_key mismatch: {parsed.get('skill_key')!r}")
        if parsed.get("advertised_hash") != expected_hash:
            failures.append(
                f"advertised_hash mismatch: {parsed.get('advertised_hash')!r}"
            )
        return failures
    checks = {
        "schema": expected_schema,
        "skill_key": expected_key,
        "advertised_hash": expected_hash,
    }
    for label, needle in checks.items():
        if needle not in text:
            failures.append(f"{label} not found in provider response")
    return failures


@skill.command(help="validate a Kungfu Skill source directory")
@click.argument("path", type=click.Path(exists=True))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def validate(ctx, path, as_json):
    try:
        parsed = parse_skill(path)
    except SkillError as e:
        if as_json:
            _json({"ok": False, "error": str(e)})
        else:
            click.echo(f"[skill] invalid: {e}", err=True)
        sys.exit(1)
    if as_json:
        _json({"ok": True, "skill": parsed})
    else:
        click.echo(
            f"[skill] ok {parsed['key']} ({parsed['kind']}) "
            f"from {parsed['source']['path']}"
        )


@skill.command(help="install a Kungfu Skill source directory into this home")
@click.argument("source", type=click.Path(exists=True))
@click.option("--force", is_flag=True, help="replace an existing skill install")
@skill_command_context
def install(ctx, source, force):
    try:
        parsed = parse_skill(source)
    except SkillError as e:
        click.echo(f"[skill] invalid: {e}", err=True)
        sys.exit(1)
    root = os.path.join(ctx.home, "skills")
    dest = os.path.join(root, parsed["key"])
    if os.path.exists(dest):
        if not force:
            click.echo(
                f"[skill] {parsed['key']} is already installed "
                "(use --force to replace)",
                err=True,
            )
            sys.exit(1)
        shutil.rmtree(dest)
    os.makedirs(root, exist_ok=True)
    shutil.copytree(source, dest)
    click.echo(f"[skill] installed {parsed['key']} -> {dest}")


@skill.command(name="list", help="list installed or path-provided Kungfu Skills")
@click.option("--path", "paths", multiple=True, type=click.Path(exists=True))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def list_skills(ctx, paths, as_json):
    rows = discover_skills(ctx.home, _extra_paths(paths))
    if as_json:
        _json(rows)
        return
    if not rows:
        click.echo(f"[skill] nothing found under {os.path.join(ctx.home, 'skills')}")
        return
    for row in rows:
        click.echo(f"{row['key']}  {row['title']}  ({row['kind']})")


@skill.command(help="print the compact agent-visible Kungfu Skill catalog")
@click.option("--path", "paths", multiple=True, type=click.Path(exists=True))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def catalog(ctx, paths, as_json):
    data = build_catalog(discover_skills(ctx.home, _extra_paths(paths)))
    if as_json:
        _json(data)
        return
    if not data["skills"]:
        click.echo("[skill] catalog is empty")
        return
    for row in data["skills"]:
        triggers = ", ".join(row["triggers"]) if row["triggers"] else "manual"
        click.echo(f"{row['key']}: {row['description']} [use: {triggers}]")


@skill.command(help="print a skill context envelope for an agent invocation")
@click.option("--path", "paths", multiple=True, type=click.Path(exists=True))
@click.option("--source", default="cli", type=click.Choice(["cli", "gui", "test"]))
@click.option("--manager", default="python", type=click.Choice(["python", "node"]))
@click.option("--profile", default=None, type=str)
@click.option("--agent", default=None, type=str)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def context(ctx, paths, source, manager, profile, agent, as_json):
    session = {"source": source, "manager": manager}
    if profile:
        session["profile"] = profile
    if agent:
        session["agent"] = agent
    data = build_context_envelope(
        build_catalog(discover_skills(ctx.home, _extra_paths(paths))),
        session,
    )
    _json(data)


@skill.command(help="verify that a provider receives and echoes the Skill envelope")
@click.option(
    "--provider",
    required=True,
    type=click.Choice(managed_providers()),
    help="provider CLI to run under managed-run",
)
@click.option("--path", "paths", multiple=True, type=click.Path(exists=True))
@click.option("--source", default=None, type=click.Choice(["cli", "gui", "test"]))
@click.option("--manager", default="python", type=click.Choice(["python", "node"]))
@click.option("--profile", default=None, type=str)
@click.option("--agent", default=None, type=str)
@click.option(
    "--skill-context-file",
    type=click.Path(exists=True),
    default=None,
    help="prebuilt skill context envelope generated by a manager",
)
@click.option("--prompt", default=None, help="override the verification prompt")
@click.option("--print-response", is_flag=True, help="print provider response text")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def verify(
    ctx,
    provider,
    paths,
    source,
    manager,
    profile,
    agent,
    skill_context_file,
    prompt,
    print_response,
    as_json,
):
    paths = _extra_paths(paths)
    source = source or ("gui" if manager == "node" else "cli")
    try:
        if skill_context_file:
            context_file = skill_context_file
            envelope = load_skill_context_file(context_file)
        elif manager == "node":
            context_file = _write_node_envelope_file(
                ctx, paths, source, profile, agent or provider
            )
            envelope = load_skill_context_file(context_file)
        else:
            envelope = build_skill_context(
                ctx.home,
                source=source,
                manager="python",
                profile=profile,
                agent=agent or provider,
                extra_paths=paths,
            )
            context_file = _write_envelope_file(envelope)
    except SkillError as e:
        click.echo(f"[skill] verify setup failed: {e}", err=True)
        sys.exit(1)

    if not has_advertised_skills(envelope):
        click.echo("[skill] verify failed: no advertised skills", err=True)
        sys.exit(1)

    expected_key = envelope["catalog"][0]["key"]
    expected_hash = envelope["audit"]["advertisedSkillsHash"]
    prompt = prompt or (
        "Read the Kungfu Skill context envelope above. "
        "Output only compact JSON with fields schema, skill_key, tool_name, "
        "advertised_hash, and no markdown. Use the first advertised skill for "
        "skill_key."
    )
    captured = {}

    def capture(report):
        captured["report"] = report

    exit_code = run_and_report(
        provider,
        prompt,
        runtime_dir=ctx.runtime_dir,
        home=ctx.home,
        skill_context_file=context_file,
        print_response=print_response,
        report_callback=capture,
        quiet=as_json,
    )
    report = captured.get("report")
    response_doc = report.response_doc if report else {}
    failures = _verify_response_text(
        response_doc.get("text"),
        "kungfu.skill-context/v1",
        expected_key,
        expected_hash,
    )
    ok = exit_code == 0 and not failures
    summary = {
        "ok": ok,
        "provider": provider,
        "manager": envelope.get("session", {}).get("manager"),
        "source": envelope.get("session", {}).get("source"),
        "skill_key": expected_key,
        "advertised_hash": expected_hash,
        "run_id": report.run_id if report else None,
        "response_path": report.response_path if report else None,
        "manifest_path": report.manifest_path if report else None,
        "skill_audit_path": report.skill_audit_path if report else None,
        "failures": failures,
    }
    if as_json:
        _json(summary)
    elif ok:
        click.echo(
            "[skill] verify ok "
            f"provider={provider} manager={summary['manager']} "
            f"skill={expected_key} hash={expected_hash}"
        )
        click.echo(f"[skill] response {summary['response_path']}")
        click.echo(f"[skill] proof {summary['manifest_path']}")
        if summary["skill_audit_path"]:
            click.echo(f"[skill] audit {summary['skill_audit_path']}")
    else:
        click.echo(f"[skill] verify failed: {', '.join(failures)}", err=True)
    if not ok:
        sys.exit(1)


@skill.command(help="load full SKILL.md by key or path")
@click.argument("key_or_path", type=str)
@click.option("--path", "paths", multiple=True, type=click.Path(exists=True))
@click.option("--run-id", default=None, help="associate this read with a run id")
@click.option(
    "--audit-file",
    type=click.Path(),
    default=None,
    help="append SkillLoaded audit event to this JSONL file",
)
@click.option("--no-audit", is_flag=True, help="do not write a SkillLoaded event")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def read(ctx, key_or_path, paths, run_id, audit_file, no_audit, as_json):
    try:
        parsed, markdown = read_skill_markdown(
            ctx.home, key_or_path, _extra_paths(paths)
        )
    except SkillError as e:
        click.echo(f"[skill] {e}", err=True)
        sys.exit(1)
    event = skill_loaded_event(
        parsed,
        markdown,
        run_id=run_id,
        source="cli",
        manager="python",
    )
    audit_path = None
    if not no_audit:
        audit_path = audit_file or _default_skill_audit_log(ctx)
        append_audit_event(audit_path, event)
    if as_json:
        _json(
            {
                "skill": parsed,
                "markdown": markdown,
                "audit": event,
                "audit_path": audit_path,
            }
        )
    else:
        click.echo(markdown, nl=False)


@skill.command(help="inspect Skill audit evidence for a managed run or audit file")
@click.option("--run-id", default=None, help="managed-run id under this runtime")
@click.option(
    "--bundle",
    "bundle_dir",
    type=click.Path(exists=True, file_okay=False),
    default=None,
    help="bundle directory containing skill-audit.json",
)
@click.option(
    "--audit-file",
    type=click.Path(exists=True),
    default=None,
    help="skill-audit.json or skill-audit.jsonl to inspect",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def audit(ctx, run_id, bundle_dir, audit_file, as_json):
    try:
        path = _bundle_audit_path(ctx, run_id, bundle_dir, audit_file)
        data = read_audit_file(path)
    except (OSError, SkillError, ValueError) as e:
        click.echo(f"[skill] audit unavailable: {e}", err=True)
        sys.exit(1)
    if as_json:
        _json(data)
        return
    click.echo(f"Skill audit: {data.get('run_id') or 'unscoped'}")
    for event in data.get("events", []):
        if event.get("type") == "SkillAdvertised":
            skills = ", ".join(row["key"] for row in event.get("skills", []))
            click.echo(
                "SkillAdvertised "
                f"run={event.get('run_id')} "
                f"manager={event.get('manager')} "
                f"source={event.get('source')} "
                f"skills={skills} "
                f"hash={event.get('advertisedSkillsHash')}"
            )
        elif event.get("type") == "SkillLoaded":
            skill_data = event.get("skill", {})
            click.echo(
                "SkillLoaded "
                f"run={event.get('run_id') or '-'} "
                f"manager={event.get('manager')} "
                f"source={event.get('source')} "
                f"skill={skill_data.get('key')} "
                f"hash={skill_data.get('contentHash')}"
            )
        else:
            click.echo(f"{event.get('type') or 'SkillAuditEvent'} {event}")


@skill.command(help="explain a Kungfu Skill without granting runtime privileges")
@click.argument("key_or_path", type=str)
@click.option("--path", "paths", multiple=True, type=click.Path(exists=True))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def explain(ctx, key_or_path, paths, as_json):
    try:
        parsed = find_skill(ctx.home, key_or_path, _extra_paths(paths))
    except SkillError as e:
        click.echo(f"[skill] {e}", err=True)
        sys.exit(1)
    explanation = {
        "key": parsed["key"],
        "title": parsed["title"],
        "kind": parsed["kind"],
        "sourceHash": parsed["source"]["hash"],
        "runtimePrivilege": "none"
        if parsed["kind"] == "instruction-only"
        else "requested-via-kfx-trust-gate",
        "kfx": parsed["kfx"],
        "capabilities": parsed["capabilities"],
        "trustBoundary": (
            "Skill instructions do not elevate permissions. Any executable "
            "dependency remains governed by the kfx trust gate."
        ),
    }
    if as_json:
        _json(explanation)
        return
    click.echo(f"{explanation['key']} — {explanation['title']}")
    click.echo(f"kind: {explanation['kind']}")
    click.echo(f"runtime privilege: {explanation['runtimePrivilege']}")
    click.echo(f"source hash: {explanation['sourceHash']}")
    click.echo(explanation["trustBoundary"])
