#  SPDX-License-Identifier: Apache-2.0

import kungfu
import sys


def main(**kwargs):
    kungfu.__binding__.libnode.run(*sys.argv, **kwargs)
