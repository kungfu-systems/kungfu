# SPDX-License-Identifier: MIT

import os

from conan import ConanFile
from conan.tools.files import apply_conandata_patches, copy, get
from conan.tools.layout import basic_layout


required_conan_version = ">=2.1"


class RxcppConan(ConanFile):
    name = "rxcpp"
    description = "C++ library for composing operations on asynchronous event streams"
    license = "Apache-2.0"
    homepage = "https://github.com/ReactiveX/RxCpp"
    package_type = "header-library"
    settings = "os", "arch", "compiler", "build_type"
    exports_sources = "patches/*"
    no_copy_source = True

    def package_id(self):
        self.info.clear()

    def layout(self):
        basic_layout(self, src_folder="src")

    def source(self):
        get(
            self,
            **self.conan_data["sources"][self.version],
            destination=self.source_folder,
            strip_root=True,
        )

    def build(self):
        apply_conandata_patches(self)

    def package(self):
        copy(
            self,
            "license.md",
            src=self.source_folder,
            dst=os.path.join(self.package_folder, "licenses"),
        )
        copy(
            self,
            "*.hpp",
            src=os.path.join(self.source_folder, "Rx", "v2", "src"),
            dst=os.path.join(self.package_folder, "include"),
        )

    def package_info(self):
        self.cpp_info.bindirs = []
        self.cpp_info.frameworkdirs = []
        self.cpp_info.libdirs = []
        self.cpp_info.resdirs = []
