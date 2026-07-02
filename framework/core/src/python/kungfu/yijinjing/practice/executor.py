#  SPDX-License-Identifier: Apache-2.0

import importlib
import json
import os
import sys
import types
import kungfu
import glob
from pathlib import Path
from fnmatch import fnmatch

from kungfu.console import site
from kungfu.yijinjing import journal as kfj
from kungfu.yijinjing.log import find_logger
from kungfu.yijinjing import time as kft
from kungfu.yijinjing.practice.master import Master
from kungfu.yijinjing.practice.coloop import KungfuEventLoop

# tracing-foundation Phase 1: wingchun 交易运行时(strategy/sliceindexer/report/operator)
# 已从 C++ 核心 carve;此处降级为 lazy 占位,使 executor 可被命令注册表导入(kfc 起得来)。
# 这些符号仅在真正执行 run/strategy/operator 交易路径时才被用到(StrategyRunner/OperatorRunner
# 的方法内),Phase 1 不走交易路径;Python 交易运行时的正式处置见 goal Phase 1「Python 半」。
try:
    from kungfu.wingchun.strategy import Runner, Strategy
    from kungfu.wingchun.sliceindexer import SliceIndexer
    from kungfu.wingchun.report import Report
    from kungfu.wingchun.operator import OpRunner, Operator
except (ImportError, AttributeError):
    Runner = Strategy = SliceIndexer = Report = OpRunner = Operator = None

from collections import deque
from os import path

lf = kungfu.__binding__.longfist
wc = kungfu.__binding__.wingchun
yjj = kungfu.__binding__.yijinjing


class ExecutorRegistry:
    def __init__(self, ctx):
        ctx.locator = (
            ctx.backtest_locator
            if kfj.MODES[ctx.mode] == lf.enums.mode.BACKTEST
            else ctx.runtime_locator
        )
        ctx.location = yjj.location(
            kfj.MODES[ctx.mode],
            kfj.CATEGORIES[ctx.category],
            ctx.group,
            ctx.name,
            ctx.locator,
        )
        self.ctx = ctx
        self.executors = {
            "system": {"master": MasterLoader(ctx), "service": ServiceLoader(ctx)},
            "md": {},
            "td": {},
            "strategy": {"default": ExtensionLoader(self.ctx, None, None)},
            "operator": {},
        }
        self.setup_log()

    def setup_log(self):
        ctx = self.ctx
        ctx.logger = find_logger(ctx.location, ctx.log_level)
        ctx.logger.info(f"{ctx.location}")

    def load_extensions(self):
        ctx = self.ctx
        ctx.logger.debug(f"finding kungfu extension for {ctx.location}")

        if ctx.arguments.endswith(".json"):
            json_path = ctx.arguments.replace("\\", "/")
            try:
                with open(json_path, "r", encoding="utf-8") as file:
                    ctx.arguments = json.dumps(json.load(file))
                    ctx.logger.info(f"arguments: {ctx.arguments}")
            except Exception as e:
                ctx.logger.error(f"load json from {json_path} failed: {e}")
                raise e

        if ctx.extension_path:
            deque(map(self.register_extensions, ctx.extension_path.split(path.pathsep)))
            sys.path.append(ctx.extension_path)
            site.setup(ctx.extension_path)
        elif ctx.path:
            self.read_config(os.path.dirname(ctx.path))

        if ctx.group not in self.executors[ctx.category]:
            self.executors[ctx.category][ctx.group] = ExtensionLoader(ctx, None, None)

        if (
            ctx.category == "system"
            and ctx.group == "service"
            and ctx.name not in self.executors["system"]["service"]
        ):
            self.executors["system"]["service"].load_service(ctx)

    def register_extensions(self, root):
        self.ctx.logger.debug(f"root: {root}")
        sys.path.append(root)
        site.setup(root)
        for child in os.listdir(root):
            extension_dir = path.abspath(path.join(root, child))
            self.read_config(extension_dir)

    def read_config(self, extension_dir):
        config_path = os.path.join(extension_dir, "package.json")

        def report(reason):
            self.ctx.logger.debug(
                f"kungfu extension not found in {extension_dir}: {reason}"
            )

        if path.exists(config_path):
            with open(config_path, mode="r", encoding="utf8") as config_file:
                config = json.load(config_file)
                if "kungfuConfig" in config:
                    if "config" in config["kungfuConfig"]:
                        group = config["kungfuConfig"]["key"]
                        for category in config["kungfuConfig"]["config"]:
                            if category not in kfj.CATEGORIES:
                                raise RuntimeError(f"Unsupported category {category}")
                            if (
                                self.executors["strategy"]["default"]
                                and self.ctx.category == "strategy"
                                and self.ctx.group == "default"
                            ):
                                self.executors["strategy"]["default"].config = config
                            else:
                                self.executors[category][group] = ExtensionLoader(
                                    self.ctx, extension_dir, config
                                )
                    elif "key" in config["kungfuConfig"]:
                        if (
                            self.ctx.category == "strategy"
                            or self.ctx.category == "operator"
                        ):
                            group = config["kungfuConfig"]["key"]
                            self.executors[self.ctx.category][group] = ExtensionLoader(
                                self.ctx, extension_dir, config
                            )
                        else:
                            report("load extension config with unsupported category.")
                    else:
                        report("missing key/config in kungfuConfig")
                else:
                    report("missing kungfuConfig")

    def __getitem__(self, category):
        return self.executors[category]

    def __str__(self):
        return json.dumps(self.executors, indent=2, cls=RegistryJSONEncoder)

    def __repr__(self):
        return json.dumps(self.executors, cls=RegistryJSONEncoder)


