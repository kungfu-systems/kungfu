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
    SkillRegistryError,
    append_audit_event,
    apply_plan,
    build_skill_dependency_binding,
    build_catalog,
    build_skill_context,
    dependency_coordinates,
    discover_skills,
    diagnose_registry,
    diff_revisions,
    find_skill,
    has_advertised_skills,
    load_skill_context_file,
    normalize_package,
    inspect_registry,
    parse_skill,
    plan_operation,
    read_audit_file,
    read_skill_markdown,
    registry_history,
    skill_loaded_event,
    skill_contract,
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


def _skill_context_env(ctx):
    env = dict(os.environ)
    env["KF_HOME"] = ctx.home
    env["KF_RUNTIME_DIR"] = ctx.runtime_dir
    if ctx.extension_path:
        env["KF_EXTENSION_PATH"] = ctx.extension_path
    return env


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
    proc = subprocess.run(
        argv, text=True, capture_output=True, check=False, env=_skill_context_env(ctx)
    )
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


@skill.command("contract", help="print the Skill contract metadata")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def contract_cmd(ctx, as_json):
    try:
        data = skill_contract.load_contract()
        metadata = skill_contract.contract_metadata()
        data["path"] = metadata["path"]
        data["hash"] = metadata["hash"]
    except (OSError, ValueError, json.JSONDecodeError, KeyError) as e:
        click.echo(f"[skill] failed to load contract: {e}", err=True)
        sys.exit(1)
    if as_json:
        _json(data)
        return
    click.echo(json.dumps(data, indent=2, sort_keys=True))


@skill.command("schema", help="print Skill JSON schemas")
@click.option(
    "--name",
    type=click.Choice(
        ["source", "catalog", "context", "dependencies", "manager", "definitionV2"]
    ),
    default=None,
    help="schema name; omit to print the whole schema bundle",
)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def schema_cmd(ctx, name, as_json):
    try:
        data = (
            skill_contract.load_schema(name) if name else skill_contract.schema_bundle()
        )
    except (OSError, ValueError, json.JSONDecodeError, KeyError) as e:
        click.echo(f"[skill] failed to load schema: {e}", err=True)
        sys.exit(1)
    if as_json:
        _json(data)
        return
    click.echo(json.dumps(data, indent=2, sort_keys=True))


@skill.command(help="validate a Kungfu Skill source directory")
@click.argument("path", type=click.Path(exists=True))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def validate(ctx, path, as_json):
    try:
        if any(
            (Path(path) / name).is_file()
            for name in ("skill-definition.json", "kungfu.skill.json")
        ):
            package = normalize_package(path)
            result = {"ok": True, "package": package}
            label = (
                f"{package['definition']['identity']['key']}@"
                f"{package['definition']['identity']['revision']} root={package['contentRoot']}"
            )
        else:
            parsed = parse_skill(path)
            result = {"ok": True, "skill": parsed}
            label = (
                f"{parsed['key']} ({parsed['kind']}) from {parsed['source']['path']}"
            )
    except (SkillError, SkillRegistryError) as e:
        if as_json:
            _json({"ok": False, "code": getattr(e, "code", "invalid"), "error": str(e)})
        else:
            click.echo(f"[skill] invalid: {e}", err=True)
        sys.exit(1)
    if as_json:
        _json(result)
    else:
        click.echo(f"[skill] ok {label}")


def _mutation_result(ctx, plan, execute, expected_plan_root, as_json):
    if not execute:
        if as_json:
            _json(plan)
        else:
            click.echo(
                f"[skill] plan {plan['operation']} {plan['request']['key']} "
                f"root={plan['planRoot']} changed={str(plan['changed']).lower()}"
            )
            click.echo(
                f"[skill] apply with --execute --expected-plan-root {plan['planRoot']}"
            )
        return
    if not expected_plan_root:
        raise SkillRegistryError(
            "expected-plan-root-required",
            "--execute requires --expected-plan-root from the exact plan",
        )
    receipt = apply_plan(ctx.home, plan, expected_plan_root=expected_plan_root)
    if as_json:
        _json(receipt)
    else:
        result = receipt["result"]
        click.echo(
            f"[skill] applied {receipt['operation']} "
            f"state={result['stateRoot']} generation={result['generation']} "
            f"receipt={receipt['receiptRoot']}"
        )


def _run_mutation(
    ctx,
    operation,
    *,
    key=None,
    source=None,
    work_ref=None,
    target_revision=None,
    execute=False,
    expected_plan_root=None,
    as_json=False,
):
    try:
        plan = plan_operation(
            ctx.home,
            operation,
            key=key,
            source=source,
            work_ref=work_ref,
            target_revision=target_revision,
        )
        _mutation_result(ctx, plan, execute, expected_plan_root, as_json)
    except SkillRegistryError as error:
        if as_json:
            _json({"ok": False, "code": error.code, "error": str(error)})
        else:
            click.echo(f"[skill] {error.code}: {error}", err=True)
        raise click.exceptions.Exit(1) from error


