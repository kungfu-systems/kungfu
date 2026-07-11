#  SPDX-License-Identifier: Apache-2.0

import csv
import inspect
import glob
import kungfu
import shutil
import os

lf = kungfu.__binding__.yijinjing
yjj = kungfu.__binding__.runtime


class Adapter:
    def __init__(self, ctx):
        self.ctx = ctx
        self.named_types = {}
        self.tagged_types = {}

        lf_states = inspect.getmembers(lf.state, inspect.isclass)
        lf_types = inspect.getmembers(lf.types, inspect.isclass)
        states = set(map(lambda s: s[0], lf_states))
        for t in filter(lambda m: m[1].__has_data__ and m[0] in states, lf_types):
            self.named_types[t[0]] = t[1]
            self.tagged_types[t[1].__tag__] = t[1]

    def write_data(self):
        raise NotImplementedError

    def run(self):
        self.ctx.logger.info("exporting data to csv")
        self.write_data()

        target_path = os.path.join(self.ctx.dataset_dir, self.ctx.dataset_name)
        backup_path = os.path.join(self.ctx.dataset_dir, ".backup")
        output_path = os.path.join(self.ctx.dataset_dir, ".output")

        if os.path.exists(backup_path):
            shutil.rmtree(backup_path)
        if os.path.exists(target_path):
            shutil.move(target_path, backup_path)

        target_locator = yjj.locator(target_path)
        backup_locator = yjj.locator(backup_path)
        output_locator = yjj.locator(output_path)

        sink = yjj.null_sink()
        writers = {}
        for csv_file in glob.glob(os.path.join(self.ctx.inbox_dir, "*.csv")):
            try:
                filename = os.path.splitext(os.path.basename(csv_file))[0]
                name_list = filename.split(".")
                if len(name_list) != 4:
                    self.ctx.logger.error(f"invalid csv name {filename}")
                    continue
                role, namespace, name, type_name = name_list
                writer_key = role + namespace + name
                if writer_key not in writers:
                    home = yjj.location(
                        lf.enums.mode.DATA,
                        lf.enums.get_location_role_by_name(role),
                        namespace,
                        name,
                        output_locator,
                    )
                    writers[writer_key] = yjj.writer(home, 0, True, sink.publisher)
                writer = writers[writer_key]
                data_type = self.named_types[type_name]
                with open(csv_file, "r", newline="") as file:
                    reader = csv.reader(file)
                    header = next(reader)
                    for row in reader:
                        json_text = (
                            "{"
                            + ",".join([f'"{t[0]}":{t[1]}' for t in zip(header, row)])
                            + "}"
                        )
                        data = data_type(json_text)
                        writer.write_at(int(row[0]), 0, data)
            finally:
                os.remove(csv_file)

        yjj.assemble([output_locator, backup_locator]) >> yjj.copy_sink(target_locator)

        if os.path.exists(output_path):
            shutil.rmtree(output_path)
        if os.path.exists(backup_path):
            shutil.rmtree(backup_path)
