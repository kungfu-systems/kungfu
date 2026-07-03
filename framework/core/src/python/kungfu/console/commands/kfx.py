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
import json
import os
import shutil
import sys
import tarfile

from kungfu.console.commands import kfc, PrioritizedCommandGroup

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
    manifest_path = os.path.join(package_dir, "package.json")
    with open(manifest_path) as f:
        return json.load(f)


def _read_manifest_from_tgz(tgz):
    with tarfile.open(tgz, "r:gz") as archive:
        member = archive.getmember("package/package.json")
        with archive.extractfile(member) as f:
            return json.load(f)


def _kind(manifest):
    config = manifest.get("kungfuConfig", {})
    if "suite" in config:
        return "suite"
    facets = sorted((config.get("config") or {}).keys())
    return "+".join(facets) if facets else "unknown"


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
    except (OSError, KeyError, json.JSONDecodeError, tarfile.TarError) as e:
        click.echo(f"[kfx] unreadable package manifest: {e}", err=True)
        sys.exit(1)
    key = (manifest.get("kungfuConfig") or {}).get("key")
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
            except (OSError, json.JSONDecodeError):
                rows.append({"key": name, "error": "unreadable package.json"})
                continue
            config = manifest.get("kungfuConfig") or {}
            rows.append(
                {
                    "key": config.get("key", name),
                    "package": manifest.get("name"),
                    "version": manifest.get("version"),
                    "kind": _kind(manifest),
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
            click.echo(
                f"{row['key']}  {row['package']}@{row['version']}  ({row['kind']})"
            )


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
