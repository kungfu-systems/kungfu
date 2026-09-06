# SPDX-License-Identifier: Apache-2.0

"""KFX package lifecycle and WASM execution commands."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

import click

from kungfu import kfx_contract
from kungfu.cli.commands import kfc
from kungfu.cli.kfx_authority import native_authority_file
from kungfu.kfx_host import authorize_host_launch
from kungfu.storage import service as storage_service

kfx_command_context = kfc.pass_context()


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


@click.command(help="install a kfx package (npm pack tgz, or a package directory)")
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


@click.command(name="list", help="list kfx installed for this home")
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


@click.command(
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


@click.command(help="remove an installed kfx by its key")
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
    if os.path.realpath(dest.parent) != os.path.realpath(_install_root(ctx)):
        click.echo(f"[kfx] invalid key: {key}", err=True)
        sys.exit(1)
    if not dest.is_dir():
        click.echo(f"[kfx] not installed: {key}", err=True)
        sys.exit(1)
    try:
        kfx_contract.read_manifest_from_dir(dest)
        authority = native_authority_file(authority_file)
        application = _native_mutation(ctx, None, key, "remove", authority)
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        raise click.ClickException(str(error)) from error
    click.echo(f"[kfx] removed {key} (Fact Cut revision {application['revision']})")


@click.command(help="inspect and validate a kfx package manifest")
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


PACKAGE_COMMANDS = (install, list_installed, run_wasm, remove, inspect)
