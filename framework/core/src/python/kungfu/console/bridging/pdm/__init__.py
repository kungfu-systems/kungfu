#  SPDX-License-Identifier: Apache-2.0

import json
import os
import pathlib
import pkgutil
import sys

from kungfu.console import variants

from pdm.core import Core
from pdm.cli.commands.base import BaseCommand
from pdm.formats.base import array_of_inline_tables, make_inline_table
from pdm.models.requirements import parse_requirement
from pdm.project.core import tomlkit, Project


class MakeupCommand(BaseCommand):
    """Make up pyproject.toml according to settings in package.json"""

    @staticmethod
    def trim(toml_table):
        # Fix extra trailing newline
        body = toml_table.value.body
        body and body[-1] and body[-1][0] is None and body.pop()
        return toml_table

    @staticmethod
    def pdm_config_table(pdm_project, name):
        pdm_config = pdm_project.pyproject
        pdm_config.metadata[name] = pdm_config.metadata.get(name, tomlkit.table())
        return MakeupCommand.trim(pdm_config.metadata[name])

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--encoding",
            default="utf-8",
            help="Encoding of package.json, defaults to utf-8",
        )
        parser.set_defaults(search_parent=False)

    def handle(self, project, options):
        with open("package.json", mode="r", encoding=options.encoding) as file:
            package_json = json.load(file)

        author = package_json["author"]
        build_config = package_json.get("kungfuBuild", {})
        python_config = build_config.get("python", {})
        dependencies = python_config.get("dependencies", {})

        pdm_project = Project(Core(), ".")

        project = pdm_project.pyproject.metadata
        project["name"] = package_json.get("name", "").split("/").pop()
        project["license"] = make_inline_table(
            {"text": package_json.get("license", "")}
        )
        project["authors"] = array_of_inline_tables(
            [
                {
                    "name": author["name"] if isinstance(author, dict) else author,
                    "email": author["email"] if isinstance(author, dict) else "",
                }
            ]
        )
        project["dynamic"] = ["version"]
        project["requires-python"] = (
            f"~={sys.version_info.major}.{sys.version_info.minor}"
        )
        project["dependencies"] = project.get("dependencies", [])

        settings = pdm_project.pyproject.settings
        settings["version"] = make_inline_table({"use_scm": True})

        build_system = pdm_project.pyproject._data.setdefault("build-system", {})
        build_system["requires"] = ["pdm-pep517"]
        build_system["build-backend"] = "pdm.pep517.api"

        dependencies and pdm_project.add_dependencies(
            requirements={k: parse_requirement(k + v) for k, v in dependencies.items()},
            show_message=False,
        )
        pdm_project.pyproject.write()


class BridgingCore(Core):
    def __init__(self):
        try:
            from importlib import metadata

            metadata.version("pdm")
        except Exception:
            pass
        super().__init__()

    def init_parser(self):
        super().init_parser()
        try:
            from pdm.cli import commands

            next(pkgutil.iter_modules(commands.__path__))
        except StopIteration:
            self.register_pdm_commands()
        self.register_command(MakeupCommand, "makeup")

    def register_pdm_commands(self):
        from pdm.cli.commands import (
            add,
            build,
            cache,
            completion,
            config,
            export,
            import_cmd,
            info,
            init,
            install,
            list,
            lock,
            plugin,
            remove,
            run,
            search,
            show,
            sync,
            update,
            use,
        )

        for module in [
            add,
            build,
            cache,
            completion,
            config,
            export,
            import_cmd,
            info,
            init,
            install,
            list,
            lock,
            plugin,
            remove,
            run,
            search,
            show,
            sync,
            update,
            use,
        ]:
            try:
                cmd = module.Command
            except AttributeError:
                continue
            name = cmd.name or module.__name__.split(".").pop()
            self.register_command(cmd, name)


def main():
    variants.enable("python")
    os.environ.update(
        {
            "PDM_PYTHON": sys.executable,
            "PDM_CHECK_UPDATE": "false",
            "PDM_USE_VENV": "0",
        }
    )
    # Pass the forwarded arguments (engage_command_context put them in sys.argv)
    # explicitly, so the pdm subcommand is honoured rather than defaulting to the
    # bare help screen.
    BridgingCore().main(sys.argv[1:])
