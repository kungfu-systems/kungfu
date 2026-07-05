#  SPDX-License-Identifier: Apache-2.0

from . import node
from . import python

runners = {
    "node": node.main,
    "python": python.main,
}
