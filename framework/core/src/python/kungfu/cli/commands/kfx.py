#  SPDX-License-Identifier: Apache-2.0
#
# `kungfu kfx` — install, list and remove kfx packages for this home.
#
# A kfx is an npm package whose package.json carries a `kungfuConfig`
# manifest; `npm pack` of such a package is its distribution unit. Install
# extracts the package into `<home>/extensions/<key>` — the install root the
# GUI shell and the runtime scan — so a single tgz is a complete, offline
# installable unit. Suites (meta packages whose members arrive as their own
# packages) install the same way; members are installed individually.

import click
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

from kungfu import kfx_contract
from kungfu.cli.commands import kfc, PrioritizedCommandGroup
from kungfu.rewind import first_party

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


def _read_manifest_from_dir(package_dir):
    return kfx_contract.read_manifest_from_dir(package_dir)


def _read_manifest_from_tgz(tgz):
    return kfx_contract.read_manifest_from_tgz(tgz)


def _kind(manifest):
    return kfx_contract.package_kind(manifest)


def _trusted(manifest):
    return first_party.is_first_party(kfx_contract.package_key(manifest))


def _trust_notice(manifest):
    """The install-time trust disclosure (ADR-0013): what tier each declared facet
    runs at, decided by whether the package is in the frozen first-party set —
    by verifiable source, never by the install path. Returns display lines."""
    config = (manifest.get("kungfuConfig") or {}).get("config") or {}
    trusted = _trusted(manifest)
    origin = "first-party (trusted)" if trusted else "third-party (untrusted)"
    lines = [f"[kfx] trust: {origin} — granted by source, not by install path"]
    if "view" in config:
        tier = (
            "node-integrated (shares the shell, full access)"
            if trusted
            else "sandboxed-ipc (isolated renderer, only its declared capabilities)"
        )
        lines.append(f"[kfx]   view runs {tier}")
    if "adapter" in config and not trusted:
        lines.append(
            "[kfx]   adapter will be REFUSED at trace time: an adapter runs "
            "in-process in the traced program and cannot be sandboxed, so only a "
            "source-verified first-party adapter may inject"
        )
    elif "adapter" in config:
        lines.append("[kfx]   adapter may inject into traced runs (in-process)")
    if "wasm" in config:
        lines.append(
            "[kfx]   wasm is VM-confined, but every declared host capability "
            "still requires an explicit run-time grant"
        )
    return lines


def _wasm_run_spec(package_dir, manifest, grants):
    config = (manifest.get("kungfuConfig") or {}).get("config") or {}
    wasm = config.get("wasm")
    if not isinstance(wasm, dict):
        raise ValueError("package has no kungfuConfig.config.wasm facet")
    declared = set(wasm.get("capabilities") or [])
    granted = set(grants)
    if granted != declared:
        missing = sorted(declared - granted)
        extra = sorted(granted - declared)
        detail = ", ".join(
            part
            for part in [
                f"missing grants: {', '.join(missing)}" if missing else "",
                f"undeclared grants: {', '.join(extra)}" if extra else "",
            ]
            if part
        )
        raise ValueError(
            "manifest declarations do not grant authority; pass one explicit "
            f"--grant per declared capability ({detail})"
        )
    root = Path(package_dir).resolve()
    module = (root / str(wasm["entry"])).resolve()
    if root not in module.parents or not module.is_file():
        raise ValueError("wasm entry must be a file inside the installed package")
    actual_hash = hashlib.sha256(module.read_bytes()).hexdigest()
    if actual_hash != wasm["sha256"]:
        raise ValueError("wasm entry SHA-256 does not match package.json")
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


