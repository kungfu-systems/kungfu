#  SPDX-License-Identifier: Apache-2.0

import kungfu
import os
import re

lf = kungfu.__binding__.longfist
yjj = kungfu.__binding__.yijinjing

os_sep = re.escape(os.sep)

LAYOUT_LOCATION_REGEX = "{}{}{}{}{}{}{}{}{}{}{}".format(
    r"layout",
    os_sep,  # layout
    r"(.*)",
    os_sep,  # role
    r"(.*)",
    os_sep,  # group
    r"(.*)",
    os_sep,  # name
    r"(.*)",
    os_sep,  # mode
    r"(.*)",  # filename
)
LAYOUT_LOCATION_PATTERN = re.compile(LAYOUT_LOCATION_REGEX)

JOURNAL_LOCATION_REGEX = "{}{}{}{}{}{}{}{}{}".format(
    r"journal",
    os_sep,
    r"(.*)",
    os_sep,  # role
    r"(.*)",
    os_sep,  # group
    r"(.*)",
    os_sep,  # name
    r"(.*)",  # mode
)
JOURNAL_LOCATION_PATTERN = re.compile(JOURNAL_LOCATION_REGEX)

JOURNAL_PAGE_REGEX = "{}{}{}{}{}{}{}{}{}{}{}".format(
    r"journal",
    os_sep,  # mode
    r"(.*)",
    os_sep,  # role
    r"(.*)",
    os_sep,  # group
    r"(.*)",
    os_sep,  # name
    r"(.*)",
    os_sep,  # mode
    r"(\w+).(\d+).journal",  # hash + page_id
)
JOURNAL_PAGE_PATTERN = re.compile(JOURNAL_PAGE_REGEX)

LOG_REGEX = "{}{}{}{}{}{}{}{}{}{}{}".format(
    r"log",
    os_sep,
    r"(.*)",
    os_sep,  # role
    r"(.*)",
    os_sep,  # group
    r"(.*)",
    os_sep,  # name
    r"(.*)",
    os_sep,  # mode
    r"(\w+)_(\d+-\d+-\d+).log",  # log_name + date
)
LOG_PATTERN = re.compile(LOG_REGEX)

LOCATION_UNAME_REGEX = r"(.*)/(.*)/(.*)/(.*)"
LOCATION_PATTERN = re.compile(LOCATION_UNAME_REGEX)

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

ARCHIVE_PREFIX = "KFA"