class MasterLoader(dict):
    def __init__(self, ctx):
        super().__init__()
        self.ctx = ctx
        self["master"] = MasterExecutor(self.ctx)


class ServiceLoader(dict):
    def __init__(self, ctx):
        super().__init__()
        self.ctx = ctx
        # Ledger lives in the carved wingchun trading runtime; keep the service
        # slot lazy so `kfc run master` boots on the clean core (same
        # degradation as the wingchun imports above).
        if hasattr(wc, "Ledger"):
            self["ledger"] = ServiceExecutor(self.ctx, "ledger", wc.Ledger)

    def load_service(self, ctx):
        self[ctx.name] = ServiceExecutor(
            ctx, ctx.name, load_service_vendor_builder(ctx)
        )


class ExtensionLoader:
    def __init__(self, ctx, extension_dir, config):
        self.ctx = ctx
        self.extension_dir = extension_dir
        self.config = config

    def __getitem__(self, name):
        return ExtensionExecutorBuilder(self.ctx, self)

    def __str__(self):
        return self.config["kungfuConfig"]["name"]

    def __repr__(self):
        return self.__str__()


class ExtensionExecutorBuilder:
    def __init__(self, ctx, loader):
        self.ctx = ctx
        self.loader = loader
        self.runners = {
            "md": self.get_market_data_vendor,
            "td": self.get_trader_vendor,
            "strategy": self.get_strategy_runner,
            "operator": self.get_operator_runner,
        }

    def __call__(self, mode, low_latency):
        return self.runners[self.ctx.category]()

    def get_market_data_vendor(self):
        return BrokerVendor(self.ctx, self.loader, load_md_vendor(self.ctx))

    def get_trader_vendor(self):
        return BrokerVendor(self.ctx, self.loader, load_td_vendor(self.ctx))

    def get_strategy_runner(self):
        return StrategyRunner(self.ctx, self.loader, load_strategy_runner(self.ctx))

    def get_operator_runner(self):
        return OperatorRunner(self.ctx, self.loader, load_operator_runner(self.ctx))


class Executor:
    def __init__(self, ctx):
        self.ctx = ctx
        self._executor = None

    def post_run(self):
        pass

    def get_home_uid(self):
        return self._executor.get_home_uid()

    def get_home_uname(self):
        return self._executor.get_home_uname()

    def get_begin_time(self):
        return self._executor.get_begin_time()

    def get_end_time(self):
        return self._executor.get_end_time()

    def pre_setup(self):
        self._executor.pre_setup()

    def setup(self):
        self._executor.setup()

    def run(self, step_limit=0):
        self._executor.run(step_limit)

    def step(self, count=0):
        self._executor.step(count)

    def is_live(self):
        return self._executor.is_live()

    def on_exit(self):
        self._executor.on_exit()

    def get_home(self):
        return self._executor.home


