#  SPDX-License-Identifier: Apache-2.0

import click
import functools
import glob
import kungfu
import os
import shutil
import zipfile

from collections import deque

from kungfu.cli.commands import kfc, PrioritizedCommandGroup
from kungfu.runtime import LOG_PATTERN, ARCHIVE_PREFIX
import kungfu.runtime as kfr
from kungfu.runtime import time as kft
from kungfu.runtime.log import create_logger
from kungfu.runtime.sinks.archive import ArchiveSink
from kungfu.runtime.utils import prune_layout_files, prue_layout_dirs_before_timestamp


lf = kungfu.__binding__.yijinjing
yjj = kungfu.__binding__.runtime
journal_command_context = kfc.pass_context(
    "logger", "location", "console_width", "console_height"
)


@kfc.group(cls=PrioritizedCommandGroup, help_priority=2)
@click.option(
    "-m", "--mode", default="*", type=click.Choice(list(kfr.MODES)), help="mode"
)
@click.option(
    "-c",
    "--role",
    default="*",
    type=click.Choice(list(kfr.ROLES)),
    help="role",
)
@click.option("-g", "--namespace", "namespace", type=str, default="*", help="namespace")
@click.option("--group", "legacy_group", type=str, default=None, hidden=True)
@click.option("-n", "--name", type=str, default="*", help="name")
@click.help_option("-h", "--help")
@kfc.pass_context()
def journal(ctx, mode, role, namespace, legacy_group, name):
    if legacy_group is not None:
        namespace = legacy_group
    ctx.low_latency = False
    ctx.mode = mode
    ctx.role = role
    ctx.namespace = namespace
    ctx.name = name
    ctx.location = yjj.location(
        kfr.MODES[mode], kfr.ROLES[role], namespace, name, ctx.runtime_locator
    )
    ctx.logger = create_logger("journal", ctx.log_level, ctx.console_location)

    (ctx.console_width, ctx.console_height) = shutil.get_terminal_size((0, 0))
    yjj.setup_log(ctx.console_location, "journal")


@journal.command()
@click.option("-A", "--archive", is_flag=True, help="archive")
@click.option("-D", "--dry", is_flag=True, help="dry run")
@journal_command_context
def clean(ctx, archive, dry):
    search_path = os.path.join(
        ctx.runtime_dir, "journal", "*", "*", "*", "*", "*.journal"
    )
    journal_files = glob.glob(search_path)
    if dry:
        for journal_file in journal_files:
            click.echo(f"rm {journal_file}")
        return
    if archive:
        datestr = kft.strfnow("%Y%m%d-%H%M%S")
        archive_path = os.path.join(ctx.home, f"KFA-{datestr}.zip")
        archive_zip = zipfile.ZipFile(
            archive_path, mode="w", compression=zipfile.ZIP_LZMA
        )
        for journal_file in journal_files:
            archive_zip.write(journal_file)
        click.echo(f"archived to {archive_path}")
    for journal_file in journal_files:
        os.remove(journal_file)
    click.echo(f"cleaned {len(journal_files)} journal files")


