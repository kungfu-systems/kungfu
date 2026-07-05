#  SPDX-License-Identifier: Apache-2.0

from os import environ

ENV_VARIANT_KEY = "KUNGFU_AS_VARIANT"


def disable():
    environ.pop(ENV_VARIANT_KEY, None)


def enable(variant: str):
    environ[ENV_VARIANT_KEY] = variant


def main(**kwargs):
    from .__registry__ import runners

    variant = environ.get(ENV_VARIANT_KEY)
    runner = runners.get(variant, lambda **x: False)

    return runner(**kwargs) is not False
