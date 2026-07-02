#  SPDX-License-Identifier: Apache-2.0

import click
import kungfu

from kungfu.console.commands import kfc, PrioritizedCommandGroup
from kungfu.yijinjing import journal as kfj
from kungfu.yijinjing.practice.executor import ExecutorRegistry
from kungfu.yijinjing.practice.run import run_forever
from kungfu.yijinjing.practice.master import Master

lf = kungfu.__binding__.longfist
wc = kungfu.__binding__.wingchun
yjj = kungfu.__binding__.yijinjing
service_command_context = kfc.pass_context("low_latency")


@kfc.command(help_priority=1)
@click.option(
    "-m", "--mode", default="live", type=click.Choice(kfj.MODES.keys()), help="mode"
)
@click.option(
    "-c",
    "--category",
    type=click.Choice(kfj.CATEGORIES.keys()),
    help="category",
)
@click.option(
    "-M",
    "--matcher",
    type=str,
    help="path to matcher .dll/.so/.py",
)
@click.option(
    "-F",
    "--from_indexer",
    type=str,
    help="path to from_indexer .py",
)
@click.option(
    "-T",
    "--to_indexer",
    type=str,
    help="path to to_indexer .py",
)
@click.option(
    "-r",
    "--report",
    type=str,
    help="path to report .dll/.so/.py",
)
@click.option(
    "-I",
    "--time_interval",
    type=int,
    help="the Maximum error in time, in seconds, for when the callback function of add_timer/add_time_interval will be called",
)
@click.option(
    "-B",
    "--backtest",
    type=str,
    help="the backtest config in json format or .json file path.",
)
@click.option("-b", "--begin", type=str, required=False, help="begin time")
@click.option("-e", "--end", type=str, required=False, help="end time")
@click.option("-i", "--session_id", type=int, required=False, help="session id")
@click.option("-g", "--group", type=str, help="group")
@click.option("-n", "--name", type=str, help="name")
@click.option("-x", "--low-latency", is_flag=True, help="run in low latency mode")
@click.argument("reference", type=str, required=False)
@click.option("-a", "--arguments", type=str, required=False)
@click.option("-v", "--vendor", type=str, required=False)
@click.option(
    "-ENV-bypass-cached", is_flag=True, required=False, help="run in bypass cached mode"
)
@click.option(
    "-ENV-keep-page",
    is_flag=True,
    required=False,
    help="keep journal page when process running",
)
@click.option(
    "-ENV-bypass-accounting",
    is_flag=True,
    required=False,
    help="bypass strategy bookkeeper accounting  ",
)
@click.option(
    "-ENV-bypass-refresh-book",
    is_flag=True,
    required=False,
    help="bypass refresh book in ledger  ",
)
@click.option(
    "-ENV-bypass-sync-asset",
    is_flag=True,
    required=False,
    help="bypass sync asset every minute  ",
)
@click.option(
    "-ENV-bypass-sync-position",
    is_flag=True,
    required=False,
    help="bypass sync position every minute  ",
)
@click.option(
    "-ENV-log-frame",
    is_flag=True,
    required=False,
    help="log frame message source->dest:msg_type:frame_uid  ",
)
@click.option(
    "-ENV-low-memory",
    is_flag=True,
    required=False,
    help="clear orders in broker memory every interval ",
)
@click.option(
    "-ARG-max-pre-create-size",
    type=str,
    required=False,
    help="master max pre-created journal page size ",
)
@kfc.pass_context()
def run(
    ctx,
    mode,
    category,
    matcher,
    from_indexer,
    to_indexer,
    report,
    time_interval,
    backtest,
    begin,
    end,
    session_id,
    group,
    name,
    low_latency,
    reference,
    arguments,
    vendor,
    env_keep_page,
    env_bypass_accounting,
    env_bypass_refresh_book,
    env_bypass_cached,
    env_bypass_sync_asset,
    env_bypass_sync_position,
    env_log_frame,
    env_low_memory,
    arg_max_pre_create_size,
):
    ctx.mode = mode
    ctx.category = category
    ctx.matcher = matcher
    ctx.from_indexer = from_indexer
    ctx.to_indexer = to_indexer
    ctx.report = report
    ctx.backtest = backtest
    ctx.time_interval = time_interval
    ctx.begin = begin
    ctx.end = end
    ctx.session_id = session_id
    ctx.group = group
    ctx.name = name
    ctx.low_latency = low_latency
    ctx.path = reference
    ctx.arguments = arguments or "{}"
    ctx.vendor = vendor

    registry = ExecutorRegistry(ctx)

    cheatsheet = {
        "master": registry["system"]["master"]["master"],
        # ledger is absent when the carved wingchun runtime is not linked in;
        # ServiceLoader registers it only when the binding provides it.
        **registry["system"]["service"],
    }

    ctx.executor = None

    if not category and not reference:
        click.echo(run.get_help(ctx))
    elif reference in cheatsheet:
        ctx.executor = cheatsheet[reference](mode, low_latency)
    else:
        registry.load_extensions()
        ctx.executor = registry[category][group][name](mode, low_latency)

    if ctx.executor is not None:
        run_forever(ctx, ctx.executor)


@kfc.command(cls=PrioritizedCommandGroup, help_priority=-1)
@kfc.pass_context()
def service(ctx):
    pass


@service.command(help_priority=1)
@service_command_context
def master(ctx):
    Master(ctx).run()
