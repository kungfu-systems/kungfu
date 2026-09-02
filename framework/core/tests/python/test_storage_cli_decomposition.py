# SPDX-License-Identifier: Apache-2.0

import ast
import hashlib
import inspect
from pathlib import Path

from kungfu.cli.commands import storage as storage_cli
from kungfu.storage import cli_episode as _storage_episode


EPISODE_NAMES = (
    "episode",
    "_run_episode_write",
    "begin",
    "heartbeat",
    "attach_frame",
    "attach_ref",
    "attach_payload",
    "episode_end",
    "episode_abort",
    "episode_recover",
    "episode_list",
    "episode_inspect",
    "episode_rebuild_projection",
)

RELOCATED_BODY_NAMES = tuple(
    name for name in EPISODE_NAMES if name != "_run_episode_write"
)

EPISODE_BODY_ROOT = "8ca0068023c66de9af2c7540198429eb32a8b7088cbcf503b9ec562462c570be"


def _source_path(module) -> Path:
    return Path(inspect.getsourcefile(module) or "")


def _definition_body_root(path: Path) -> str:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    definitions = {
        node.name: node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in RELOCATED_BODY_NAMES
    }
    payload = []
    for name in RELOCATED_BODY_NAMES:
        node = definitions[name]
        node.decorator_list = []
        payload.append(ast.dump(node, include_attributes=False))
    return hashlib.sha256("\n".join(payload).encode()).hexdigest()


def test_storage_cli_responsibility_modules_stay_below_1000_lines() -> None:
    assert (
        len(_source_path(storage_cli).read_text(encoding="utf-8").splitlines()) < 1000
    )
    assert (
        len(_source_path(_storage_episode).read_text(encoding="utf-8").splitlines())
        < 1000
    )


def test_storage_cli_preserves_command_tree_and_order() -> None:
    assert list(storage_cli.storage.commands) == [
        "backend",
        "durability-reconcile",
        "projection-candidate-status",
        "layout",
        "status",
        "fsck",
        "repair",
        "export",
        "import",
        "rebuild-index",
        "query",
        "episode",
        "gc",
        "compact",
        "verify-sync",
    ]
    assert list(storage_cli.episode.commands) == [
        "begin",
        "heartbeat",
        "attach-frame",
        "attach-ref",
        "attach-payload",
        "end",
        "abort",
        "recover",
        "list",
        "inspect",
        "rebuild-projection",
    ]


def test_storage_cli_keeps_episode_names_on_the_public_facade() -> None:
    for name in EPISODE_NAMES:
        assert getattr(storage_cli, name) is getattr(_storage_episode, name)
    for command in (
        storage_cli.episode,
        storage_cli.begin,
        storage_cli.heartbeat,
        storage_cli.attach_frame,
        storage_cli.attach_ref,
        storage_cli.attach_payload,
        storage_cli.episode_end,
        storage_cli.episode_abort,
        storage_cli.episode_recover,
        storage_cli.episode_list,
        storage_cli.episode_inspect,
        storage_cli.episode_rebuild_projection,
    ):
        assert command.callback.__module__ == storage_cli.__name__
    assert storage_cli._run_episode_write.__module__ == storage_cli.__name__


def test_storage_cli_conserves_relocated_episode_definition_bodies() -> None:
    assert _definition_body_root(_source_path(_storage_episode)) == EPISODE_BODY_ROOT
