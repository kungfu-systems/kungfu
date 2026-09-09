#  SPDX-License-Identifier: Apache-2.0
#
# `kungfu kfx` — install, list and remove kfx packages for this home.
#
# A KFX package carries semantic authority in `kungfu.kfx.json`; package.json
# is transport metadata only.
# manifest; `npm pack` of such a package is its distribution unit. Install
# extracts the package into `<home>/extensions/<key>` — the install root the
# GUI shell and the runtime scan — so a single tgz is a complete, offline
# installable unit. Suites (meta packages whose members arrive as their own
# packages) install the same way; members are installed individually.

import click
import json
import sys
from pathlib import Path

from kungfu import kfx_contract
from kungfu.cli.commands import kfc, PrioritizedCommandGroup
from kungfu.cli.kfx_authority import native_authority_file, native_json_file
from kungfu.storage import service as storage_service

from . import kfx_package as _kfx_package

PACKAGE_COMMANDS = _kfx_package.PACKAGE_COMMANDS
_authority_notice = _kfx_package._authority_notice
_extract_package_tgz = _kfx_package._extract_package_tgz
_install_root = _kfx_package._install_root
_libwasm_host = _kfx_package._libwasm_host
_native_authority_file = native_authority_file
_native_mutation = _kfx_package._native_mutation
_wasm_run_spec = _kfx_package._wasm_run_spec
inspect = _kfx_package.inspect
install = _kfx_package.install
list_installed = _kfx_package.list_installed
remove = _kfx_package.remove
run_wasm = _kfx_package.run_wasm

kfx_command_context = kfc.pass_context()


@kfc.group(
    cls=PrioritizedCommandGroup,
    help_priority=2,
    help="install, list and remove kfx packages for this home",
)
@click.help_option("-h", "--help")
@kfc.pass_context()
def kfx(ctx):
    pass


for _package_command in PACKAGE_COMMANDS:
    kfx.add_command(_package_command)
del _package_command


@kfx.command(help="print the kfx contract metadata")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfx_command_context
def contract(ctx, as_json):
    try:
        data = kfx_contract.load_contract()
        metadata = kfx_contract.contract_metadata()
        data["path"] = metadata["path"]
        data["hash"] = metadata["hash"]
    except (OSError, ValueError, json.JSONDecodeError) as e:
        click.echo(f"[kfx] failed to load contract: {e}", err=True)
        sys.exit(1)
    if as_json:
        click.echo(json.dumps(data, indent=2, sort_keys=True))
        return
    click.echo(json.dumps(data, indent=2, sort_keys=True))


@kfx.command(help="print the kfx package manifest JSON schema")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfx_command_context
def schema(ctx, as_json):
    try:
        data = kfx_contract.package_manifest_schema()
    except (OSError, ValueError, json.JSONDecodeError) as e:
        click.echo(f"[kfx] failed to load schema: {e}", err=True)
        sys.exit(1)
    if as_json:
        click.echo(json.dumps(data, indent=2, sort_keys=True))
        return
    click.echo(json.dumps(data, indent=2, sort_keys=True))


@kfx.command(name="profile-schema", help="print the KFX Profile Suite JSON schema")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfx_command_context
def profile_schema(ctx, as_json):
    try:
        data = kfx_contract.profile_suite_schema()
    except (OSError, ValueError, json.JSONDecodeError) as e:
        click.echo(f"[kfx] failed to load Profile Suite schema: {e}", err=True)
        sys.exit(1)
    if as_json:
        click.echo(json.dumps(data, indent=2, sort_keys=True))
        return
    click.echo(json.dumps(data, indent=2, sort_keys=True))


@kfx.group(
    name="native",
    help="inspect the Core-native KFX semantic registry, plan, and lifecycle",
)
@click.help_option("-h", "--help")
@kfx_command_context
def native_group(ctx):
    pass


def _native_roots(values):
    roots = []
    for value in values:
        kind, separator, path = value.partition("=")
        if not separator or kind not in {"product", "user", "workspace"} or not path:
            raise click.BadParameter(
                "roots use product=PATH, user=PATH, or workspace=PATH",
                param_hint="--root",
            )
        roots.append({"kind": kind, "path": str(Path(path).expanduser().resolve())})
    return roots