class MasterExecutor(Executor):
    def __init__(self, ctx):
        super().__init__(ctx)

    def __call__(self, mode, low_latency):
        self._executor = self.build_executor()
        return self

    def build_executor(self):
        return Master(self.ctx)


class ServiceExecutor(Executor):
    def __init__(self, ctx, name, service_builder):
        super().__init__(ctx)
        self.name = name
        self.service_builder = service_builder

    def __call__(self, mode, low_latency):
        self._executor = self.build_executor()
        return self

    def build_executor(self):
        ctx = self.ctx
        ctx.logger.info(
            f"starting service {self.name}, low_latency={ctx.low_latency}, arguments={ctx.arguments}, mode={ctx.mode}"
        )
        service = (
            self.service_builder(ctx)
            if "is_python_service" in dir(self.service_builder)
            and self.service_builder.is_python_service
            else self.service_builder(
                ctx.runtime_locator,
                ctx.group,
                ctx.name,
                kfj.MODES[ctx.mode],
                ctx.low_latency,
                ctx.arguments,
            )
        )
        if kfj.MODES[ctx.mode] == lf.enums.mode.REPLAY:
            begin_time_stamp, end_time_stamp = parse_begin_end(ctx)
            service.set_begin_time(begin_time_stamp)
            service.set_end_time(end_time_stamp)

        return service


class ExtensionExecutor(Executor):
    def __init__(self, ctx, loader):
        super().__init__(ctx)
        self.loader = loader
        self.setup_env(self.loader, use_ctx_path=True)
        self._executor = self.build_executor(self.loader)

    def setup_env(self, loader, use_ctx_path=True):
        if loader.extension_dir:
            site.setup(loader.extension_dir)
            sys.path.insert(0, loader.extension_dir)
        elif use_ctx_path and self.ctx.path:
            self.ctx.logger.info(f"path: {self.ctx.path}")
            dirname = os.path.dirname(self.ctx.path)
            site.setup(dirname)
            sys.path.insert(0, dirname)


class BrokerVendor(ExtensionExecutor):
    def __init__(self, ctx, loader, vendor):
        ctx.broker_vendor = vendor
        super().__init__(ctx, loader)

    def build_executor(self, loader):
        ctx = self.ctx

        # let TD and MD start without package.json
        sys.path.insert(0, ctx.extension_path)
        self.ctx.logger.info(f"try to loading {ctx.group} from {loader.extension_dir}")
        module = importlib.import_module(ctx.group)
        self.ctx.logger.info(f"loading {ctx.group} from {loader.extension_dir}")
        service_builder = getattr(module, ctx.category)
        self.ctx.logger.debug("loaded broker service builder")
        ctx.broker_service = service_builder(ctx.broker_vendor)
        self.ctx.logger.debug("set broker service for broker vendor")
        ctx.broker_vendor.set_service(ctx.broker_service)
        self.ctx.logger.info(f"broker vendor {ctx.location.uname} ready to run")

        if kfj.MODES[ctx.mode] == lf.enums.mode.REPLAY:
            begin_time_stamp, end_time_stamp = parse_begin_end(ctx)
            ctx.broker_vendor.set_begin_time(begin_time_stamp)
            ctx.broker_vendor.set_end_time(end_time_stamp)
        return ctx.broker_vendor


