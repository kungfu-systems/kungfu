#  SPDX-License-Identifier: Apache-2.0

import kungfu
import re

from datetime import datetime, timedelta

lf = kungfu.__binding__.longfist
yjj = kungfu.__binding__.runtime

DATETIME_FORMAT = "%Y-%m-%d %H:%M:%S.%N"
NANO_PER_SECOND = 1000000000
SECOND_PER_MINUTE = 60
NANO_PER_MINUTE = NANO_PER_SECOND * SECOND_PER_MINUTE

EPOCH = datetime.fromtimestamp(0)

SESSION_DATETIME_FORMAT = "%Y-%m-%d %H:%M:%S"
DURATION_FORMAT = "%H:%M:%S.%N"
DURATION_TZ_ADJUST = int(
    timedelta(hours=datetime.fromtimestamp(0).hour).total_seconds() * 1e9
)

DAY_IN_NANO = int(24 * 60 * 60 * 1e9)


def to_datetime(nanotime):
    return EPOCH + timedelta(microseconds=nanotime / 1000)


def from_datetime(dt):
    return int(dt.timestamp() * NANO_PER_SECOND)


def strftime(nanotime, format=DATETIME_FORMAT):
    normal_format = format.replace("%N", "{:09d}".format(nanotime % NANO_PER_SECOND))
    return to_datetime(nanotime).strftime(normal_format)


def strptimes(
    timestr, formats=("%F %T", "%F %T.%N", "%Y%m%d", "%Y-%m-%d", "%Y-%m-%d %H:%M:%S")
):
    if isinstance(formats, str):
        formats = [formats]
    for format in formats:
        try:
            time_stamp = strptime(timestr, format)
            if strftime(time_stamp, format) == timestr:
                return time_stamp
        except ValueError:
            pass
    raise ValueError(
        "time data '{}' does not match any formats={}".format(timestr, formats)
    )


def strptime(timestr, format=DATETIME_FORMAT):
    nano_match = re.findall(r"\d{9}", timestr)
    normal_format = format.replace("%N", "")
    normal_timestr = timestr.replace(nano_match[0], "") if nano_match else timestr
    nano = int(nano_match[0]) if nano_match else 0
    dt = datetime.strptime(normal_timestr, normal_format)
    second_part = int(
        (dt - EPOCH).total_seconds() * NANO_PER_SECOND
    )  # round here to avoid precision diff
    return second_part + nano


def strfnow(format=DATETIME_FORMAT):
    return strftime(yjj.now_in_nano(), format)


def today_start():
    return yjj.today_start()
