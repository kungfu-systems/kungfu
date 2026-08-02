# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import os
import platform
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping
from xml.sax.saxutils import escape as xml_escape

from kungfu import host, runtime_paths
from kungfu.storage import service as storage_service


SCHEMA_PLAN = "kungfu.runtime.service-plan/v2"
SCHEMA_RESULT = "kungfu.runtime.service-result/v2"
SERVICE_ID = "tech.kungfu.supervisor"
SERVICE_NAME = "Kungfu Supervisor"
SUPERVISOR_ALWAYS_ON_ENV = "KF_SUPERVISOR_ALWAYS_ON"


def _shell_join(argv: list[str]) -> str:
    return (
        subprocess.list2cmdline(argv)
        if platform.system() == "Windows"
        else " ".join(shlex_quote(arg) for arg in argv)
    )


def shlex_quote(value: str) -> str:
    if not value:
        return "''"
    safe = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_@%+=:,./-"
    if all(ch in safe for ch in value):
        return value
    return "'" + value.replace("'", "'\"'\"'") + "'"


def _systemd_env_line(key: str, value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'Environment="{key}={escaped}"'


def _positive_generation(value: str | int, label: str) -> str:
    raw = str(value)
    if not raw.isdigit() or int(raw) <= 0 or int(raw) > (2**64 - 1):
        raise ValueError(f"{label} must be a positive uint64")
    return raw


def supervisor_state_dir(config_home: str | None = None) -> Path:
    return (
        Path(runtime_paths.resolve_config_home(config_home)) / "runtime" / "supervisor"
    )


def supervisor_log_path(config_home: str | None = None) -> Path:
    return supervisor_state_dir(config_home) / "supervisor.log"


def entry_command(runtime_image: Mapping[str, Any] | None = None) -> list[str]:
    from kungfu import runtime_upgrade

    image = runtime_image or runtime_upgrade.image_from_environment()
    if image is None:
        return host.entry_command()
    if image.get("schema") == runtime_upgrade.IMAGE_SCHEMA:
        return runtime_upgrade.pinned_entry_command(image)
    root = Path(str(image["artifactRoot"])).expanduser().resolve()
    entrypoint = (root / str(image["entrypoint"])).resolve()
    if root not in entrypoint.parents or not entrypoint.is_file():
        raise runtime_upgrade.UpgradeError(
            "entrypoint-missing",
            "pinned runtime entrypoint is missing or escapes the image root",
        )
    return [str(entrypoint)]


def command_env(
    home: str,
    runtime_dir: str,
    log_level: str,
    config_home: str | None = None,
    runtime_generation: str | int | None = None,
    runtime_image: Mapping[str, Any] | None = None,
) -> dict[str, str]:
    env = dict(os.environ)
    env["KF_HOME"] = home
    env["KF_RUNTIME_DIR"] = runtime_dir
    env["KF_CONFIG_HOME"] = runtime_paths.resolve_config_home(config_home)
    env["KF_LOG_LEVEL"] = log_level
    if runtime_generation is not None:
        env["KF_RUNTIME_GENERATION"] = _positive_generation(
            runtime_generation, "runtime generation"
        )
    if runtime_image is not None:
        from kungfu import runtime_upgrade

        if runtime_image.get("schema") == runtime_upgrade.IMAGE_SCHEMA:
            env.update(runtime_upgrade.pinned_environment(runtime_image))
        else:
            env.update(
                {
                    "KF_RUNTIME_BUILD_ID": str(runtime_image["buildId"]),
                    "KF_RUNTIME_ARTIFACT_ROOT": str(runtime_image["artifactRoot"]),
                    "KF_RUNTIME_ENTRYPOINT": str(runtime_image["entrypoint"]),
                    "KF_RUNTIME_MANIFEST_DIGEST": str(runtime_image["manifestDigest"]),
                }
            )
    return env


def _independent_process_env(env: Mapping[str, str]) -> dict[str, str]:
    """Detach a long-lived child from the current frozen application instance."""

    child_env = dict(env)
    if getattr(sys, "frozen", False):
        child_env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
    return child_env


def coordinator_run_command(
    home: str,
    runtime_dir: str,
    log_level: str,
    runtime_image: Mapping[str, Any] | None = None,
) -> list[str]:
    return [
        *entry_command(runtime_image),
        "--log_level",
        log_level,
        "runtime",
        "run",
        "--runtime-dir",
        runtime_dir,
        "--home",
        home,
    ]


def assessment_worker_command(runtime_dir: str, assessment_key: str) -> list[str]:
    return [
        *entry_command(),
        "runtime",
        "assess-worker",
        "--runtime-dir",
        runtime_paths.resolve_runtime_dir("", runtime_dir),
        "--assessment-key",
        assessment_key,
    ]


def run_assessment_worker(runtime_dir: str, assessment_key: str) -> dict[str, Any]:
    return storage_service.assessment_execute(
        runtime_dir,
        assessment_key,
        executor_profile="process",
    )


def supervisor_command(
    config_home: str | None,
    log_level: str,
    *,
    home: str | None = None,
    runtime_dir: str | None = None,
    foreground: bool = True,
    runtime_image: Mapping[str, Any] | None = None,
) -> list[str]:
    command = [
        *entry_command(runtime_image),
        "--log_level",
        log_level,
        "runtime",
        "supervise",
        "--config-home",
        runtime_paths.resolve_config_home(config_home),
    ]
    if home:
        command.extend(["--home", runtime_paths.resolve_runtime_home(home)])
    if runtime_dir:
        command.extend(
            [
                "--runtime-dir",
                runtime_paths.resolve_runtime_dir(home or "", runtime_dir),
            ]
        )
    if foreground:
        command.append("--foreground")
    return command


@dataclass(frozen=True)
class ServicePlan:
    platform: str
    path: Path
    content: str
    install_note: str
    uninstall_note: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema": SCHEMA_PLAN,
            "platform": self.platform,
            "path": str(self.path),
            "content": self.content,
            "installNote": self.install_note,
            "uninstallNote": self.uninstall_note,
        }