class StrategyRunner(ExtensionExecutor):
    def __init__(self, ctx, loader, strategy_runner):
        ctx.strategy_runner = strategy_runner
        super().__init__(ctx, loader)

    def build_executor(self, loader):
        ctx = self.ctx
        os.environ["KF_STG_GROUP"] = ctx.group
        os.environ["KF_STG_NAME"] = ctx.name
        if loader.config is None:
            load = False
            json_config = os.path.join(os.path.dirname(ctx.path), "package.json")
            # 如果策略目录下有package.json, 则从package.json里面读取key值作为策略的python模块名
            if path.exists(json_config):
                with open(json_config, mode="r", encoding="utf8") as json_config_out:
                    config = json.load(json_config_out)
                    if "kungfuConfig" in config and "key" in config["kungfuConfig"]:
                        key = config["kungfuConfig"]["key"]
                        load = True
                        ctx.strategy = load_module(ctx, ctx.path, key, Strategy)
            # 如果没有从策略目录下的读取到package.json, 则用ctx.group作为key值去导入策略模块, ctx.group是策略的python模块名
            if not load:
                ctx.strategy = load_module(ctx, ctx.path, ctx.group, Strategy)
        else:
            ctx.strategy = load_module(
                ctx, ctx.path, loader.config["kungfuConfig"]["key"], Strategy
            )

        if kfj.MODES[ctx.mode] == lf.enums.mode.BACKTEST:
            if ctx.matcher:
                matcher = load_module(
                    ctx,
                    ctx.matcher,
                    Path(ctx.matcher).stem.split(".")[0],
                    None,
                    "matcher",
                )
                ctx.strategy_runner.set_matcher(matcher)
            begin_time_stamp, end_time_stamp = parse_begin_end(ctx)
            ctx.strategy_runner.set_begin_time(begin_time_stamp)
            ctx.strategy_runner.set_end_time(end_time_stamp)
            from_indexer, to_indexer = parse_from_to_indexer(
                ctx, begin_time_stamp, end_time_stamp
            )
            if from_indexer:
                ctx.strategy_runner.set_from_indexer(from_indexer)
            if to_indexer:
                ctx.strategy_runner.set_to_indexer(to_indexer)
            if ctx.report:
                self.report = load_module(
                    ctx, ctx.report, Path(ctx.report).stem.split(".")[0], Report
                )
                ctx.strategy_runner.set_report(self.report)
            if ctx.time_interval:
                ctx.strategy_runner.set_time_interval(
                    ctx.time_interval * kft.NANO_PER_SECOND
                )
            ctx.strategy_runner.set_backtest_config(parse_backtest_config(ctx))
        if kfj.MODES[ctx.mode] == lf.enums.mode.REPLAY:
            begin_time_stamp, end_time_stamp = parse_begin_end(ctx)
            ctx.strategy_runner.set_begin_time(begin_time_stamp)
            ctx.strategy_runner.set_end_time(end_time_stamp)

        ctx.strategy_runner.add_strategy(ctx.strategy)
        ctx.strategy_runner.set_strategy_dir(os.path.dirname(ctx.path))

        if kfj.MODES[ctx.mode] == lf.enums.mode.LIVE and "is_cpp_module" not in dir(
            ctx
        ):
            ctx.logger.debug("use kungfu event loop")
            # IMPORTANT, ctx.loop is taken by strategy.py
            ctx.loop = KungfuEventLoop(ctx, ctx.strategy_runner)
            return ctx.loop
        else:
            ctx.logger.debug("use run")
            return ctx.strategy_runner

    def post_run(self):
        if kfj.MODES[self.ctx.mode] == lf.enums.mode.BACKTEST and self.ctx.report:
            self.report.sumerize()


