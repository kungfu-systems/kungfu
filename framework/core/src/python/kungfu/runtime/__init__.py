#  SPDX-License-Identifier: Apache-2.0

import kungfu

lf = kungfu.__binding__.yijinjing
yjj = kungfu.__binding__.runtime

MODES = {
    "live": lf.enums.mode.LIVE,
    "data": lf.enums.mode.DATA,
    "replay": lf.enums.mode.REPLAY,
    "backtest": lf.enums.mode.BACKTEST,
    "*": lf.enums.mode.LIVE,
}

ROLES = {
    "source": lf.enums.location_role.SOURCE,
    "sink": lf.enums.location_role.SINK,
    "actor": lf.enums.location_role.ACTOR,
    "system": lf.enums.location_role.SYSTEM,
    "service": lf.enums.location_role.SERVICE,
    "*": lf.enums.location_role.SYSTEM,
}