def service_plan(
    home: str,
    runtime_dir: str,
    log_level: str,
    config_home: str | None = None,
) -> ServicePlan:
    config_home = runtime_paths.resolve_config_home(config_home)
    home = runtime_paths.resolve_runtime_home(home)
    runtime_dir = runtime_paths.resolve_runtime_dir(home, runtime_dir)
    system = platform.system()
    command = supervisor_command(
        config_home,
        log_level,
        home=home,
        runtime_dir=runtime_dir,
        foreground=True,
    )
    env = command_env(home, runtime_dir, log_level, config_home)
    if system == "Darwin":
        path = Path.home() / "Library" / "LaunchAgents" / f"{SERVICE_ID}.plist"
        args = "\n".join(f"    <string>{xml_escape(arg)}</string>" for arg in command)
        content = f"""<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key>
  <string>{xml_escape(SERVICE_ID)}</string>
  <key>ProgramArguments</key>
  <array>
{args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>KF_HOME</key>
    <string>{xml_escape(home)}</string>
    <key>KF_CONFIG_HOME</key>
    <string>{xml_escape(config_home)}</string>
    <key>KF_RUNTIME_DIR</key>
    <string>{xml_escape(runtime_dir)}</string>
    <key>KF_LOG_LEVEL</key>
    <string>{xml_escape(log_level)}</string>
    <key>{SUPERVISOR_ALWAYS_ON_ENV}</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{xml_escape(str(supervisor_log_path(config_home)))}</string>
  <key>StandardErrorPath</key>
  <string>{xml_escape(str(supervisor_log_path(config_home)))}</string>
</dict>
</plist>
"""
        return ServicePlan(
            system,
            path,
            content,
            f"write {path}; then run: launchctl bootstrap gui/$(id -u) {shlex_quote(str(path))}",
            f"run: launchctl bootout gui/$(id -u) {shlex_quote(str(path))}; then remove {path}",
        )
    if system == "Linux":
        path = (
            Path.home() / ".config" / "systemd" / "user" / "kungfu-supervisor.service"
        )
        content = f"""[Unit]
Description={SERVICE_NAME}
After=default.target

[Service]
Type=simple
{_systemd_env_line("KF_HOME", home)}
{_systemd_env_line("KF_CONFIG_HOME", config_home)}
{_systemd_env_line("KF_RUNTIME_DIR", runtime_dir)}
{_systemd_env_line("KF_LOG_LEVEL", log_level)}
{_systemd_env_line(SUPERVISOR_ALWAYS_ON_ENV, "1")}
ExecStart={_shell_join(command)}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
"""
        return ServicePlan(
            system,
            path,
            content,
            "write the unit; then run: systemctl --user daemon-reload && systemctl --user enable --now kungfu-supervisor.service",
            "run: systemctl --user disable --now kungfu-supervisor.service; then remove the unit",
        )
    startup = (
        Path(os.environ.get("APPDATA", str(Path.home())))
        / "Microsoft"
        / "Windows"
        / "Start Menu"
        / "Programs"
        / "Startup"
        / "kungfu-supervisor.cmd"
    )
    lines = [
        "@echo off",
        f'set "KF_HOME={env["KF_HOME"]}"',
        f'set "KF_CONFIG_HOME={env["KF_CONFIG_HOME"]}"',
        f'set "KF_RUNTIME_DIR={env["KF_RUNTIME_DIR"]}"',
        f'set "KF_LOG_LEVEL={env["KF_LOG_LEVEL"]}"',
        f'set "{SUPERVISOR_ALWAYS_ON_ENV}=1"',
        _shell_join(command),
        "",
    ]
    return ServicePlan(
        system,
        startup,
        "\r\n".join(lines),
        f"write {startup}; it will start at the next user logon",
        f"remove {startup}",
    )


def install_service(plan: ServicePlan) -> dict[str, Any]:
    plan.path.parent.mkdir(parents=True, exist_ok=True)
    plan.path.write_text(plan.content, "utf-8")
    return {
        "schema": SCHEMA_RESULT,
        "action": "install",
        "changed": True,
        "plan": plan.as_dict(),
    }


def uninstall_service(plan: ServicePlan) -> dict[str, Any]:
    existed = plan.path.exists()
    if existed:
        plan.path.unlink()
    return {
        "schema": SCHEMA_RESULT,
        "action": "uninstall",
        "changed": existed,
        "plan": plan.as_dict(),
    }


def service_status(
    *,
    config_home: str,
    home: str,
    runtime_dir: str,
    plan: ServicePlan,
    supervisor: dict[str, Any],
) -> dict[str, Any]:
    installed = plan.path.exists()
    actual = ""
    if installed:
        try:
            actual = plan.path.read_text("utf-8")
        except OSError:
            actual = ""
    return {
        "schema": "kungfu.runtime.status/v2",
        "configHome": config_home,
        "home": home,
        "runtimeDir": runtime_dir,
        "service": {
            "id": SERVICE_ID,
            "platform": plan.platform,
            "path": str(plan.path),
            "installed": installed,
            "matchesPlan": installed and actual == plan.content,
        },
        "supervisor": supervisor,
    }