class OperatorRunner(ExtensionExecutor):
    def __init__(self, ctx, loader, op_runner):
        ctx.op_runner = op_runner
        super().__init__(ctx, loader)

    def build_executor(self, loader):
        ctx = self.ctx
        os.environ["KF_OP_GROUP"] = ctx.group
        # TODO check extension.h for implementation details, how to deal with 1 runner : N operators?
        os.environ["KF_OP_NAME"] = ctx.name
        if ctx.path is None:
            module_path = list(
                filter(
                    lambda file_name: (
                        fnmatch(file_name, "*.so")
                        or fnmatch(file_name, "*.pyd")
                        or fnmatch(file_name, "*.py")
                    ),
                    glob.glob(os.path.join(loader.extension_dir, ctx.group + "*")),
                )
            )[0]
            ctx.path = os.path.abspath(module_path)
        if loader.config is None:
            load = False
            json_config = os.path.join(os.path.dirname(ctx.path), "package.json")
            if path.exists(json_config):
                with open(json_config, mode="r", encoding="utf8") as json_config_out:
                    config = json.load(json_config_out)
                    if "kungfuConfig" in config and "key" in config["kungfuConfig"]:
                        key = config["kungfuConfig"]["key"]
                        load = True
                        ctx.operator = load_module(ctx, ctx.path, key, Operator)
            if not load:
                ctx.operator = load_module(ctx, ctx.path, ctx.group, Operator)
        else:
            ctx.operator = load_module(
                ctx, ctx.path, loader.config["kungfuConfig"]["key"], Operator
            )
        if kfj.MODES[ctx.mode] == lf.enums.mode.BACKTEST:
            begin_time_stamp, end_time_stamp = parse_begin_end(ctx)
            ctx.op_runner.set_begin_time(begin_time_stamp)
            ctx.op_runner.set_end_time(end_time_stamp)
            from_indexer, to_indexer = parse_from_to_indexer(
                ctx, begin_time_stamp, end_time_stamp
            )
            if from_indexer:
                ctx.op_runner.set_from_indexer(from_indexer)
            if to_indexer:
                ctx.op_runner.set_to_indexer(to_indexer)
            if ctx.report:
                self.report = load_module(
                    ctx, ctx.report, Path(ctx.report).stem.split(".")[0], Report
                )
                ctx.op_runner.set_report(self.report)
            if ctx.time_interval:
                ctx.op_runner.set_time_interval(ctx.time_interval * kft.NANO_PER_SECOND)
            ctx.op_runner.set_backtest_config(parse_backtest_config(ctx))

        if kfj.MODES[ctx.mode] == lf.enums.mode.REPLAY:
            begin_time_stamp, end_time_stamp = parse_begin_end(ctx)
            ctx.op_runner.set_begin_time(begin_time_stamp)
            ctx.op_runner.set_end_time(end_time_stamp)

        ctx.op_runner.add_operator(ctx.operator)
        ctx.op_runner.set_operator_dir(os.path.dirname(ctx.path))
        return ctx.op_runner

    def post_run(self):
        if kfj.MODES[self.ctx.mode] == lf.enums.mode.BACKTEST and self.ctx.report:
            self.report.sumerize()


class RegistryJSONEncoder(json.JSONEncoder):
    def default(self, obj):
        test = isinstance(obj, ExtensionLoader) or isinstance(obj, types.FunctionType)
        return str(obj) if test else obj.__dict__


def load_module(ctx, path, key, cls, cls_name=None):
    if cls:
        cls_name = cls.__name__
    ctx.logger.debug(f"loading {cls_name} from {path}")
    ctx.logger.debug(f"{cls_name} key: {key}")
    ctx.logger.debug(f"{cls_name} dirname: {os.path.dirname(path)}")

    if path.endswith(".py"):
        return cls(ctx)  # keep strategy alive for pybind11
    elif key is not None and (path.endswith(".so") or path.endswith(".pyd")):
        return try_load_cpp_module(ctx, path, key, cls, cls_name)
    elif key is not None and path.endswith(key):
        return cls(ctx)
    else:
        ctx.path = os.path.join(os.path.dirname(path), key)
        return cls(ctx)


def try_load_cpp_module(ctx, path, key, cls, cls_name):
    if cls:
        cls_name = cls.__name__
    dirname = os.path.dirname(path)
    site.setup(dirname)
    sys.path.insert(0, dirname)
    try:
        module = importlib.import_module(key)
        ctx.logger.debug(f"import as cpp {cls_name} success")
        factory_func = getattr(module, cls_name.lower())
        ctx.is_cpp_module = True
        return factory_func()
    except AttributeError as e:
        sys.modules.pop(key)
        ctx.logger.debug(f"fallback to python loader due to: {e}")
        ctx.path = os.path.join(os.path.dirname(path), key)
        setattr(ctx, cls_name.lower(), ctx.path)
        return cls(ctx)


def load_strategy_runner(ctx):
    if ctx.vendor is not None:
        module = importlib.import_module(ctx.vendor)
        runner_vendor = getattr(module, "Runner")
        return runner_vendor(
            ctx.locator,
            ctx.group,
            ctx.name,
            kfj.MODES[ctx.mode],
            ctx.low_latency,
            ctx.arguments,
        )
    else:
        return Runner(ctx)