@journal.command()
@click.option(
    "-f",
    "--format",
    type=click.Choice(["zip", "tar"]),
    default="zip",
    help="archive format",
)
@click.option(
    "-m",
    "--mode",
    type=click.Choice(["normal", "delete"]),
    default="normal",
    help="archive mode",
)
@journal_command_context
def archive(ctx, format, mode):
    ctx.logger.info("archiving start")
    os.chdir(ctx.archive_dir)
    today_date = yjj.strftime(yjj.now_in_nano(), "%Y-%m-%d")
    tomorrow_date = yjj.strftime(yjj.now_in_nano() + 24 * 60 * 60 * 10**9, "%Y-%m-%d")
    if mode == "delete":
        today_start = yjj.strptime(today_date, "%Y-%m-%d")
        today_start_timestamp = today_start / 10**9
        tomorrow_start = yjj.strptime(tomorrow_date, "%Y-%m-%d")
        tomorrow_start_timestamp = tomorrow_start / 10**9
        ctx.logger.info(
            f"pruning runtime logs before {yjj.strftime(today_start, '%Y-%m-%d %H:%M:%S')}"
        )
        prue_layout_dirs_before_timestamp(
            ctx.runtime_dir, "log", "live", today_start_timestamp
        )
        ctx.logger.info(
            f"pruning runtime journals before {yjj.strftime(tomorrow_start, '%Y-%m-%d %H:%M:%S')}"
        )
        prue_layout_dirs_before_timestamp(
            ctx.runtime_dir, "journal", "live", tomorrow_start_timestamp
        )
        ctx.logger.info("archive done (delete mode)")
        return

    today_archive_name = f"{ARCHIVE_PREFIX}-{today_date}.{format}"
    today_archive_path = os.path.join(ctx.archive_dir, today_archive_name)
    today_temp_path = os.path.join(ctx.archive_dir, ".today")

    ctx.logger.info("preparing archive folder")
    deque(map(shutil.rmtree, filter(os.path.isdir, os.listdir(os.curdir))))

    if os.path.exists(today_archive_path):
        shutil.unpack_archive(today_archive_path, today_temp_path)
        export_logs(ctx, today_temp_path, ctx.archive_dir)
    else:
        os.makedirs(today_temp_path)

    ctx.logger.info("exporting journals")
    yjj.assemble([ctx.runtime_locator, yjj.locator(today_temp_path)]) >> ArchiveSink(
        ctx
    )
    shutil.rmtree(today_temp_path)

    ctx.logger.info("exporting logs")
    export_logs(ctx, ctx.runtime_dir, ctx.archive_dir)

    ctx.logger.info("compressing archive files")
    deque(
        map(
            functools.partial(make_archive, ctx, format),
            filter(os.path.isdir, sorted(os.listdir(os.curdir))),
        )
    )

    ctx.logger.info("pruning runtime logs")
    prune_layout_files(ctx.runtime_dir, "log", "live")
    ctx.logger.info("pruning runtime journals")
    prune_layout_files(ctx.runtime_dir, "journal", "live")

    if os.path.exists(today_archive_path):
        ctx.logger.info(f"unpack_archive {today_archive_path}")
        shutil.unpack_archive(today_archive_path, ctx.runtime_dir)
    ctx.logger.info("archive done")


@journal.command("list-archive")
@journal_command_context
def list_archive(ctx):
    deque(map(print_archive, glob.glob(os.path.join(ctx.archive_dir, "*.zip"))))


def export_logs(ctx, src_dir, dst_dir):
    search_path = os.path.join(src_dir, "log", "*", "*", "*", "live", "*.log")
    for log_file in glob.glob(search_path):
        match = LOG_PATTERN.match(log_file[len(src_dir) + 1 :])
        if match:
            role = match.group(1)
            namespace = match.group(2)
            name = match.group(3)
            mode = match.group(4)
            date = match.group(6)
            archive_path = os.path.join(
                dst_dir, date, role, namespace, name, "log", mode
            )
            if not os.path.exists(archive_path):
                os.makedirs(archive_path)
            archive_log = os.path.join(archive_path, os.path.basename(log_file))
            if os.path.exists(archive_log):
                with open(log_file, "rb") as src, open(archive_log, "ab") as dst:
                    shutil.copyfileobj(src, dst)
            else:
                shutil.copy2(log_file, archive_path)
        else:
            ctx.logger.warn(f"unable to match log file {log_file}")


def make_archive(ctx, archive_format, archive_date):
    archive_name = f"{ARCHIVE_PREFIX}-{archive_date}"
    archive_file = f"{archive_name}.{archive_format}"
    if os.path.exists(archive_file):
        ctx.logger.warn(f"removed duplicated {archive_file}")
        os.remove(archive_file)
    shutil.make_archive(archive_name, archive_format, archive_date)
    shutil.rmtree(archive_date)
    ctx.logger.info(f"compressed archive for {archive_date}")


def print_archive(archive_file):
    archive_name = os.path.basename(archive_file)
    print(archive_name[4:-4])
