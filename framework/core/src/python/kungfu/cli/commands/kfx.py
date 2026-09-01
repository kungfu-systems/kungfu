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
import hashlib
import json
import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

from kungfu import kfx_contract
from kungfu.cli.commands import kfc, PrioritizedCommandGroup
from kungfu.cli.kfx_authority import native_authority_file, native_json_file
from kungfu.kfx_host import authorize_host_launch
from kungfu.storage import service as storage_service

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


def _install_root(ctx):
    return os.path.join(ctx.home, "extensions")


def _authority_notice(package):
    """Report only Core-derived grade, placement class, and exact grants."""

    grant = package.get("authority") or {}
    roles = package.get("productRoles") or []
    return [
        "[kfx] authority: "
        f"supply-chain={package.get('supplyChainGrade', 'unverified')}, "
        f"admission={package.get('admissionGrade', 'unverified')}, "
        f"runtime={package.get('runtimeTier', 'isolated')}",
        "[kfx]   grants: "
        + (", ".join(package.get("grantedCapabilities") or []) or "none"),
        "[kfx]   capabilityGrantRoot: "
        + str(grant.get("capabilityGrantRoot") or "none"),
        "[kfx]   product roles are assembly metadata only: "
        + (", ".join(roles) or "none"),
    ]


def _wasm_run_spec(package_dir, manifest):
    config = (manifest.get("kungfuConfig") or {}).get("config") or {}
    wasm = config.get("wasm")
    if not isinstance(wasm, dict):
        raise ValueError("package has no kungfuConfig.config.wasm facet")
    root = Path(package_dir).resolve()
    module = (root / str(wasm["entry"])).resolve()
    if root not in module.parents or not module.is_file():
        raise ValueError("wasm entry must be a file inside the installed package")
    actual_hash = hashlib.sha256(module.read_bytes()).hexdigest()
    if actual_hash != wasm["sha256"]:
        raise ValueError("wasm entry SHA-256 does not match kungfu.kfx.json")
    return wasm, module


def _libwasm_host():
    name = "kungfu-wasm-host.exe" if os.name == "nt" else "kungfu-wasm-host"
    candidates = [
        os.environ.get("KUNGFU_LIBWASM_HOST"),
        str(Path(sys.executable).resolve().parent / name),
    ]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return candidate
    raise ValueError(
        "kungfu-wasm-host is not installed next to the runtime; this artifact "
        "does not carry the production libwasm closure"
    )


def _native_mutation(ctx, package_root, key, operation, authority, **values):
    request = {
        **authority,
        "packageKey": key,
        "operation": operation,
        **values,
    }
    if package_root is not None:
        request["roots"] = [{"kind": "user", "path": str(Path(package_root).resolve())}]
    plan = storage_service.kfx_registry("plan", request, ctx.runtime_dir)
    package = next(
        (item for item in plan["packages"] if item.get("key") == key),
        None,
    )
    if package is None:
        raise ValueError(f"native KFX plan did not contain package {key}")
    mutation = {
        **request,
        "expectedCutRoot": plan["cutRoot"],
        "expectedRevision": plan["revision"],
        "expectedRegistryRoot": plan["registryRoot"],
        "expectedGraphRoot": plan["graphRoot"],
        "expectedPlanRoot": plan["planRoot"],
        "expectedTrustRoot": package["trustRoot"],
        "expectedPackageRoot": package["packageRoot"],
        "expectedAuthorizationPlanRoot": plan["authorizationPlanRoot"],
        "expectedCapabilityGrantRoot": plan["capabilityGrantRoot"],
        "expectedWarrantRoot": plan["warrantRoot"],
        "actor": "kungfu-cli",
    }
    return storage_service.kfx_registry("apply", mutation, ctx.runtime_dir)


def _extract_package_tgz(source, package_root):
    package_root.mkdir(parents=True)
    with tarfile.open(source, "r:gz") as archive:
        members = [m for m in archive.getmembers() if m.name.startswith("package/")]
        for member in members:
            member.name = member.name[len("package/") :]
        archive.extractall(
            package_root,
            members=[m for m in members if m.name],
            filter="data",
        )