def load_operator_runner(ctx):
    if ctx.vendor is not None:
        module = importlib.import_module(ctx.vendor)
        runner_vendor = getattr(module, "Runner")
        return runner_vendor(
            ctx.locator,
            ctx.group,
            ctx.name,
            kfj.MODES[ctx.mode],
            ctx.low_latency,
            ctx.arguments,
        )
    else:
        return OpRunner(ctx)


def load_td_vendor(ctx):
    td_vendor_builder = wc.TraderVendor
    if ctx.vendor is not None:
        module = importlib.import_module(ctx.vendor)
        td_vendor_builder = getattr(module, "TraderVendor")

    return td_vendor_builder(
        ctx.locator,
        ctx.group,
        ctx.name,
        kfj.MODES[ctx.mode],
        ctx.low_latency,
        ctx.arguments,
    )


def load_md_vendor(ctx):
    md_vendor_builder = wc.MarketDataVendor
    if ctx.vendor is not None:
        module = importlib.import_module(ctx.vendor)
        md_vendor_builder = getattr(module, "MarketDataVendor")

    return md_vendor_builder(
        ctx.locator,
        ctx.group,
        ctx.name,
        kfj.MODES[ctx.mode],
        ctx.low_latency,
        ctx.arguments,
    )


def load_service_vendor_builder(ctx):
    module = importlib.import_module(ctx.vendor or ctx.name)
    service_vendor_builder = getattr(module, "service")
    return service_vendor_builder


def parse_begin_end(ctx):
    ctx.logger.debug(f"ctx.mode: {ctx.mode}")

    if kfj.MODES[ctx.mode] == lf.enums.mode.BACKTEST and (not ctx.begin or not ctx.end):
        raise ValueError("backtest mode must specify begin and end")

    if kfj.MODES[ctx.mode] == lf.enums.mode.REPLAY and (
        not (ctx.begin and ctx.end) and not ctx.session_id
    ):
        raise ValueError("replay mode must specify begin and end or session_id")

    begin_time_stamp = (
        kft.strptimes(
            ctx.begin,
            (
                "%F %T",
                "%F %T.%N",
                "%Y%m%d",
                "%Y-%m-%d",
                "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%d %H:%M:%S.%f",
                "%Y-%m-%d %H:%M:%S.%N",
            ),
        )
        if ctx.begin
        else yjj.now_in_nano()
    )
    end_time_stamp = (
        kft.strptimes(
            ctx.end,
            (
                "%F %T",
                "%F %T.%N",
                "%Y%m%d",
                "%Y-%m-%d",
                "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%d %H:%M:%S.%f",
                "%Y-%m-%d %H:%M:%S.%N",
            ),
        )
        if ctx.end
        else yjj.now_in_nano()
    )
    end_time_stamp = min(yjj.now_in_nano(), end_time_stamp)

    if ctx.session_id:
        session = kfj.find_session(ctx, ctx.session_id)
        begin_time_stamp = session["begin_time"]
        end_time_stamp = session["end_time"] if session.closed else end_time_stamp

    ctx.logger.debug(
        f"begin time: {kft.strftime(begin_time_stamp)}, end_time_stamp: {kft.strftime(end_time_stamp)}"
    )
    return begin_time_stamp, end_time_stamp


def parse_from_to_indexer(ctx, begin, end):
    if ctx.from_indexer and not isinstance(ctx.from_indexer, wc.SliceIndexer):
        ctx.from_indexer = SliceIndexer(ctx, begin, end, ctx.from_indexer)
        # from_indexer = wc.DayIndexer(begin, end)
    if ctx.to_indexer and not isinstance(ctx.to_indexer, wc.SliceIndexer):
        ctx.to_indexer = SliceIndexer(ctx, begin, end, ctx.to_indexer)
    return ctx.from_indexer, ctx.to_indexer


def parse_backtest_config(ctx):
    if ctx.backtest is None:
        return "{}"
    backtest_config = ctx.backtest
    if os.path.exists(ctx.backtest):
        with open(ctx.backtest, "r") as f:
            backtest_config = f.read()
    # json format check.
    json.loads(backtest_config)
    return backtest_config