def _mutation_options(function):
    function = click.option(
        "--expected-plan-root",
        default=None,
        help="exact planRoot required for apply",
    )(function)
    function = click.option("--execute", is_flag=True, help="apply the exact plan")(
        function
    )
    function = click.option(
        "--json", "as_json", is_flag=True, help="machine-readable output"
    )(function)
    return function


@skill.command(help="plan or apply a Skill v2 package install")
@click.argument("source", type=click.Path(exists=True))
@click.option(
    "--force", is_flag=True, help="compatibility alias for an exact update plan"
)
@_mutation_options
@skill_command_context
def install(ctx, source, force, execute, expected_plan_root, as_json):
    _run_mutation(
        ctx,
        "update" if force else "install",
        source=source,
        execute=execute,
        expected_plan_root=expected_plan_root,
        as_json=as_json,
    )


@skill.command(help="plan or apply a compatible Skill v2 revision update")
@click.argument("source", type=click.Path(exists=True))
@_mutation_options
@skill_command_context
def update(ctx, source, execute, expected_plan_root, as_json):
    _run_mutation(
        ctx,
        "update",
        source=source,
        execute=execute,
        expected_plan_root=expected_plan_root,
        as_json=as_json,
    )


def _simple_mutation_command(name, help_text):
    def command(ctx, key, execute, expected_plan_root, as_json):
        _run_mutation(
            ctx,
            name,
            key=key,
            execute=execute,
            expected_plan_root=expected_plan_root,
            as_json=as_json,
        )

    command.__name__ = f"{name}_cmd"
    decorated = skill.command(name=name, help=help_text)(command)
    decorated = click.argument("key", type=str)(decorated)
    decorated = _mutation_options(decorated)
    return skill_command_context(decorated)


enable_cmd = _simple_mutation_command("enable", "plan or apply Skill enablement")
load_cmd = _simple_mutation_command("load", "plan or apply an exact Skill load state")
invoke_cmd = _simple_mutation_command(
    "invoke", "plan or apply an exact Skill invocation state"
)
suspend_cmd = _simple_mutation_command("suspend", "plan or apply Skill suspension")
retire_cmd = _simple_mutation_command("retire", "plan or apply Skill retirement")
remove_cmd = _simple_mutation_command(
    "remove", "plan or apply removal of active refs while retaining history"
)


@skill.command(help="plan or apply an exact Work-scoped Skill selection")
@click.argument("key", type=str)
@click.option("--work-ref", required=True, help="exact Kungfu Work reference")
@_mutation_options
@skill_command_context
def select(ctx, key, work_ref, execute, expected_plan_root, as_json):
    _run_mutation(
        ctx,
        "select",
        key=key,
        work_ref=work_ref,
        execute=execute,
        expected_plan_root=expected_plan_root,
        as_json=as_json,
    )


@skill.command(help="plan or apply an active-ref rollback to a retained revision")
@click.argument("key", type=str)
@click.option("--target-revision", required=True, type=int)
@_mutation_options
@skill_command_context
def rollback(ctx, key, target_revision, execute, expected_plan_root, as_json):
    _run_mutation(
        ctx,
        "rollback",
        key=key,
        target_revision=target_revision,
        execute=execute,
        expected_plan_root=expected_plan_root,
        as_json=as_json,
    )


@skill.command(help="inspect the canonical Skill registry fold")
@click.argument("key", required=False)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def inspect(ctx, key, as_json):
    try:
        result = inspect_registry(ctx.home, key)
    except SkillRegistryError as error:
        click.echo(f"[skill] {error.code}: {error}", err=True)
        raise click.exceptions.Exit(1) from error
    if as_json:
        _json(result)
    else:
        click.echo(
            f"Skill registry generation={result['generation']} root={result['stateRoot']}"
        )
        for entry in result["entries"].values():
            click.echo(
                f"{entry['key']}  {entry['status']}  revision={entry.get('activeRevision') or '-'}"
            )


@skill.command(help="inspect retained Skill lifecycle events and receipts")
@click.argument("key", required=False)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def history(ctx, key, as_json):
    result = registry_history(ctx.home, key)
    if as_json:
        _json(result)
    else:
        click.echo(json.dumps(result, indent=2, sort_keys=True))


@skill.command(help="verify registry roots, immutable packages, and recovery state")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def diagnose(ctx, as_json):
    result = diagnose_registry(ctx.home)
    if as_json:
        _json(result)
    else:
        click.echo(json.dumps(result, indent=2, sort_keys=True))
    if result["verdict"] != "pass":
        raise click.exceptions.Exit(1)


