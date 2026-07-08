#  SPDX-License-Identifier: Apache-2.0

import csv
import kungfu
import os

from contextlib import contextmanager

lf = kungfu.__binding__.longfist
yjj = kungfu.__binding__.yijinjing


class CsvSink(yjj.sink):
    def __init__(self, ctx, tagged_types):
        yjj.sink.__init__(self)
        self.ctx = ctx
        self.tagged_types = tagged_types
        self.files = {}
        self.writers = {}

    def put(self, location, dest_id, frame):
        if frame.carrier_type not in self.tagged_types:
            return
        data_type = self.tagged_types[frame.carrier_type]
        header = [m for m in vars(data_type) if not m.startswith("_")]
        location_part = f"{lf.enums.get_location_role_name(location.role)}.{location.group}.{location.name}"
        output = os.path.join(
            self.ctx.inbox_dir, f"{location_part}.{data_type.__name__}.csv"
        )
        if output not in self.writers:
            self.files[output] = open(output, "w", newline="")
            self.writers[output] = csv.writer(self.files[output])
            self.writers[output].writerow(["gen_time"] + header)
        data = getattr(frame, data_type.__name__)()
        self.writers[output].writerow(
            [frame.gen_time] + [extract(data, m) for m in header]
        )

    def close(self):
        [file.close() for file in self.files.values()]


def extract(data, m):
    result = getattr(data, m)
    result_type = type(result)
    if result_type.__module__ == lf.enums.__name__:
        return int(result)
    if result_type is str:
        return '"' + result.replace('"', '\\"') + '"'
    return result


@contextmanager
def open_csv_sink(ctx, tagged_types):
    sink = CsvSink(ctx, tagged_types)
    try:
        yield sink
    finally:
        sink.close()
