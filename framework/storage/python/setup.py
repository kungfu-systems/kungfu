# SPDX-License-Identifier: Apache-2.0

from setuptools import find_packages, setup
from setuptools.dist import Distribution


class BinaryDistribution(Distribution):
    def has_ext_modules(self):
        return True


setup(
    packages=find_packages(),
    package_data={
        "kungfu_sdk": [
            "*.dll",
            "*.dylib",
            "*.so",
            "*.so.*",
            "kungfu-storage.contract.json",
        ]
    },
    include_package_data=True,
    distclass=BinaryDistribution,
)
