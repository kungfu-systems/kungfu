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
import shutil
import stat
import subprocess
import sys
import re
from glob import glob
from os import environ, path

from conan import ConanFile
from conan.tools.build import build_jobs
from conan.tools.cmake import CMakeToolchain, CMakeDeps
from conan.tools.files import copy

with open(path.join("package.json"), "r") as package_json_file:
    package_json = json.load(package_json_file)


def _detected_os():
    """conan1 tools.detected_os() 的替代：返回 Windows/Macos/Linux。"""
    return {"Windows": "Windows", "Darwin": "Macos", "Linux": "Linux"}.get(
        platform.system(), platform.system()
    )


class KungfuCoreConan(ConanFile):
    name = "kungfu-core"
    version = package_json["version"]
    settings = "os", "compiler", "build_type", "arch"
    # conan2：依赖经 requirements()/requires 声明，generate() 产 CMakeDeps+CMakeToolchain。
    requires = [
        "fmt/10.2.1",
        "nlohmann_json/3.11.2",
        "nng/1.11.0",
        "flatbuffers/25.9.23",
        "rxcpp/4.1.1",
        "sqlite3/3.39.2",
        "spdlog/1.14.1",
        "tabulate/1.4",
        "rocksdb/6.29.5",
        "pybind11/2.13.6",
        "gtest/1.14.0",
    ]
    options = {
        "log_level": ["trace", "debug", "info", "warning", "error", "critical"],
        "freezer": ["nuitka", "pyinstaller"],
        "node_version": ["ANY"],
        "electron_version": ["ANY"],
        "vs_toolset": ["auto", "ClangCL"],
        "with_yarn": [True, False],
    }
    default_options = {
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
        "freezer": "pyinstaller",
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
        "dist/*",
    )
    conanfile_dir = path.dirname(path.realpath(__file__))
    pyi_hooks_dir = path.join(conanfile_dir, "src", "python", "pyi-hooks")
    build_info_file = "kungfubuildinfo.json"
    build_dir = path.join(conanfile_dir, "build")
    dist_dir = path.join(conanfile_dir, "dist")
    kungfu_dir = path.join(dist_dir, "kungfu")
    kfs_dir = path.join(dist_dir, "kfs")

    def config_options(self):
        if _detected_os() != "Windows":
            self.options.rm_safe("vs_toolset")

    def configure(self):
        if _detected_os() != "Windows":
            # 与历史一致：非 Windows 用 libstdc++（注：旧码写 libstdc++，conan2 profile 通常
            # 用 libstdc++11；此处沿用 profile 设定，不在 recipe 强行覆盖以免与 LAN 缓存包不一致）。
            pass

    def generate(self):
        deps = CMakeDeps(self)
        deps.generate()
        tc = CMakeToolchain(self, generator="Ninja")
        # 把自身 options 透传给 CMake（主 CMakeLists 用 ${CONAN_LIBS} 桥接 + SPDLOG 等级）。
        tc.variables["SPDLOG_LOG_LEVEL_COMPILE"] = self.__spdlog_level()
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
            self.__run_freeze(build_type)
            self.__show_build_info(build_type)
        else:
            src = self.conanfile_dir
            # 头文件按 target 归属分布在各库目录下，打包时合并成单一 include 树
            for lib in ("libyijinjing", "libkungfu"):
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
        self.cpp_info.libs = ["kungfu"]

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
            self.__run_cmake_js(build_type, "configure", runtime, toolset)
            self.__run_cmake_js(build_type, "build", runtime, toolset)
        elif runtime == "node":
            environ["KUNGFU_BUILD_SKIP_KUNGFU_NODE"] = "on"
            environ["KUNGFU_BUILD_SKIP_PYKUNGFU"] = "on"
            self.__run_cmake(
                "-S",
                ".." if self.gyp_call else ".",
                "-B",
                "../build" if self.gyp_call else ".",
                "-DCMAKE_BUILD_TYPE=Release",
                f"-DSPDLOG_LOG_LEVEL_COMPILE={self.__spdlog_level()}",
            )
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

    def __run_pnpm_script(self, *args):
        pnpm = "pnpm" if _detected_os() != "Windows" else "pnpm.cmd"
        rc = subprocess.Popen([shutil.which(pnpm), "run", *args]).wait()
        if rc != 0:
            self.output.error(f"pnpm run {args} failed with return code {rc}")
            sys.exit(rc)

    def __parallel_jobs(self):
        # 并行编译度优先取环境变量 KUNGFU_BUILD_JOBS（由 kungfu-code 的 build-local.env 在各机
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

    def __run_pyinstaller(self, build_type):
        pathlib.Path(self.__get_build_info_path(build_type)).touch()
        cwd = os.getcwd()
        try:
            os.chdir(path.pardir)
            from PyInstaller import __main__ as freezer

            freezer.run(
                [
                    f"--workpath={path.join('.', 'build')}",
                    f"--distpath={path.join('.', 'dist')}",
                    "--clean",
                    "--noconfirm",
                    path.join(".", "src", "python", "kungfu.spec"),
                ]
            )
        finally:
            os.chdir(cwd)

        from wcmatch import glob as wcglob

        for file in wcglob.glob("*kfs*", flags=wcglob.EXTGLOB, root_dir=self.kfs_dir):
            shutil.copy(path.join(self.kfs_dir, file), self.kungfu_dir)
        shutil.rmtree(self.kfs_dir)
        self.output.success("PyInstaller done")

    def __run_nuitka(self, build_type):
        cwd = os.getcwd()
        try:
            os.chdir(path.pardir)
            self.__run_pnpm_script(
                "nuitka",
                "--output-dir=build",
                path.join("src", "python", "kungfu_cli.py"),
            )
        finally:
            os.chdir(cwd)

        kungfu_dist_dir = path.join(self.build_dir, "kungfu_cli.dist")
        shutil.copytree(build_type, kungfu_dist_dir)
        shutil.rmtree(self.kungfu_dir, ignore_errors=True)
        shutil.move(kungfu_dist_dir, self.kungfu_dir)
        self.output.success("Nuitka done")

    def __run_freeze(self, build_type):
        os.environ["KUNGFU_PYI_HOOKS_PATH"] = self.pyi_hooks_dir
        freeze = {"pyinstaller": self.__run_pyinstaller, "nuitka": self.__run_nuitka}
        freeze[str(self.options.freezer)](build_type)