@kfx.command(help="install a kfx package (npm pack tgz, or a package directory)")
@click.argument("source", type=click.Path(exists=True))
@click.option(
    "--force", is_flag=True, help="replace an existing install of the same key"
)
@click.option(
    "--authority-file",
    required=True,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help="JSON evidence for Core Release Passport and Warrant recomputation",
)
@kfx_command_context
def install(ctx, source, force, authority_file):
    is_tgz = os.path.isfile(source)
    try:
        manifest = (
            kfx_contract.read_manifest_from_tgz(source)
            if is_tgz
            else kfx_contract.read_manifest_from_dir(source)
        )
    except (OSError, KeyError, ValueError, json.JSONDecodeError, tarfile.TarError) as e:
        click.echo(f"[kfx] unreadable package manifest: {e}", err=True)
        sys.exit(1)
    key = kfx_contract.package_key(manifest)
    if not key:
        click.echo(
            "[kfx] kungfu.kfx.json has no kungfuConfig.key — not a kfx package",
            err=True,
        )
        sys.exit(1)

    dest = Path(_install_root(ctx)) / key
    if dest.exists():
        if not force:
            click.echo(
                f"[kfx] {key} is already installed (use --force to replace)", err=True
            )
            sys.exit(1)
    operation = "update" if dest.exists() else "install"
    try:
        authority = native_authority_file(authority_file)
        if is_tgz:
            with tempfile.TemporaryDirectory(prefix="kungfu-kfx-package-") as temp:
                package_root = Path(temp) / "package"
                _extract_package_tgz(source, package_root)
                application = _native_mutation(
                    ctx,
                    package_root,
                    key,
                    operation,
                    authority,
                    replaceExisting=force,
                )
        else:
            application = _native_mutation(
                ctx,
                source,
                key,
                operation,
                authority,
                replaceExisting=force,
            )
    except (OSError, RuntimeError, ValueError) as error:
        raise click.ClickException(str(error)) from error

    click.echo(
        f"[kfx] installed {manifest.get('name', key)}@{manifest.get('version', '?')} "
        f"({kfx_contract.package_kind(manifest)}) -> {dest} "
        f"(Fact Cut revision {application['revision']})"
    )
    inspected = storage_service.kfx_registry(
        "inspect", {"packageKey": key}, ctx.runtime_dir
    )["package"]
    for line in _authority_notice(inspected):
        click.echo(line)


@kfx.command(name="list", help="list kfx installed for this home")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfx_command_context
def list_installed(ctx, as_json):
    root = _install_root(ctx)
    authority = storage_service.kfx_registry("list", {}, ctx.runtime_dir)
    rows = [
        {
            "key": package["key"],
            "package": package.get("name"),
            "version": package.get("version"),
            "kind": (
                "suite"
                if "profile-suite" in package.get("facets", [])
                else ",".join(package.get("facets", [])) or "package"
            ),
            "supplyChainGrade": package.get("supplyChainGrade", "unverified"),
            "admissionGrade": package.get("admissionGrade", "unverified"),
            "runtimeTier": package.get("runtimeTier", "isolated"),
            "grantedCapabilities": package.get("grantedCapabilities", []),
            "path": package.get("path"),
            "desiredState": package["desiredState"],
            "observedState": package["observedState"],
            "verdict": package["verdict"],
            "cutRoot": authority["cutRoot"],
            "revision": authority["revision"],
        }
        for package in authority["packages"]
    ]
    if as_json:
        click.echo(json.dumps(rows, indent=2, sort_keys=True))
        return
    if not rows:
        click.echo(f"[kfx] nothing installed under {root}")
        return
    for row in rows:
        if "error" in row:
            click.echo(f"{row['key']}  !{row['error']}")
        else:
            click.echo(
                f"{row['key']}  {row['package']}@{row['version']}  "
                f"({row['kind']}, admission={row['admissionGrade']}, "
                f"runtime={row['runtimeTier']}, "
                f"grants={','.join(row['grantedCapabilities']) or 'none'})"
            )


