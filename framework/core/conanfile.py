# SPDX-License-Identifier: Apache-2.0
#
# kungfu-core conan2 编排器（v4+）。
# 由 conan-1.x 全量端口而来，逻辑成因见 docs/conan2-migration.md（理解可能片面，以代码为准）。
# 不向下兼容 v3：只保证 v4+ 在 Mac arm64 / Linux x64 / Windows 可用。

import json
import getpass
import os
import pathlib
import platform
import datetime
import time
import shutil
import stat
import subprocess
import sys
import re
from glob import glob
from contextlib import contextmanager
from os import environ, path

from conan import ConanFile
from conan.errors import ConanInvalidConfiguration
from conan.tools.build import build_jobs
from conan.tools.cmake import CMakeToolchain, CMakeDeps
from conan.tools.files import copy

_CONANFILE_DIR = path.dirname(path.realpath(__file__))


def _candidate_timeline_attempt():
    event_name = os.environ.get("GITHUB_EVENT_NAME", "local")
    run_id = os.environ.get("GITHUB_RUN_ID", "local")
    result = {
        "id": os.environ.get("KUNGFU_CANDIDATE_ATTEMPT_ID", f"{event_name}-{run_id}"),
        "kind": (
            "merge-queue"
            if event_name == "merge_group"
            else "pull-request"
            if event_name == "pull_request"
            else "local"
        ),
    }
    if event_name == "merge_group" and os.environ.get("GITHUB_SHA"):
        result["mergeGroupSha"] = os.environ["GITHUB_SHA"]
    if os.environ.get("GITHUB_RUN_ID"):
        result["workflowRunId"] = os.environ["GITHUB_RUN_ID"]
    return result


@contextmanager
def _candidate_timeline_stage(stage, phase, runtime):
    output = os.environ.get("KUNGFU_CANDIDATE_TIMELINE_EVENTS", "")
    started_at = (
        datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    )
    started = time.perf_counter_ns()
    status = "success"
    try:
        yield
    except BaseException:
        status = "failure"
        raise
    finally:
        if output:
            completed_at = (
                datetime.datetime.now(datetime.timezone.utc)
                .isoformat()
                .replace("+00:00", "Z")
            )
            attempt = _candidate_timeline_attempt()
            partition = os.environ.get("KUNGFU_AFFECTED_NATIVE_PARTITION_INDEX", "none")
            event_id = (
                f"{attempt['id']}:{platform.system().lower()}:{partition}:{stage}"
            )
            event = {
                "id": event_id,
                "attempt": attempt,
                "phase": phase,
                "category": "stage",
                "status": status,
                "gate": {
                    "id": os.environ.get(
                        "KUNGFU_CANDIDATE_GATE_ID", "source.changed-scope"
                    ),
                    "platform": f"{platform.system().lower()}-{platform.machine().lower()}",
                    "partition": partition,
                },
                "span": {"id": event_id},
                "execution": {"boundary": "conan-cmake"},
                "timing": {
                    "startedAt": started_at,
                    "completedAt": completed_at,
                    "durationMs": round(
                        (time.perf_counter_ns() - started) / 1_000_000, 3
                    ),
                    "clock": "monotonic-duration+wall-envelope",
                    "precisionMs": 1,
                    "authority": "kungfu-conan-cmake-stage",
                },
                "criticalPathEligible": True,
                "attributes": {
                    "sourceSha": os.environ.get("GITHUB_SHA", ""),
                    "runtime": runtime,
                    "stage": stage,
                },
            }
            output_dir = path.dirname(path.abspath(output))
            os.makedirs(output_dir, exist_ok=True)
            with open(output, "a", encoding="utf-8") as timeline_file:
                timeline_file.write(json.dumps(event, separators=(",", ":")) + "\n")


with open(
    path.join(_CONANFILE_DIR, "architecture", "build-capabilities.json"),
    "r",
    encoding="utf-8",
) as build_capabilities_file:
    BUILD_CAPABILITIES = json.load(build_capabilities_file)

BUILD_PROFILES = {profile["id"]: profile for profile in BUILD_CAPABILITIES["profiles"]}
BUILD_DEPENDENCIES = {
    dependency["id"]: dependency for dependency in BUILD_CAPABILITIES["dependencies"]
}


