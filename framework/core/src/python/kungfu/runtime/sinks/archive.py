#  SPDX-License-Identifier: Apache-2.0

import kungfu
import os


from kungfu.runtime.time import DAY_IN_NANO

lf = kungfu.__binding__.yijinjing
yjj = kungfu.__binding__.runtime


class ArchiveSink(yjj.sink):
    def __init__(self, ctx):
        yjj.sink.__init__(self)
        self.ctx = ctx
        self.archive_locator = yjj.locator(ctx.archive_dir)
        self.last_day = 0
        self.locator = None
        self.writer_maps = {}

    def ensure_journal(self, location):
        writers = self.writer_maps[location.uid]
        for dest_id in location.locator.list_location_dest(location):
            if dest_id not in writers:
                target_location = yjj.location(
                    location.mode,
                    location.role,
                    location.namespace,
                    location.name,
                    self.locator,
                )

                # have to find_page_size of 'location', instead of 'target_location'
                page_size = int(self.find_page_size(location, dest_id) / (1024 * 1024))
                writers[dest_id] = yjj.writer(
                    target_location,
                    dest_id,
                    True,
                    self.publisher,
                    False,
                    self.bus,
                    page_size,
                )

    def put(self, location, dest_id, frame):
        date = int(frame.gen_time / DAY_IN_NANO)
        if date > self.last_day:
            date_str = yjj.strftime(date * DAY_IN_NANO, "%Y-%m-%d")
            self.ctx.logger.info(f"making archive for {date_str}")
            self.locator = yjj.locator(os.path.join(self.ctx.archive_dir, date_str))
            self.writer_maps = {}
            self.last_day = date
        if location.uid not in self.writer_maps:
            self.writer_maps[location.uid] = {}
        writers = self.writer_maps[location.uid]
        if dest_id not in writers:
            self.ensure_journal(location)
        writers[dest_id].copy_frame(frame)
