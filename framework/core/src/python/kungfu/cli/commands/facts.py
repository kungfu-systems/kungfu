# SPDX-License-Identifier: Apache-2.0

import json
import sys
from pathlib import Path
from typing import Any

import click

from kungfu.cli.commands import PrioritizedCommandGroup, kfc

facts_command_context = kfc.pass_context()


def _load_object(file_path: str) -> dict[str, Any]:
    text = (
        sys.stdin.read()
        if file_path == "-"
        else Path(file_path).read_text(encoding="utf-8")
    )
    value = json.loads(text)
    if not isinstance(value, dict):
        raise click.BadParameter("input must be a JSON object", param_hint="--file")
    return value


def _emit(value: dict[str, Any]) -> None:
    click.echo(json.dumps(value, indent=2, sort_keys=True))


def _runtime_dir(ctx: click.Context) -> str:
    current: click.Context | None = ctx
    while current is not None:
        if hasattr(current, "runtime_dir"):
            return str(getattr(current, "runtime_dir"))
        current = current.parent
    raise click.ClickException("Kungfu runtime directory is unavailable")


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=4,
    help="declare, admit, and replay user or domain facts",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def facts(ctx: click.Context) -> None:
    del ctx
    pass


@facts.command(help="show the C++-owned declaration and admission contract")
@facts_command_context
def capabilities(ctx: click.Context) -> None:
    from kungfu.storage import service

    _emit(service.fact_contract(_runtime_dir(ctx)))


@facts.command("kernel", help="invoke the Core-owned generic Fact/Cut/ref kernel")
@click.option(
    "--action",
    type=click.Choice(
        [
            "capabilities",
            "object-put",
            "version-put",
            "relation-add",
            "relation-revoke",
            "cut-put",
            "ref-cas",
            "query",
        ]
    ),
    default="capabilities",
    show_default=True,
)
@click.option("--file", "file_path", default="", help="request JSON path or -")
@facts_command_context
def fact_kernel(ctx: click.Context, action: str, file_path: str) -> None:
    from kungfu.storage import service

    request = _load_object(file_path) if file_path else {}
    _emit(service.fact_kernel(_runtime_dir(ctx), action, request))


@facts.group("shadow", help="project and compare read-only Profile Fact views")
@click.help_option("-h", "--help")
def fact_shadow() -> None:
    pass


@fact_shadow.command("project", help="project Profile sources into one shadow Cut")
@click.option(
    "--file", "file_path", required=True, help="projection request JSON path or -"
)
@facts_command_context
def project_fact_shadow(ctx: click.Context, file_path: str) -> None:
    from kungfu.storage import service

    _emit(
        service.fact_profile_shadow_project(_runtime_dir(ctx), _load_object(file_path))
    )


@fact_shadow.command("inspect", help="inspect a shadow Cut with immutable bodies")
@click.option("--cut-root", default="", help="exact Fact Cut root")
@click.option("--ref", "ref_name", default="", help="named Fact ref")
@facts_command_context
def inspect_fact_shadow(ctx: click.Context, cut_root: str, ref_name: str) -> None:
    from kungfu.storage import service

    if bool(cut_root) == bool(ref_name):
        raise click.UsageError("provide exactly one of --cut-root or --ref")
    _emit(
        service.fact_profile_shadow_inspect(
            _runtime_dir(ctx), cut_root=cut_root, ref_name=ref_name
        )
    )


@fact_shadow.command(
    "compare", help="compare authoritative source JSON with one shadow Cut"
)
@click.option(
    "--file", "file_path", required=True, help="authoritative source JSON path or -"
)
@click.option("--cut-root", required=True, help="exact shadow Fact Cut root")
@facts_command_context
def compare_fact_shadow(ctx: click.Context, file_path: str, cut_root: str) -> None:
    from kungfu.storage import service

    actual = service.fact_profile_shadow_inspect(_runtime_dir(ctx), cut_root=cut_root)
    _emit(service.fact_profile_shadow_compare(_load_object(file_path), actual))


@facts.group("integrity", help="verify and port native Fact Cut authority")
@click.help_option("-h", "--help")
def fact_integrity() -> None:
    pass


@fact_integrity.command(
    "fsck", help="verify native objects, relations, Cuts, refs, and bodies"
)
@click.option("--cut-root", default="", help="optional exact Cut root")
@facts_command_context
def fsck_fact_kernel(ctx: click.Context, cut_root: str) -> None:
    from kungfu.storage import service

    _emit(service.fact_kernel_fsck(_runtime_dir(ctx), cut_root=cut_root))


