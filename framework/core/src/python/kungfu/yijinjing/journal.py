#  SPDX-License-Identifier: Apache-2.0

import glob
import os
from typing import Any

import kungfu

from kungfu.yijinjing import *

lf = kungfu.__binding__.longfist
yjj = kungfu.__binding__.yijinjing
types = lf.types


def collect_journal_locations(ctx):
    search_path = os.path.join(
        ctx.runtime_dir,
        "journal",
        ctx.category,
        ctx.group,
        ctx.name,
        ctx.mode,
        "*.journal",
    )
    ctx.logger.debug(f"searching journal files in {search_path}")
    locations: dict[Any, Any] = {}
    for journal in glob.glob(search_path):
        ctx.logger.debug(f"{journal}")
        match = JOURNAL_PAGE_PATTERN.match(journal[len(ctx.runtime_dir) + 1 :])
        if match:
            category = match.group(1)
            group = match.group(2)
            name = match.group(3)
            mode = match.group(4)
            dest = match.group(5)
            page_id = match.group(6)
            uname = "{}/{}/{}/{}".format(category, group, name, mode)
            uid = yjj.hash_str_32(uname)
            if uid in locations:
                if dest in locations[uid]["readers"]:
                    locations[uid]["readers"][dest].append(page_id)
                else:
                    locations[uid]["readers"][dest] = [page_id]
            else:
                locations[uid] = {
                    "category": category,
                    "group": group,
                    "name": name,
                    "mode": mode,
                    "uname": uname,
                    "uid": yjj.hash_str_32(uname),
                    "readers": {dest: [page_id]},
                }
            ctx.logger.debug(
                f"found journal {MODES[mode]} {CATEGORIES[category]} {group} {name}"
            )
        else:
            ctx.logger.warn(
                f"unable to match journal file {journal} to pattern {JOURNAL_PAGE_REGEX}"
            )
    return locations


def find_sessions(ctx):
    io_device = yjj.io_device(ctx.console_location)
    session_finder = yjj.session_finder(io_device)
    ctx.session_count = 1
    import pandas

    sessions_df = pandas.DataFrame(
        columns=[
            "id",
            "mode",
            "category",
            "group",
            "name",
            "begin_time",
            "update_time",
            "end_time",
            "closed",
            "duration",
        ]
    )
    for_app = "app_location" in dir(ctx)
    sessions = (
        session_finder.find_sessions_for(ctx.app_location)
        if for_app
        else session_finder.find_sessions()
    )
    for session in sessions:
        sessions_df.loc[len(sessions_df)] = [
            len(sessions_df) + 1,
            lf.enums.get_mode_name(session.mode),
            lf.enums.get_category_name(session.category),
            session.group,
            session.name,
            session.begin_time,
            session.update_time,
            session.end_time,
            session.end_time != 0,
            abs(session.update_time) - session.begin_time,
        ]
    return sessions_df


def find_session(ctx, session_id):
    all_sessions = find_sessions(ctx)
    return all_sessions[all_sessions["id"] == session_id].iloc[0]


def make_location_from_dict(ctx, location):
    return yjj.location(
        MODES[location["mode"]],
        CATEGORIES[location["category"]],
        location["group"],
        location["name"],
        ctx.runtime_locator,
    )


def read_session(ctx, session_id, io_type):
    session = find_session(ctx, session_id)
    uname = "{}/{}/{}/{}".format(
        session["category"], session["group"], session["name"], session["mode"]
    )
    uid = yjj.hash_str_32(uname)
    ctx.category = "*"
    ctx.group = "*"
    ctx.name = "*"
    ctx.mode = "*"
    locations = collect_journal_locations(ctx)
    location = locations[uid]
    home = make_location_from_dict(ctx, location)
    io_device = yjj.io_device_console(home, ctx.console_width, ctx.console_height)

    show_in = (io_type == "in" or io_type == "all") and not (
        io_device.home.category == lf.enums.category.SYSTEM
        and io_device.home.group == "master"
        and io_device.home.name == "master"
    )
    show_out = io_type == "out" or io_type == "all"

    return locations, session, io_device, show_in, show_out


def show_journal(ctx, session_id, io_type, csv):
    locations, session, io_device, show_in, show_out = read_session(
        ctx, session_id, io_type
    )
    io_device.show(
        session["begin_time"],
        session["end_time"],
        show_in,
        show_out,
        csv,
    )


def trace_journal(ctx, session_id, io_type, csv):
    locations, session, io_device, show_in, show_out = read_session(
        ctx, session_id, io_type
    )
    io_device.trace(
        session["begin_time"],
        session["end_time"],
        show_in,
        show_out,
        csv,
    )