def _native_query(ctx, action, roots, **values):
    request = {"roots": _native_roots(roots), **values}
    click.echo(
        json.dumps(
            storage_service.kfx_registry(action, request, ctx.runtime_dir),
            indent=2,
            sort_keys=True,
        )
    )


@native_group.command(name="list", help="list canonical KFX package candidates")
@click.option("--root", "roots", multiple=True, required=True, help="KIND=PATH")
@kfx_command_context
def native_list(ctx, roots):
    _native_query(ctx, "list", roots)


@native_group.command(name="inspect", help="inspect one exact KFX package closure")
@click.argument("package_key")
@click.option("--root", "roots", multiple=True, required=True, help="KIND=PATH")
@kfx_command_context
def native_inspect(ctx, package_key, roots):
    _native_query(ctx, "inspect", roots, packageKey=package_key)


@native_group.command(name="resolve", help="resolve one KFX Suite and Profile closure")
@click.argument("suite_key")
@click.option("--root", "roots", multiple=True, required=True, help="KIND=PATH")
@kfx_command_context
def native_resolve(ctx, suite_key, roots):
    _native_query(ctx, "resolve", roots, suiteKey=suite_key)


@native_group.command(name="plan", help="print the canonical fenced KFX load plan")
@click.option("--root", "roots", multiple=True, required=True, help="KIND=PATH")
@kfx_command_context
def native_plan(ctx, roots):
    _native_query(ctx, "plan", roots)


@native_group.command(
    name="history", help="print immutable native KFX lifecycle receipts"
)
@click.option("--package-key", default="", help="filter receipts by package key")
@kfx_command_context
def native_history(ctx, package_key):
    request = {"packageKey": package_key} if package_key else {}
    click.echo(
        json.dumps(
            storage_service.kfx_registry("history", request, ctx.runtime_dir),
            indent=2,
            sort_keys=True,
        )
    )


@native_group.command(name="status", help="print native KFX registry authority status")
@click.option("--root", "roots", multiple=True, required=True, help="KIND=PATH")
@kfx_command_context
def native_status(ctx, roots):
    _native_query(ctx, "status", roots)


@native_group.group(
    name="control",
    help="operate the Control Suite through public identity-neutral KFX Fact/Work",
)
@click.help_option("-h", "--help")
@kfx_command_context
def native_control(ctx):
    pass


def _control_request(candidate, operation):
    request = {
        "controller": "kungfu-kfx-control-suite",
        "packageKey": "kfx-manager",
        "operation": operation,
    }
    if candidate:
        request["roots"] = [
            {"kind": "product", "path": str(Path(candidate).expanduser().resolve())}
        ]
    return request


@native_control.command(
    name="status", help="show Core-derived active/LKG/safe-mode state"
)
@kfx_command_context
def native_control_status(ctx):
    click.echo(
        json.dumps(
            storage_service.kfx_registry(
                "status",
                {"controller": "kungfu-kfx-control-suite"},
                ctx.runtime_dir,
            ),
            indent=2,
            sort_keys=True,
        )
    )


@native_control.command(
    name="plan", help="plan an exact Control Suite install or update"
)
@click.argument("candidate", type=click.Path(exists=True, file_okay=False))
@click.option("--operation", type=click.Choice(["install", "update"]), required=True)
@click.option(
    "--authority-file",
    required=True,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help="JSON evidence for Core Release Passport and Warrant recomputation",
)
@kfx_command_context
def native_control_plan(ctx, candidate, operation, authority_file):
    request = {
        **native_authority_file(authority_file),
        **_control_request(candidate, operation),
    }
    click.echo(
        json.dumps(
            storage_service.kfx_registry(
                "plan",
                request,
                ctx.runtime_dir,
            ),
            indent=2,
            sort_keys=True,
        )
    )