def _profile_dependency_roots(profile):
    roots = set()
    for group in ("components", "providers", "projections", "bindings"):
        entries = {entry["id"]: entry for entry in BUILD_CAPABILITIES[group]}
        for entry_id in profile[group]:
            roots.update(entries[entry_id].get("dependencies", []))
    return sorted(roots)


with open(path.join(_CONANFILE_DIR, "package.json"), "r") as package_json_file:
    package_json = json.load(package_json_file)


_RXCPP_INVALID_ASSIGNMENT = (
    "on_error_notification& operator=(on_error_notification o) "
    "{ ep = std::move(o.ep); return *this; }"
)
_RXCPP_DELETED_ASSIGNMENT = (
    "on_error_notification& operator=(on_error_notification) = delete;"
)


def _prepare_rxcpp_compat(source_include_dir, destination_include_dir):
    """Copy RxCpp and remove its invalid assignment to a const error_ptr.

    RxCpp 4.1.1 and upstream main still declare ``ep`` const while assigning to
    it in a non-template-dependent operator body. GCC rejects the header during
    a clean build. Keep Conan's package immutable and patch a generated include
    overlay instead; fail closed if the pinned upstream source changes.
    """
    source_rxcpp_dir = path.join(source_include_dir, "rxcpp")
    destination_rxcpp_dir = path.join(destination_include_dir, "rxcpp")
    if path.exists(destination_rxcpp_dir):
        shutil.rmtree(destination_rxcpp_dir)
    shutil.copytree(source_rxcpp_dir, destination_rxcpp_dir)

    notification_header = path.join(destination_rxcpp_dir, "rx-notification.hpp")
    with open(notification_header, "r", encoding="utf-8") as source_file:
        source = source_file.read()
    if source.count(_RXCPP_INVALID_ASSIGNMENT) != 1:
        raise RuntimeError(
            "RxCpp compatibility patch no longer matches exactly once: "
            f"{notification_header}"
        )
    with open(notification_header, "w", encoding="utf-8") as destination_file:
        destination_file.write(
            source.replace(_RXCPP_INVALID_ASSIGNMENT, _RXCPP_DELETED_ASSIGNMENT)
        )
    return destination_include_dir


def _cmake_path(value):
    """Return a CMake-safe path even when Conan runs on Windows."""
    return str(value).replace("\\", "/")


def _detected_os():
    """conan1 tools.detected_os() 的替代：返回 Windows/Macos/Linux。"""
    return {"Windows": "Windows", "Darwin": "Macos", "Linux": "Linux"}.get(
        platform.system(), platform.system()
    )