@kfx.command(
    "run-wasm",
    help="run an installed wasm kfx through the admitted production runtime",
)
@click.argument("key", type=str)
@click.option(
    "--grant",
    "grants",
    multiple=True,
    type=click.Choice(["journal.read.batch"]),
    help="explicit host capability consent; repeat for every declared capability",
)
@click.option("--source-namespace", required=True)
@click.option("--source-name", required=True)
@click.option(
    "--engine",
    type=click.Choice(["auto", "wasmtime", "wasmer"]),
    default="auto",
    show_default=True,
)
@kfx_command_context
def run_wasm(ctx, key, grants, source_namespace, source_name, engine):
    package_dir = os.path.join(_install_root(ctx), key)
    try:
        manifest = kfx_contract.read_manifest_from_dir(package_dir)
        wasm, module = _wasm_run_spec(package_dir, manifest)
        descriptor = storage_service.kfx_registry("plan", {}, ctx.runtime_dir)[
            "hostContract"
        ]
        candidate = next(
            (
                item
                for item in descriptor["runtimeAuthorizations"]
                if item.get("packageKey") == key and item.get("host") == "wasm"
            ),
            None,
        )
        if candidate is None:
            raise ValueError("Core has no WASM host authorization for this package")
        authorization = authorize_host_launch(
            descriptor, key, "wasm", candidate["authorizationRoot"]
        )
        if sorted(grants) != sorted(authorization["grantedCapabilities"]):
            raise ValueError(
                "explicit --grant values must equal the current Core capability grant"
            )
        storage_service.kfx_registry(
            "authorize-host",
            {
                "packageKey": key,
                "host": "wasm",
                "expectedCutRoot": descriptor["cutRoot"],
                "expectedRevision": descriptor["revision"],
                "expectedGenerationRoot": descriptor["generationRoot"],
                "expectedPackageRoot": authorization["packageRoot"],
                "expectedCapabilityGrantRoot": authorization["capabilityGrantRoot"],
                "expectedAuthorizationRoot": authorization["authorizationRoot"],
                "expectedGrantedCapabilities": authorization["grantedCapabilities"],
            },
            ctx.runtime_dir,
        )
        host = _libwasm_host()
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    limits = wasm["limits"]
    command = [
        host,
        "--runtime-dir",
        str(ctx.runtime_dir),
        "--module",
        str(module),
        "--package-key",
        key,
        "--package-root",
        authorization["packageRoot"],
        "--authorization-root",
        authorization["authorizationRoot"],
        "--capability-grant-root",
        authorization["capabilityGrantRoot"],
        "--generation-root",
        descriptor["generationRoot"],
        "--cut-root",
        descriptor["cutRoot"],
        "--revision",
        str(descriptor["revision"]),
        "--expected-sha256",
        wasm["sha256"],
        "--world",
        wasm["world"],
        "--capabilities",
        "1",
        "--fuel",
        str(limits["fuel"]),
        "--memory-pages",
        str(limits["memoryPages"]),
        "--batch-frames",
        str(limits["batchFrames"]),
        "--module-bytes",
        str(limits["moduleBytes"]),
        "--output-bytes",
        str(limits["outputBytes"]),
        "--source-namespace",
        source_namespace,
        "--source-name",
        source_name,
        "--engine",
        engine,
    ]
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if result.stdout:
        click.echo(result.stdout.rstrip())
    if result.returncode != 0:
        message = result.stderr.strip() or f"libwasm host exited {result.returncode}"
        raise click.ClickException(message)


@kfx.command(help="remove an installed kfx by its key")
@click.argument("key", type=str)
@click.option(
    "--authority-file",
    required=True,
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    help="JSON evidence containing the exact owner/system recovery Warrant",
)
@kfx_command_context
def remove(ctx, key, authority_file):
    dest = Path(_install_root(ctx)) / key
    # uninstall is scoped to the managed install root; never touch elsewhere
    if os.path.realpath(dest.parent) != os.path.realpath(_install_root(ctx)):
        click.echo(f"[kfx] invalid key: {key}", err=True)
        sys.exit(1)
    if not dest.is_dir():
        click.echo(f"[kfx] not installed: {key}", err=True)
        sys.exit(1)
    try:
        kfx_contract.read_manifest_from_dir(dest)
        authority = native_authority_file(authority_file)
        application = _native_mutation(
            ctx,
            None,
            key,
            "remove",
            authority,
        )
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    click.echo(f"[kfx] removed {key} (Fact Cut revision {application['revision']})")


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


@kfx.command(help="inspect and validate a kfx package manifest")
@click.argument("source", type=click.Path(exists=True))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfx_command_context
def inspect(ctx, source, as_json):
    is_tgz = os.path.isfile(source)
    try:
        manifest = (
            kfx_contract.read_manifest_from_tgz(source)
            if is_tgz
            else kfx_contract.read_manifest_from_dir(source)
        )
        data = {
            "schema": "kungfu.kfx.inspect/v1",
            "contract": kfx_contract.contract_metadata(),
            "source": os.path.abspath(source),
            "package": kfx_contract.package_summary(
                manifest,
                package_dir=None if is_tgz else source,
            ),
        }
    except (OSError, KeyError, ValueError, json.JSONDecodeError, tarfile.TarError) as e:
        click.echo(f"[kfx] invalid package manifest: {e}", err=True)
        sys.exit(1)
    if as_json:
        click.echo(json.dumps(data, indent=2, sort_keys=True))
        return
    package = data["package"]
    click.echo(
        f"{package.get('key')}  {package.get('name')}@{package.get('version')}  "
        f"({package.get('kind')})"
    )