@kfx.command(help="install a kfx package (npm pack tgz, or a package directory)")
@click.argument("source", type=click.Path(exists=True))
@click.option(
    "--force", is_flag=True, help="replace an existing install of the same key"
)
@kfx_command_context
def install(ctx, source, force):
    is_tgz = os.path.isfile(source)
    try:
        manifest = (
            _read_manifest_from_tgz(source)
            if is_tgz
            else _read_manifest_from_dir(source)
        )
    except (OSError, KeyError, ValueError, json.JSONDecodeError, tarfile.TarError) as e:
        click.echo(f"[kfx] unreadable package manifest: {e}", err=True)
        sys.exit(1)
    key = kfx_contract.package_key(manifest)
    if not key:
        click.echo(
            "[kfx] package.json has no kungfuConfig.key — not a kfx package", err=True
        )
        sys.exit(1)

    dest = os.path.join(_install_root(ctx), key)
    if os.path.exists(dest):
        if not force:
            click.echo(
                f"[kfx] {key} is already installed (use --force to replace)", err=True
            )
            sys.exit(1)
        shutil.rmtree(dest)
    os.makedirs(dest, exist_ok=True)

    if is_tgz:
        # npm tgz layout: everything under the package/ prefix
        with tarfile.open(source, "r:gz") as archive:
            members = [m for m in archive.getmembers() if m.name.startswith("package/")]
            for member in members:
                member.name = member.name[len("package/") :]
            archive.extractall(
                dest, members=[m for m in members if m.name], filter="data"
            )
    else:
        shutil.copytree(source, dest, dirs_exist_ok=True)

    click.echo(
        f"[kfx] installed {manifest.get('name', key)}@{manifest.get('version', '?')} "
        f"({_kind(manifest)}) -> {dest}"
    )
    for line in _trust_notice(manifest):
        click.echo(line)


@kfx.command(name="list", help="list kfx installed for this home")
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfx_command_context
def list_installed(ctx, as_json):
    root = _install_root(ctx)
    rows = []
    if os.path.isdir(root):
        for name in sorted(os.listdir(root)):
            package_dir = os.path.join(root, name)
            manifest_path = os.path.join(package_dir, "package.json")
            if not os.path.isfile(manifest_path):
                continue
            try:
                manifest = _read_manifest_from_dir(package_dir)
            except (OSError, ValueError, json.JSONDecodeError):
                rows.append({"key": name, "error": "unreadable package.json"})
                continue
            key = kfx_contract.package_key(manifest) or name
            rows.append(
                {
                    "key": key,
                    "package": manifest.get("name"),
                    "version": manifest.get("version"),
                    "kind": kfx_contract.package_kind(manifest, package_dir),
                    "trusted": _trusted(manifest),
                    "path": package_dir,
                }
            )
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
            trust = "first-party" if row["trusted"] else "third-party"
            click.echo(
                f"{row['key']}  {row['package']}@{row['version']}  "
                f"({row['kind']}, {trust})"
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
        manifest = _read_manifest_from_dir(package_dir)
        wasm, module = _wasm_run_spec(package_dir, manifest, grants)
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
@kfx_command_context
def remove(ctx, key):
    dest = os.path.join(_install_root(ctx), key)
    # uninstall is scoped to the managed install root; never touch elsewhere
    if os.path.realpath(os.path.dirname(dest)) != os.path.realpath(_install_root(ctx)):
        click.echo(f"[kfx] invalid key: {key}", err=True)
        sys.exit(1)
    if not os.path.isdir(dest):
        click.echo(f"[kfx] not installed: {key}", err=True)
        sys.exit(1)
    shutil.rmtree(dest)
    click.echo(f"[kfx] removed {key}")


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


@kfx.command(help="inspect and validate a kfx package manifest")
@click.argument("source", type=click.Path(exists=True))
@click.option("--json", "as_json", is_flag=True, help="machine-readable output")
@kfx_command_context
def inspect(ctx, source, as_json):
    is_tgz = os.path.isfile(source)
    try:
        manifest = (
            _read_manifest_from_tgz(source)
            if is_tgz
            else _read_manifest_from_dir(source)
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