class KungfuCoreConan(ConanFile):
    name = "kungfu-core"
    version = package_json["version"]
    settings = "os", "compiler", "build_type", "arch"
    options = {
        "build_profile": list(BUILD_PROFILES),
        "log_level": ["trace", "debug", "info", "warning", "error", "critical"],
        "node_version": ["ANY"],
        "electron_version": ["ANY"],
        "vs_toolset": ["auto", "ClangCL"],
        "with_yarn": [True, False],
    }
    default_options = {
        "build_profile": BUILD_CAPABILITIES["default_profile"],
        "fmt/*:header_only": True,
        "spdlog/*:header_only": True,
        "spdlog/*:shared": False,
        "sqlite3/*:enable_column_metadata": True,
        "sqlite3/*:enable_json1": True,
        "sqlite3/*:enable_preupdate_hook": True,
        "sqlite3/*:enable_dbstat_vtab": True,
        "sqlite3/*:shared": False,
        "nng/*:http": False,
        "rocksdb/*:lite": False,
        "rocksdb/*:shared": False,
        "rocksdb/*:use_rtti": False,
        "rocksdb/*:with_lz4": False,
        "rocksdb/*:with_tbb": False,
        "rocksdb/*:with_zlib": False,
        "rocksdb/*:with_zstd": False,
        "rocksdb/*:enable_sse": False,
        "rocksdb/*:with_gflags": False,
        "rocksdb/*:with_snappy": False,
        "rocksdb/*:with_jemalloc": False,
        "gtest/*:shared": False,
        "gtest/*:build_gmock": True,
        "gtest/*:hide_symbols": False,
        "gtest/*:disable_pthreads": False,
        # 自身 options
        "log_level": "info",
        "node_version": "ANY",
        "electron_version": "ANY",
        # clang 已知问题:
        # https://developercommunity.visualstudio.com/t/msbuild-doesnt-give-delayload-flags-to-linker-when/1595015
        "vs_toolset": (
            "auto" if "CONAN_VS_TOOLSET" not in environ else environ["CONAN_VS_TOOLSET"]
        ),
        "with_yarn": False,
    }

    gyp_call = "NODE_GYP_RUN" in os.environ
    exports = "package.json"
    exports_sources = (
        "src/*",
        "package.json",
        "CMakeLists.txt",
        ".cmake/*",
        ".deps/*",
        "architecture/*",
        "dist/*",
    )
    conanfile_dir = _CONANFILE_DIR
    build_info_file = "kungfubuildinfo.json"
    build_dir = path.join(conanfile_dir, "build")
    dist_dir = path.join(conanfile_dir, "dist")
    kungfu_dir = path.join(dist_dir, "kungfu")

    def config_options(self):
        if _detected_os() != "Windows":
            self.options.rm_safe("vs_toolset")

    def requirements(self):
        profile = BUILD_PROFILES[str(self.options.build_profile)]
        dependency_roots = set(_profile_dependency_roots(profile))
        for dependency_id in sorted(dependency_roots):
            dependency = BUILD_DEPENDENCIES[dependency_id]
            if dependency["kind"] == "conan":
                self.requires(dependency["reference"])

    def validate(self):
        profile = BUILD_PROFILES[str(self.options.build_profile)]
        if profile["status"] != "supported":
            supported = ", ".join(
                item["id"]
                for item in BUILD_CAPABILITIES["profiles"]
                if item["status"] == "supported"
            )
            raise ConanInvalidConfiguration(
                f"build profile {profile['id']} is planned but not yet qualified; "
                f"supported profiles: {supported}"
            )

    def configure(self):
        # The Conan package-id and CMake language mode must describe the same
        # contract.  Previously Conan selected gnu17 and CMake silently changed
        # it to C++23, allowing incompatible dependency binaries to share a key.
        self.settings.compiler.cppstd = "23"
        if _detected_os() != "Windows":
            # 与历史一致：非 Windows 用 libstdc++（注：旧码写 libstdc++，conan2 profile 通常
            # 用 libstdc++11；此处沿用 profile 设定，不在 recipe 强行覆盖以免与 LAN 缓存包不一致）。
            pass

    def generate(self):
        profile = BUILD_PROFILES[str(self.options.build_profile)]
        dependency_roots = set(_profile_dependency_roots(profile))
        rxcpp_compat_include_dir = None
        if "rxcpp" in dependency_roots:
            rxcpp_package_folder = self.dependencies["rxcpp"].package_folder
            if rxcpp_package_folder is None:
                raise RuntimeError("RxCpp dependency has no Conan package folder")
            rxcpp_compat_include_dir = _prepare_rxcpp_compat(
                path.join(rxcpp_package_folder, "include"),
                path.join(self.build_folder, "compat", "rxcpp-4.1.1"),
            )
        deps = CMakeDeps(self)
        deps.generate()
        tc = CMakeToolchain(self, generator="Ninja")
        # Pass the selected profile and log level into the generated CMake toolchain.
        tc.variables["SPDLOG_LOG_LEVEL_COMPILE"] = self.__spdlog_level()
        tc.variables["KUNGFU_BUILD_PROFILE"] = str(self.options.build_profile)
        if rxcpp_compat_include_dir is not None:
            tc.variables["KUNGFU_RXCPP_COMPAT_INCLUDE_DIR"] = _cmake_path(
                rxcpp_compat_include_dir
            )
        tc.variables["CMAKE_CXX_STANDARD"] = 23
        tc.variables["CMAKE_CXX_STANDARD_REQUIRED"] = True
        tc.variables["CMAKE_CXX_EXTENSIONS"] = False
        tc.generate()
        if self.gyp_call:
            self.__touch_lockfile()

    def build(self):
        build_type = self.__get_build_type()
        self.__clean_build_info(build_type)
        self.__run_build(build_type, "node")
        self.__run_build(build_type, "electron")
        self.__gen_build_info(build_type)
        self.__show_build_info(build_type)

    def package(self):
        build_type = self.__get_build_type()
        if self.gyp_call:
            self.__clean_dist_dir()
            self.__show_build_info(build_type)
        else:
            src = self.conanfile_dir
            # 头文件按 target 归属分布在各库目录下，打包时合并成单一 include 树
            for lib in ("libyijinjing", "libkungfu", "libwasm"):
                copy(
                    self,
                    "*",
                    path.join(src, "src", lib, "include"),
                    path.join(self.package_folder, "include"),
                )
            copy(
                self,
                "*",
                path.join(src, build_type),
                path.join(self.package_folder, "lib"),
            )
            copy(
                self,
                "*",
                path.join(src, "src", "libkungfu", build_type),
                path.join(self.package_folder, "bin"),
            )
            # kfx 插件开发者交付物：导出仍 vendored 的依赖头（hana / sqlite_orm）与 cmake 模块。
            # pybind11 已由 conan 提供（requires pybind11/2.13.6），不再 vendored、不再导出。
            copy(
                self,
                "*",
                glob(path.join(src, ".deps", "hana-*"))[0],
                path.join(self.package_folder, "deps", "hana"),
            )
            copy(
                self,
                "*",
                glob(path.join(src, ".deps", "sqlite_orm-*"))[0],
                path.join(self.package_folder, "deps", "sqlite_orm"),
            )
            copy(
                self,
                "*",
                path.join(src, ".cmake"),
                path.join(self.package_folder, "cmake"),
            )
            copy(
                self,
                "*",
                path.join(src, "dist", "kungfu"),
                path.join(self.package_folder, "kungfu"),
            )

    def package_info(self):
        self.cpp_info.set_property("cmake_file_name", "kungfu")
        self.cpp_info.set_property("cmake_target_name", "kungfu::kungfu")
        self.cpp_info.libs = (
            ["kungfu"] if _detected_os() == "Windows" else ["kungfu", "kungfu_runtime"]
        )

    # ------------------------------------------------------------------ helpers

    def __spdlog_level(self):
        spdlog_levels = {
            "trace": "SPDLOG_LEVEL_TRACE",
            "debug": "SPDLOG_LEVEL_DEBUG",
            "info": "SPDLOG_LEVEL_INFO",
            "warning": "SPDLOG_LEVEL_WARN",
            "error": "SPDLOG_LEVEL_ERROR",
            "critical": "SPDLOG_LEVEL_CRITICAL",
        }
        return spdlog_levels[str(self.options.log_level)]

    def __get_build_type(self):
        build_type = str(self.settings.build_type)
        os.environ["CMAKE_BUILD_TYPE"] = build_type
        return build_type

    def __get_toolset(self):
        return str(self.options.vs_toolset) if _detected_os() == "Windows" else "auto"

    def __get_node_version(self, runtime):
        return (
            str(self.options.electron_version)
            if runtime == "electron"
            else str(self.options.node_version)
        )

    def __get_build_info_path(self, build_type):
        return path.join(self.build_dir, build_type, self.build_info_file)

    def __touch_lockfile(self):
        conan_lock = path.join(self.build_dir, "conan.lock")
        pathlib.Path(conan_lock).touch()

    def __clean_build_info(self, build_type):
        build_info_path = self.__get_build_info_path(build_type)
        if path.exists(build_info_path):
            os.remove(build_info_path)
            self.output.info("Deleted kungfubuildinfo.json")

    def __clean_dist_dir(self):
        if path.exists(self.dist_dir):

            def redo_with_write(redo_func, p, err):
                os.chmod(p, stat.S_IWRITE)
                redo_func(p)

            shutil.rmtree(self.dist_dir, onerror=redo_with_write)
            self.output.info("Deleted dist directory")

    def __gen_build_info(self, build_type):
        now = datetime.datetime.now()
        build_info = {
            "version": self.version,
            "pythonVersion": platform.python_version(),
            "build": {
                "user": getpass.getuser(),
                "osVersion": platform.platform(),
                "timestamp": now.strftime("%Y/%m/%d %H:%M:%S"),
            },
        }
        try:

            def _git(*args):
                return subprocess.check_output(["git", *args], text=True).strip()

            build_info["git"] = {
                "tag": _git("describe", "--tags", "--always"),
                "branch": _git("rev-parse", "--abbrev-ref", "HEAD"),
                "revision": _git("rev-parse", "HEAD"),
                "pristine": _git("status", "--porcelain") == "",
            }
        except Exception:
            pass

        os.makedirs(path.join(self.build_dir, build_type), exist_ok=True)
        with open(self.__get_build_info_path(build_type), "w") as output:
            json.dump(build_info, output, indent=2)

    def __show_build_info(self, build_type):
        with open(self.__get_build_info_path(build_type), "r") as build_info_file:
            build_info = json.load(build_info_file)
            self.output.success(f"build version {build_info['version']}")

    def __enable_modules(self, runtime):
        modules = {
            "libkungfu": True,
            "kungfu_node": (_detected_os() != "Windows") or (runtime == "electron"),
            "pykungfu": runtime == "node",
        }

        def switch(module):
            environ_key = f"KUNGFU_BUILD_SKIP_{module.upper()}"
            if not modules[module]:
                environ[environ_key] = "on"
            else:
                environ.pop(environ_key, None)

        [switch(key) for key in modules.keys()]

    def __run_build(self, build_type, runtime):
        if f"KUNGFU_BUILD_SKIP_RUNTIME_{runtime.upper()}" in environ:
            self.output.warning(f"disabled build for runtime {runtime}")
            return
        toolset = self.__get_toolset()
        parallel_opt = (
            []
            if _detected_os() == "Windows"
            else ["--", "-j", f"{self.__parallel_jobs()}"]
        )
        self.__enable_modules(runtime)
        if str(self.options.with_yarn) == "True":
            with _candidate_timeline_stage(
                f"sdk-core-{runtime}-configure", "core-configure", runtime
            ):
                self.__run_cmake_js(build_type, "configure", runtime, toolset)
            with _candidate_timeline_stage(
                f"sdk-core-{runtime}-build", "core-build", runtime
            ):
                self.__run_cmake_js(build_type, "build", runtime, toolset)
        elif runtime == "node":
            environ["KUNGFU_BUILD_SKIP_KUNGFU_NODE"] = "on"
            environ["KUNGFU_BUILD_SKIP_PYKUNGFU"] = "on"
            cargo_registry = os.environ.get("KF_LIBWASM_CARGO_REGISTRY", "")
            cargo_registry_option = (
                [f"-DKF_LIBWASM_CARGO_REGISTRY={cargo_registry}"]
                if cargo_registry
                else []
            )
            with _candidate_timeline_stage(
                "sdk-core-node-configure", "core-configure", runtime
            ):
                self.__run_cmake(
                    "-S",
                    ".." if self.gyp_call else ".",
                    "-B",
                    "../build" if self.gyp_call else ".",
                    "-DCMAKE_BUILD_TYPE=Release",
                    f"-DSPDLOG_LOG_LEVEL_COMPILE={self.__spdlog_level()}",
                    *cargo_registry_option,
                )
            with _candidate_timeline_stage(
                "sdk-core-node-build", "core-build", runtime
            ):
                self.__run_cmake("--build", ".", "--config", "Release", *parallel_opt)

    def __run_cmake(self, *args):
        rc = subprocess.Popen([shutil.which("cmake"), *args]).wait()
        if rc != 0:
            self.output.error(f"cmake {args} failed with return code {rc}")
            sys.exit(rc)

    def __run_cmake_js(self, build_type, cmd, runtime, toolset):
        [
            os.environ.pop(env_key)
            for env_key in list(os.environ)
            if env_key.upper().startswith("NPM_")
        ]  # workaround for msvc
        self.__run_node_bin(
            *self.__build_cmake_js_cmd(build_type, cmd, runtime, toolset)
        )
        self.output.success(f"cmake-js {cmd} done")

    def __run_node_bin(self, *args):
        # pnpm exec 保持调用方 cwd（conan build() 的 cwd 是 build 文件夹），而 yarn 旧行为是从最近
        # 的 package.json 目录运行。显式把 cwd 钉到 recipe/包根目录，让 cmake-js 找到 CMakeLists.txt。
        pnpm = "pnpm" if _detected_os() != "Windows" else "pnpm.cmd"
        rc = subprocess.Popen(
            [shutil.which(pnpm), "exec", *args], cwd=self.conanfile_dir
        ).wait()
        if rc != 0:
            self.output.error(f"pnpm exec {args} failed with return code {rc}")
            sys.exit(rc)

    def __parallel_jobs(self):
        # 并行编译度优先取环境变量 KUNGFU_BUILD_JOBS（由 shifu 的 build-local.env 在各机
        # 统一配置,仓内不硬编码);其次 conan conf tools.build:jobs;最后回退 os.cpu_count()。
        # kungfu 开 -flto + 重模板,单路峰值约 2GB,大核机（如 agent-120 32 线程）默认满并行会
        # 撑爆内存换页 thrash,故需可按机封顶。
        env_jobs = os.environ.get("KUNGFU_BUILD_JOBS", "")
        if env_jobs.isdigit() and int(env_jobs) > 0:
            return int(env_jobs)
        return build_jobs(self)

    def __build_cmake_js_cmd(self, build_type, cmd, runtime, toolset):
        log_level = self.__spdlog_level()
        parallel_level = self.__parallel_jobs()
        # uv 接管 env（S1 阶段 A）：取 uv 项目 venv 的 python，替代 `pipenv --py`。
        python_path = re.sub(
            r"(?:\x1B[@-_]|[\x80-\x9F])[0-?]*[ -/]*[@-~]",
            "",
            subprocess.Popen(
                [
                    "uv",
                    "run",
                    "--frozen",
                    "python",
                    "-c",
                    "import sys; print(sys.executable)",
                ],
                stdout=subprocess.PIPE,
                text=True,
            )
            .stdout.read()
            .strip(),
        )
        node_arch = self.__node_arch()
        # Windows 改用 Ninja 生成器(取代 VS/MSBuild):VS 生成器忽略 CMAKE_CXX_COMPILER_LAUNCHER,
        # sccache 无法缓存 MSVC(Phase1 DARKHERO 实证:VS gen 0 compile requests / Ninja round2 命中)。
        # Ninja 下 cl 需 MSVC env(vcvars)激活——构建须在 Developer 环境跑(CI runner / 本地 vcvars)。
        # toolset 仅 VS 生成器用,Ninja 下不传。
        if _detected_os() == "Windows":
            # Ninja 下 cmake 走 PATH 自动探测 rc,而 yarn/cmake-js 把 node_modules/.bin 前置到 PATH,
            # 其中 npm 的 rc 配置包(node_modules/.bin/rc[.cmd])会遮蔽真正的 SDK rc.exe,使 cmake 误用它
            # 当资源编译器、链接 manifest 时崩(DARKHERO 实证)。故显式钉到 vcvars 提供的 SDK rc.exe。
            # (VS 生成器经 MSBuild 走 VS 工具链不踩此坑;此项仅 Windows+Ninja 需要。)
            rc_compiler = shutil.which("rc.exe")
            rc_option = (
                [f"--CDCMAKE_RC_COMPILER={rc_compiler.replace(chr(92), '/')}"]
                if rc_compiler
                else []
            )
            build_option = [
                "--generator",
                "Ninja",
                "--parallel",
                str(parallel_level),
            ] + rc_option
        else:
            build_option = ["--parallel", str(parallel_level)]
        debug_option = ["--debug"] if build_type == "Debug" else []
        # conan2：把生成的 conan_toolchain.cmake 透传给 cmake-js，让 conan 依赖(CMakeDeps)与
        # cmake-js 的 runtime headers 共存(取代 conan1 的 conanbuildinfo.cmake 自动注入)。
        toolchain = path.join(self.generators_folder, "conan_toolchain.cmake")
        cargo_registry = os.environ.get("KF_LIBWASM_CARGO_REGISTRY", "")
        cargo_registry_option = (
            [f"--CDKF_LIBWASM_CARGO_REGISTRY={cargo_registry}"]
            if cargo_registry
            else []
        )
        return (
            [
                "cmake-js",
                "--arch",
                node_arch,
                "--runtime",
                runtime,
                "--runtime-version",
                self.__get_node_version(runtime),
                f"--CDCMAKE_TOOLCHAIN_FILE={toolchain}",
                f"--CDCMAKE_BUILD_TYPE={build_type}",
                f"--CDPYTHON_EXECUTABLE={python_path}",
                f"--CDSPDLOG_LOG_LEVEL_COMPILE={log_level}",
                f"--CDCMAKE_BUILD_PARALLEL_LEVEL={parallel_level}",
            ]
            + cargo_registry_option
            + build_option
            + debug_option
            + [cmd]
        )

    @staticmethod
    def __node_arch():
        # conan settings.arch(armv8 / x86_64) → node/cmake-js arch(arm64 / x64)。
        import platform as _pf

        machine = _pf.machine().lower()
        if machine in ("arm64", "aarch64", "armv8"):
            return "arm64"
        return "x64"