@skill.command(name="diff", help="diff two retained Skill definition revisions")
@click.argument("key")
@click.option("--left", required=True, type=int)
@click.option("--right", required=True, type=int)
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def diff_cmd(ctx, key, left, right, as_json):
    try:
        result = diff_revisions(ctx.home, key, left, right)
    except SkillRegistryError as error:
        click.echo(f"[skill] {error.code}: {error}", err=True)
        raise click.exceptions.Exit(1) from error
    if as_json:
        _json(result)
    else:
        click.echo(json.dumps(result, indent=2, sort_keys=True))


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
    paths = _extra_paths(paths)
    if manager == "node":
        data = load_skill_context_file(
            _write_node_envelope_file(ctx, paths, source, profile, agent)
        )
    else:
        data = build_skill_context(
            ctx.home,
            source=source,
            manager="python",
            profile=profile,
            agent=agent,
            extra_paths=paths,
            runtime_dir=ctx.runtime_dir,
            env=_skill_context_env(ctx),
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
                runtime_dir=ctx.runtime_dir,
                env=_skill_context_env(ctx),
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
        elif event.get("type") == "SkillDependenciesBound":
            skill_data = event.get("skill", {})
            summary = event.get("summary", {})
            click.echo(
                "SkillDependenciesBound "
                f"skill={skill_data.get('key')} "
                f"total={summary.get('total', 0)} "
                f"resolved={summary.get('resolved', 0)} "
                f"unresolved={summary.get('unresolved', 0)}"
            )
        else:
            click.echo(f"{event.get('type') or 'SkillAuditEvent'} {event}")


@skill.command(help="inspect declared kfx dependencies and registry bindings")
@click.argument("key_or_path", type=str)
@click.option("--path", "paths", multiple=True, type=click.Path(exists=True))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def deps(ctx, key_or_path, paths, as_json):
    coordinates = None
    try:
        coordinates = dependency_coordinates(ctx.home, key_or_path)
    except SkillRegistryError as e:
        if e.code != "skill-not-found":
            click.echo(f"[skill] {e}", err=True)
            sys.exit(1)
    if coordinates is not None:
        if as_json:
            _json(coordinates)
            return
        identity = coordinates["skill"]
        click.echo(
            f"{identity['key']}@{identity['revision']} exact dependency coordinates "
            "(admission not evaluated)"
        )
        for row in coordinates["dependencies"]["kfx"]:
            click.echo(
                f"kfx:{row['key']}@{row['revision']}#{row['root']} "
                f"required={str(row['required']).lower()} "
                f"capabilities={','.join(row['capabilityRequests']) or '-'}"
            )
        for row in coordinates["dependencies"]["profiles"]:
            click.echo(
                f"profile:{row['id']}@{row['revision']}#{row['root']} "
                f"required={str(row['required']).lower()} "
                f"contributions={','.join(row['contributions'])}"
            )
        return
    try:
        parsed = find_skill(ctx.home, key_or_path, _extra_paths(paths))
    except SkillError as e:
        click.echo(f"[skill] {e}", err=True)
        sys.exit(1)
    binding = build_skill_dependency_binding(ctx.home, parsed)
    if as_json:
        _json(binding)
        return
    summary = binding["summary"]
    click.echo(
        f"{parsed['key']} kfx dependencies: "
        f"{summary['total']} total, {summary['resolved']} resolved, "
        f"{summary['unresolved']} unresolved"
    )
    if not binding["dependencies"]:
        return
    for row in binding["dependencies"]:
        package = row.get("package") or {}
        label = (
            f"{package.get('name')}@{package.get('version')}"
            if package
            else row.get("reason")
        )
        click.echo(
            f"{row['status']}  {row['kfxKey']}  "
            f"role={row.get('role') or '-'}  {label}  {row['registryPath']}"
        )


@skill.command(help="explain a Kungfu Skill without granting runtime privileges")
@click.argument("key_or_path", type=str)
@click.option("--path", "paths", multiple=True, type=click.Path(exists=True))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@skill_command_context
def explain(ctx, key_or_path, paths, as_json):
    coordinates = None
    try:
        coordinates = dependency_coordinates(ctx.home, key_or_path)
    except SkillRegistryError as e:
        if e.code != "skill-not-found":
            click.echo(f"[skill] {e}", err=True)
            sys.exit(1)
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
        "dependencies": build_skill_dependency_binding(ctx.home, parsed),
        "capabilities": parsed["capabilities"],
        "trustBoundary": (
            "Skill instructions do not elevate permissions. Any executable "
            "dependency remains governed by the kfx trust gate."
        ),
    }
    if coordinates is not None:
        explanation["registryIdentity"] = coordinates["skill"]
        explanation["dependencies"] = coordinates
        explanation["kfx"] = coordinates["dependencies"]["kfx"]
    if as_json:
        _json(explanation)
        return
    click.echo(f"{explanation['key']} — {explanation['title']}")
    click.echo(f"kind: {explanation['kind']}")
    click.echo(f"runtime privilege: {explanation['runtimePrivilege']}")
    click.echo(f"source hash: {explanation['sourceHash']}")
    click.echo(explanation["trustBoundary"])