@native_control.command(
    name="apply", help="apply one still-current authorized Control Suite plan"
)
@click.argument("candidate", type=click.Path(exists=True, file_okay=False))
@click.argument(
    "plan_file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option(
    "--authority-file",
    required=True,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help="the same JSON evidence used to form the authorized plan",
)
@click.option(
    "--authorized-by",
    required=True,
    help="audit actor label only; this value grants no authority",
)
@kfx_command_context
def native_control_apply(ctx, candidate, plan_file, authority_file, authorized_by):
    plan = native_json_file(plan_file, "Control Suite plan")
    load_plan = plan.get("loadPlan") or {}
    package = next(
        (
            item
            for item in load_plan.get("packages", [])
            if item.get("key") == "kfx-manager"
        ),
        None,
    )
    if not package:
        raise click.BadParameter(
            "Control Suite plan does not contain kfx-manager", param_hint="plan_file"
        )
    request = {
        **native_authority_file(authority_file),
        **_control_request(candidate, str(plan.get("operation") or "")),
        "expectedCutRoot": load_plan.get("cutRoot"),
        "expectedRevision": load_plan.get("revision"),
        "expectedRegistryRoot": load_plan.get("registryRoot"),
        "expectedGraphRoot": load_plan.get("graphRoot"),
        "expectedPlanRoot": load_plan.get("planRoot"),
        "expectedTrustRoot": package.get("trustRoot"),
        "expectedPackageRoot": package.get("packageRoot"),
        "expectedControlPlanRoot": plan.get("controlPlanRoot"),
        "expectedBootstrapPolicyRoot": plan.get("bootstrapPolicyRoot"),
        "expectedAuthorizationPlanRoot": plan.get("authorizationPlanRoot"),
        "expectedCapabilityGrantRoot": plan.get("capabilityGrantRoot"),
        "expectedWarrantRoot": plan.get("warrantRoot"),
        "actor": authorized_by,
    }
    click.echo(
        json.dumps(
            storage_service.kfx_registry("apply", request, ctx.runtime_dir),
            indent=2,
            sort_keys=True,
        )
    )