@fact_integrity.command("export", help="export one exact portable Fact Cut closure")
@click.option("--out", "out_path", required=True, help="output JSON bundle path")
@click.option("--cut-root", default="", help="exact Fact Cut root")
@click.option("--ref", "ref_name", default="", help="named Fact ref")
@facts_command_context
def export_fact_kernel(
    ctx: click.Context, out_path: str, cut_root: str, ref_name: str
) -> None:
    from kungfu.storage import service

    if bool(cut_root) == bool(ref_name):
        raise click.UsageError("provide exactly one of --cut-root or --ref")
    bundle = service.fact_kernel_export(
        _runtime_dir(ctx), cut_root=cut_root, ref_name=ref_name
    )
    Path(out_path).write_text(
        json.dumps(bundle, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    _emit({"ok": True, "bundle_root": bundle["bundle_root"], "artifact": out_path})


@fact_integrity.command("import", help="verify or import one portable Fact Cut bundle")
@click.option("--file", "file_path", required=True, help="bundle JSON path or -")
@click.option("--execute", is_flag=True, help="append the verified closure")
@facts_command_context
def import_fact_kernel(ctx: click.Context, file_path: str, execute: bool) -> None:
    from kungfu.storage import service

    _emit(
        service.fact_kernel_import(
            _runtime_dir(ctx), _load_object(file_path), dry_run=not execute
        )
    )


@fact_integrity.command(
    "retention-plan", help="compute reachability without deleting data"
)
@click.option("--cut-root", "cut_roots", multiple=True, help="retained Cut root")
@facts_command_context
def plan_fact_retention(ctx: click.Context, cut_roots: tuple[str, ...]) -> None:
    from kungfu.storage import service

    _emit(
        service.fact_kernel_retention_plan(
            _runtime_dir(ctx), cut_roots=list(cut_roots) or None
        )
    )


@fact_integrity.command(
    "rebuild", help="replay the authority scan and prove stable roots"
)
@facts_command_context
def rebuild_fact_projections(ctx: click.Context) -> None:
    from kungfu.storage import service

    _emit(service.fact_kernel_rebuild_projections(_runtime_dir(ctx)))


@facts.command(help="show the managed Fact Library contract and fixed semantic profile")
@facts_command_context
def library(ctx: click.Context) -> None:
    from kungfu.storage import service

    _emit(service.fact_library_contract(_runtime_dir(ctx)))


@facts.command("export", help="export the selected Fact Library as a verified bundle")
@click.option("--out", "out_path", required=True, help="output JSON bundle path")
@click.option("--thin", is_flag=True, help="omit owned schema/payload/frame bytes")
@facts_command_context
def export_library(ctx: click.Context, out_path: str, thin: bool) -> None:
    from kungfu.storage import service

    bundle = service.fact_library_export(_runtime_dir(ctx), thin=thin)
    Path(out_path).write_text(
        json.dumps(bundle, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    _emit(
        {
            "schema": "kungfu.facts.library-export-receipt/v1",
            "ok": True,
            "mode": bundle["mode"],
            "episode_count": bundle["episode_count"],
            "artifact": str(Path(out_path)),
        }
    )


@facts.command("import", help="verify or import a Fact Library bundle")
@click.option(
    "--file", "file_path", required=True, help="library bundle JSON path or -"
)
@click.option(
    "--execute", is_flag=True, help="append verified material to this data root"
)
@facts_command_context
def import_library(ctx: click.Context, file_path: str, execute: bool) -> None:
    from kungfu.storage import service

    _emit(
        service.fact_library_import(
            _runtime_dir(ctx), _load_object(file_path), dry_run=not execute
        )
    )


@facts.group("type", help="create and inspect reusable versioned fact types")
@click.help_option("-h", "--help")
def fact_type() -> None:
    pass


@fact_type.command("create", help="create one managed JSON fact type")
@click.option("--id", "type_id", required=True, help="stable fact type id")
@click.option("--version", required=True, help="immutable version label")
@click.option(
    "--source",
    "sources",
    multiple=True,
    required=True,
    help="authorized source id; repeatable",
)
@click.option("--schema-file", required=True, help="JSON Schema path or -")
@click.option(
    "--contract-world-id", default="", help="optional stable contract-world id"
)
@click.option("--effective-from", type=click.IntRange(min=0), default=0)
@click.option("--effective-until", type=click.IntRange(min=0), default=0)
@click.option("--system-time", type=click.IntRange(min=0), default=0)
@click.pass_context
def create_fact_type(
    ctx: click.Context,
    type_id: str,
    version: str,
    sources: tuple[str, ...],
    schema_file: str,
    contract_world_id: str,
    effective_from: int,
    effective_until: int,
    system_time: int,
) -> None:
    from kungfu.storage import service

    definition: dict[str, Any] = {
        "id": type_id,
        "version": version,
        "source_authorities": list(sources),
        "schema": _load_object(schema_file),
        "effective_until": effective_until,
    }
    if contract_world_id:
        definition["contract_world_id"] = contract_world_id
    if effective_from:
        definition["effective_from"] = effective_from
    _emit(
        service.fact_type_create(_runtime_dir(ctx), definition, system_time=system_time)
    )


@fact_type.command("list", help="list fact types in the selected data root")
@click.option("--cut-system-time", type=click.IntRange(min=0), default=0)
@click.pass_context
def list_fact_types(ctx: click.Context, cut_system_time: int) -> None:
    from kungfu.storage import service

    _emit(service.fact_type_list(_runtime_dir(ctx), cut_system_time=cut_system_time))


@facts.group("material", help="add, correct, retract, and inspect fact material")
@click.help_option("-h", "--help")
def fact_material() -> None:
    pass


@fact_material.command("put", help="store JSON material and record its observation")
@click.option("--type", "type_id", required=True, help="exact fact type id")
@click.option("--type-version", required=True, help="exact fact type version")
@click.option("--source", "source_id", required=True, help="declared source id")
@click.option("--subject", "subject_key", required=True, help="stable subject key")
@click.option("--payload-file", required=True, help="JSON payload path or -")
@click.option(
    "--observation-id", default="", help="optional stable id; generated when omitted"
)
@click.option(
    "--action", type=click.Choice(["assert", "correct", "retract"]), default="assert"
)
@click.option(
    "--target",
    "target_observation_id",
    default="",
    help="required correction/retraction target",
)
@click.option("--valid-from", type=click.IntRange(min=0), default=0)
@click.option("--valid-until", type=click.IntRange(min=0), default=0)
@click.option("--system-time", type=click.IntRange(min=0), default=0)
@click.pass_context
def put_fact_material(
    ctx: click.Context,
    type_id: str,
    type_version: str,
    source_id: str,
    subject_key: str,
    payload_file: str,
    observation_id: str,
    action: str,
    target_observation_id: str,
    valid_from: int,
    valid_until: int,
    system_time: int,
) -> None:
    from kungfu.storage import service

    material: dict[str, Any] = {
        "type_id": type_id,
        "type_version": type_version,
        "source_id": source_id,
        "subject_key": subject_key,
        "payload": _load_object(payload_file),
        "action": action,
        "target_observation_id": target_observation_id,
        "valid_until": valid_until,
    }
    if observation_id:
        material["observation_id"] = observation_id
    if valid_from:
        material["valid_from"] = valid_from
    _emit(
        service.fact_material_put(_runtime_dir(ctx), material, system_time=system_time)
    )


@fact_material.command(
    "list", help="list current and historical material with payloads"
)
@click.option("--type", "type_id", default="")
@click.option("--subject", "subject_key", default="")
@click.option("--cut-system-time", type=click.IntRange(min=0), default=0)
@click.pass_context
def list_fact_material(
    ctx: click.Context, type_id: str, subject_key: str, cut_system_time: int
) -> None:
    from kungfu.storage import service

    _emit(
        service.fact_material_list(
            _runtime_dir(ctx),
            type_id=type_id,
            subject_key=subject_key,
            cut_system_time=cut_system_time,
        )
    )


@facts.command(
    "declare-world", help="append one effective-time contract-world declaration"
)
@click.option("--file", "file_path", required=True, help="declaration JSON path or -")
@click.option("--system-time", type=click.IntRange(min=0), default=0)
@facts_command_context
def declare_world(ctx: click.Context, file_path: str, system_time: int) -> None:
    from kungfu.storage import service

    _emit(
        service.fact_declare_contract_world(
            _runtime_dir(ctx), _load_object(file_path), system_time=system_time
        )
    )


@facts.command(
    "declare-surface", help="append one effective-time fact-surface declaration"
)
@click.option("--file", "file_path", required=True, help="declaration JSON path or -")
@click.option("--system-time", type=click.IntRange(min=0), default=0)
@facts_command_context
def declare_surface(ctx: click.Context, file_path: str, system_time: int) -> None:
    from kungfu.storage import service

    _emit(
        service.fact_declare_surface(
            _runtime_dir(ctx), _load_object(file_path), system_time=system_time
        )
    )


@facts.command(help="record one observation and its replayable admission decision")
@click.option("--file", "file_path", required=True, help="observation JSON path or -")
@click.option("--system-time", type=click.IntRange(min=0), default=0)
@facts_command_context
def observe(ctx: click.Context, file_path: str, system_time: int) -> None:
    from kungfu.storage import service

    _emit(
        service.fact_observe(
            _runtime_dir(ctx), _load_object(file_path), system_time=system_time
        )
    )


@facts.command(help="fold admitted facts at head or an exact system-time cut")
@click.option("--cut-system-time", type=click.IntRange(min=0), default=0)
@click.option("--subject-key", default="")
@facts_command_context
def state(ctx: click.Context, cut_system_time: int, subject_key: str) -> None:
    from kungfu.storage import service

    _emit(
        service.fact_state(
            _runtime_dir(ctx),
            cut_system_time=cut_system_time,
            subject_key=subject_key,
        )
    )
