# SPDX-License-Identifier: MIT

import glob
import os

from conan import ConanFile
from conan.errors import ConanInvalidConfiguration
from conan.tools.build import check_min_cppstd
from conan.tools.cmake import CMake, CMakeDeps, CMakeToolchain, cmake_layout
from conan.tools.files import (
    apply_conandata_patches,
    collect_libs,
    copy,
    rm,
    rmdir,
)
from conan.tools.microsoft import is_msvc, is_msvc_static_runtime
from conan.tools.scm import Git


required_conan_version = ">=2.0"


class RocksDBConan(ConanFile):
    name = "rocksdb"
    description = "Embeddable persistent key-value store"
    license = ("GPL-2.0-only", "Apache-2.0")
    homepage = "https://github.com/facebook/rocksdb"
    package_type = "library"
    settings = "os", "arch", "compiler", "build_type"
    options = {
        "shared": [True, False],
        "fPIC": [True, False],
        "lite": [True, False],
        "with_gflags": [True, False],
        "with_snappy": [True, False],
        "with_lz4": [True, False],
        "with_zlib": [True, False],
        "with_zstd": [True, False],
        "with_tbb": [True, False],
        "with_jemalloc": [True, False],
        "enable_sse": [False, "sse42", "avx2"],
        "use_rtti": [True, False],
    }
    default_options = {
        "shared": False,
        "fPIC": True,
        "lite": False,
        "with_gflags": False,
        "with_snappy": False,
        "with_lz4": False,
        "with_zlib": False,
        "with_zstd": False,
        "with_tbb": False,
        "with_jemalloc": False,
        "enable_sse": False,
        "use_rtti": False,
    }
    exports_sources = "patches/*"

    def config_options(self):
        if self.settings.os == "Windows":
            del self.options.fPIC
        if self.settings.arch != "x86_64":
            del self.options.with_tbb
        if self.settings.build_type == "Debug":
            self.options.use_rtti = True

    def configure(self):
        if self.options.shared:
            self.options.rm_safe("fPIC")

    def layout(self):
        cmake_layout(self, src_folder="src")

    def requirements(self):
        if self.options.with_gflags:
            self.requires("gflags/2.2.2")
        if self.options.with_snappy:
            self.requires("snappy/[>=1.1.10 <2]")
        if self.options.with_lz4:
            self.requires("lz4/[>=1.9.4 <2]")
        if self.options.with_zlib:
            self.requires("zlib/[>=1.2.11 <2]")
        if self.options.with_zstd:
            self.requires("zstd/[~1.5]")
        if self.options.get_safe("with_tbb"):
            self.requires("onetbb/2021.10.0")
        if self.options.with_jemalloc:
            self.requires("jemalloc/5.3.0")

    def validate(self):
        check_min_cppstd(self, "11")
        if self.settings.arch not in ["x86_64", "ppc64le", "ppc64", "mips64", "armv8"]:
            raise ConanInvalidConfiguration("RocksDB requires 64 bits")
        if is_msvc(self) and int(str(self.settings.compiler.version)) < 191:
            raise ConanInvalidConfiguration("RocksDB requires MSVC version >= 191")

    def source(self):
        source = self.conan_data["sources"][self.version]
        git = Git(self)
        git.clone(
            source["url"],
            target=".",
            args=["--depth", "1", "--branch", source["tag"]],
        )
        if git.get_commit() != source["commit"]:
            raise ConanInvalidConfiguration(
                f"RocksDB source commit does not match {source['commit']}"
            )

    def generate(self):
        tc = CMakeToolchain(self)
        tc.variables["FAIL_ON_WARNINGS"] = False
        tc.variables["WITH_TESTS"] = False
        tc.variables["WITH_TOOLS"] = False
        tc.variables["WITH_CORE_TOOLS"] = False
        tc.variables["WITH_BENCHMARK_TOOLS"] = False
        tc.variables["WITH_FOLLY_DISTRIBUTED_MUTEX"] = False
        if is_msvc(self):
            tc.variables["WITH_MD_LIBRARY"] = not is_msvc_static_runtime(self)
        tc.variables["ROCKSDB_INSTALL_ON_WINDOWS"] = self.settings.os == "Windows"
        tc.variables["ROCKSDB_LITE"] = self.options.lite
        tc.variables["WITH_GFLAGS"] = self.options.with_gflags
        tc.variables["WITH_SNAPPY"] = self.options.with_snappy
        tc.variables["WITH_LZ4"] = self.options.with_lz4
        tc.variables["WITH_ZLIB"] = self.options.with_zlib
        tc.variables["WITH_ZSTD"] = self.options.with_zstd
        tc.variables["WITH_TBB"] = self.options.get_safe("with_tbb", False)
        tc.variables["WITH_JEMALLOC"] = self.options.with_jemalloc
        tc.variables["ROCKSDB_BUILD_SHARED"] = self.options.shared
        tc.variables["ROCKSDB_LIBRARY_EXPORTS"] = (
            self.settings.os == "Windows" and self.options.shared
        )
        tc.variables["ROCKSDB_DLL"] = (
            self.settings.os == "Windows" and self.options.shared
        )
        tc.variables["USE_RTTI"] = self.options.use_rtti
        if not bool(self.options.enable_sse):
            tc.variables["PORTABLE"] = True
            tc.variables["FORCE_SSE42"] = False
        elif self.options.enable_sse == "sse42":
            tc.variables["PORTABLE"] = True
            tc.variables["FORCE_SSE42"] = True
        else:
            tc.variables["PORTABLE"] = False
            tc.variables["FORCE_SSE42"] = False
        tc.variables["WITH_NUMA"] = False
        tc.generate()
        CMakeDeps(self).generate()

    def build(self):
        apply_conandata_patches(self)
        cmake = CMake(self)
        cmake.configure()
        cmake.build()

    def package(self):
        copy(
            self,
            "COPYING",
            src=self.source_folder,
            dst=os.path.join(self.package_folder, "licenses"),
        )
        copy(
            self,
            "LICENSE*",
            src=self.source_folder,
            dst=os.path.join(self.package_folder, "licenses"),
        )
        cmake = CMake(self)
        cmake.install()
        if self.options.shared:
            rm(self, "rocksdb.lib", os.path.join(self.package_folder, "lib"))
            for library in glob.glob(os.path.join(self.package_folder, "lib", "*.a")):
                if not library.endswith(".dll.a"):
                    os.remove(library)
        rmdir(self, os.path.join(self.package_folder, "lib", "cmake"))
        rmdir(self, os.path.join(self.package_folder, "lib", "pkgconfig"))

    def package_info(self):
        target = "rocksdb-shared" if self.options.shared else "rocksdb"
        component = self.cpp_info.components["librocksdb"]
        self.cpp_info.set_property("cmake_file_name", "RocksDB")
        self.cpp_info.set_property("cmake_target_name", f"RocksDB::{target}")
        component.set_property("cmake_target_name", f"RocksDB::{target}")
        component.libs = collect_libs(self)
        if self.settings.os == "Windows":
            component.system_libs = ["shlwapi", "rpcrt4"]
            if self.options.shared:
                component.defines = ["ROCKSDB_DLL"]
        elif self.settings.os in ["Linux", "FreeBSD"]:
            component.system_libs = ["pthread", "m"]
        if self.options.lite:
            component.defines.append("ROCKSDB_LITE")