@native_group.command(
    name="assess",
    help="produce the Core TrustReport and operation-specific admission plan",
)
@click.argument("package_key")
@click.option("--root", "roots", multiple=True, required=True, help="KIND=PATH")
@click.option(
    "--operation",
    type=click.Choice(
        [
            "inspect",
            "install",
            "update",
            "enable",
            "activate",
            "host-placement",
            "capability",
            "migration",
        ]
    ),
    required=True,
)
@click.option("--purpose", required=True)
@click.option("--cut", required=True)
@click.option("--assessment-time", type=int, required=True)
@click.option(
    "--attestation", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option(
    "--identity", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option(
    "--trust-inputs", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option(
    "--kfd-assessment",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
)
@click.option(
    "--policy",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    required=True,
)
@click.option(
    "--runtime-evidence", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option("--requested-capability", "requested_capabilities", multiple=True)
@click.option("--capability-expansion", is_flag=True)
@click.option("--cached-dependency-root")
@kfx_command_context
def native_assess(
    ctx,
    package_key,
    roots,
    operation,
    purpose,
    cut,
    assessment_time,
    attestation,
    identity,
    trust_inputs,
    kfd_assessment,
    policy,
    runtime_evidence,
    requested_capabilities,
    capability_expansion,
    cached_dependency_root,
):
    values = {
        "packageKey": package_key,
        "operation": operation,
        "purpose": purpose,
        "cut": cut,
        "assessmentTime": assessment_time,
        "policy": native_json_file(policy, "policy"),
        "requestedCapabilities": list(requested_capabilities),
        "capabilityExpansion": capability_expansion,
    }
    if attestation is not None:
        values["attestation"] = native_json_file(attestation, "attestation")
    if identity is not None:
        values["identity"] = native_json_file(identity, "identity")
    if trust_inputs is not None:
        values["trustInputs"] = native_json_file(trust_inputs, "trust inputs")
    if kfd_assessment is not None:
        values["kfdAssessment"] = native_json_file(kfd_assessment, "KFD assessment")
    if runtime_evidence is not None:
        values["runtimeEvidence"] = native_json_file(
            runtime_evidence, "runtime evidence"
        )
    if cached_dependency_root is not None:
        values["cachedDependencyRoot"] = cached_dependency_root
    _native_query(ctx, "assess", roots, **values)


@kfx.group(
    name="profile", help="inspect and operate Core-owned Profile Suite lifecycle facts"
)
@click.help_option("-h", "--help")
@kfx_command_context
def profile_group(ctx):
    pass


def _profile_json(value):
    click.echo(json.dumps(value, indent=2, sort_keys=True))


def _profile_member_roots(values):
    roots = {}
    for value in values:
        key, separator, root = value.partition("=")
        if not separator or not key or not root:
            raise click.BadParameter(
                "member roots use KEY=sha256:...", param_hint="--member-root"
            )
        if key in roots:
            raise click.BadParameter(
                f"duplicate member root: {key}", param_hint="--member-root"
            )
        roots[key] = root
    return roots


@profile_group.command(
    name="contract", help="print the Profile lifecycle runtime contract"
)
@kfx_command_context
def profile_contract(ctx):
    _profile_json(storage_service.profile_lifecycle(ctx.runtime_dir, "contract"))


@profile_group.command(
    name="inspect", help="verify a Profile document and its complete content closure"
)
@click.argument(
    "profile_path", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option(
    "--member-root",
    "member_roots",
    multiple=True,
    required=True,
    help="KEY=sha256:... member content root",
)
@kfx_command_context
def profile_inspect(ctx, profile_path, member_roots):
    try:
        _profile_json(
            storage_service.profile_lifecycle(
                ctx.runtime_dir,
                "inspect",
                profile_path=str(profile_path.resolve()),
                member_roots=_profile_member_roots(member_roots),
            )
        )
    except (RuntimeError, ValueError) as error:
        raise click.ClickException(str(error)) from error


@profile_group.command(
    name="plan", help="preview a fail-closed Profile lifecycle change"
)
@click.argument(
    "action",
    type=click.Choice(
        ["install", "qualify", "activate", "upgrade", "rollback", "remove"]
    ),
)
@click.option(
    "--profile-path", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option("--profile-id", type=str)
@click.option("--target-root", type=str)
@click.option("--expected-current-root", type=str)
@click.option(
    "--grant", "grants", multiple=True, help="permission to grant during activation"
)
@click.option(
    "--member-root",
    "member_roots",
    multiple=True,
    help="KEY=sha256:... member content root",
)
@kfx_command_context
def profile_plan(
    ctx,
    action,
    profile_path,
    profile_id,
    target_root,
    expected_current_root,
    grants,
    member_roots,
):
    request = {"action": action}
    if profile_path is not None:
        request["profile_path"] = str(profile_path.resolve())
    if profile_id:
        request["profile_id"] = profile_id
    if target_root:
        request["target_root"] = target_root
    if expected_current_root:
        request["expected_current_root"] = expected_current_root
    if grants:
        request["granted_permissions"] = list(grants)
    if member_roots:
        request["member_roots"] = _profile_member_roots(member_roots)
    try:
        _profile_json(
            storage_service.profile_lifecycle(ctx.runtime_dir, "plan", request=request)
        )
    except (RuntimeError, ValueError) as error:
        raise click.ClickException(str(error)) from error


@profile_group.command(
    name="apply", help="apply an authorized, still-current Profile lifecycle plan"
)
@click.argument(
    "plan_file", type=click.Path(exists=True, dir_okay=False, path_type=Path)
)
@click.option("--authorization-id", required=True, type=str)
@kfx_command_context
def profile_apply(ctx, plan_file, authorization_id):
    try:
        plan = json.loads(plan_file.read_text(encoding="utf-8"))
        _profile_json(
            storage_service.profile_lifecycle(
                ctx.runtime_dir,
                "apply",
                plan=plan,
                authorization_id=authorization_id,
            )
        )
    except (OSError, json.JSONDecodeError, RuntimeError, ValueError) as error:
        raise click.ClickException(str(error)) from error


@profile_group.command(name="list", help="list current Profile lifecycle state")
@click.option("--include-removed", is_flag=True)
@kfx_command_context
def profile_list(ctx, include_removed):
    _profile_json(
        storage_service.profile_lifecycle(
            ctx.runtime_dir, "list", include_removed=include_removed
        )
    )


@profile_group.command(name="get", help="show one current Profile state")
@click.argument("profile_id", type=str)
@click.option("--include-removed", is_flag=True)
@click.option("--cut-system-time", type=int, default=0)
@kfx_command_context
def profile_get(ctx, profile_id, include_removed, cut_system_time):
    _profile_json(
        storage_service.profile_lifecycle(
            ctx.runtime_dir,
            "get",
            profile_id=profile_id,
            include_removed=include_removed,
            cut_system_time=cut_system_time,
        )
    )


@profile_group.command(
    name="history", help="show append-only lifecycle facts for one Profile"
)
@click.argument("profile_id", type=str)
@kfx_command_context
def profile_history(ctx, profile_id):
    _profile_json(
        storage_service.profile_lifecycle(
            ctx.runtime_dir, "history", profile_id=profile_id
        )
    )
