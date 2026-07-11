"""LiveEventLoop(event_loop.py) 协程调度的可证伪测试 — 阶段0 测试网。

只测纯 Python 事件循环逻辑：按文件路径载入 event_loop.py，绕开 kungfu/__init__.py 的
`import pykungfu`(C++ 扩展)，用 FakeReactor 替身驱动事件循环，不依赖真实行情/网关/下单。

坐实 principal-engineer 评审发现的缺陷：

- P0  LiveEventLoop.post_step 用单槽 self._current + 无条件重新入队作为"协程是否结束"
      的标志位(event_loop.py:64-69)，配合 strategy.py __call_proxy 的 `await func; loop._current=None`
      (strategy.py:129-133)。多个并发 async 回调同时在飞时，单槽会被互相覆盖，导致部分协程
      丢失或被重复驱动。
- P2  定时器到期判断用严格小于 `handle._when < now()`(event_loop.py:57)：精确等于到期时间的
      定时器当轮不触发，回测离散时间下会延迟一个事件。
"""

import asyncio
import importlib.util
import pathlib

_EVENT_LOOP = (
    pathlib.Path(__file__).resolve().parents[2]
    / "src/python/kungfu/runtime/live/event_loop.py"
)


def _load():
    spec = importlib.util.spec_from_file_location(
        "kungfu_event_loop_under_test", _EVENT_LOOP
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


event_loop = _load()
LiveEventLoop = event_loop.LiveEventLoop


class _NullLogger:
    def __getattr__(self, _name):
        return lambda *a, **k: None


class FakeHome:
    uid = 0x12345678
    uname = "test.strategy"


class FakeReactor:
    """LiveEventLoop 需要的最小 C++ reactor/peer 接口替身。"""

    def __init__(self):
        self._now = 0
        self.live = True
        self.home = FakeHome()

    def now(self):
        return self._now

    def advance(self, ns):
        self._now += int(ns)

    def step(self, num=0):
        # 真实 reactor.step 会拉一轮 C++ 事件;测试里事件由 call_proxy 直接投递,这里留空。
        pass

    def pre_setup(self):
        pass

    def setup(self):
        pass

    def on_exit(self):
        pass

    def get_home_uid(self):
        return self.home.uid

    def get_home_uname(self):
        return self.home.uname

    def get_begin_time(self):
        return 0

    def get_end_time(self):
        return 0


class FakeCtx:
    def __init__(self):
        self.logger = _NullLogger()
        self.loop = None


def make_loop():
    reactor = FakeReactor()
    ctx = FakeCtx()
    loop = LiveEventLoop(ctx, reactor)
    ctx.loop = loop
    return loop, reactor, ctx


def call_proxy(loop, coro_func, *args):
    """复现 strategy.py __call_proxy 的协程回调投递路径:
        async wrap(): await func(...); loop._current = None  + asyncio.ensure_future
    这是 async 策略回调进入 LiveEventLoop 的真实路径。
    """

    async def wrap():
        await coro_func(*args)
        loop._current = None

    return asyncio.ensure_future(wrap(), loop=loop)


def drive(loop, max_rounds=100):
    """逐轮 post_step 推进(等价 run() 里反复 post_step),直到无待处理回调或达上限。

    返回实际轮数。达到 max_rounds 仍未排空 => 协程未收敛(疑似泄漏/忙轮询)。
    """
    rounds = 0
    while rounds < max_rounds:
        pending = bool(loop._immediate) or bool(loop._scheduled)
        loop.post_step()
        rounds += 1
        if not pending and not loop._immediate and not loop._scheduled:
            break
    return rounds


class WaitRounds:
    """await 它让出控制 n 次(bare yield),模拟需多轮事件循环推进才完成的协程等待。"""

    def __init__(self, n):
        self.n = n

    def __await__(self):
        for _ in range(self.n):
            yield


def test_single_async_callback_completes():
    """smoke:单个 async 回调应被驱动到完成恰好一次。"""
    loop, reactor, ctx = make_loop()
    done = []

    async def cb():
        await WaitRounds(2)
        done.append("cb")

    call_proxy(loop, cb)
    drive(loop)
    assert done == ["cb"], f"单协程未恰好完成一次: {done}"


def test_two_concurrent_async_callbacks_both_complete():
    """P0 复现:两个并发 async 回调(模拟两个 async on_quote 同时在飞)应各自恰好完成一次。

    单槽 _current + 无条件重新入队若有缺陷,会丢失或重复驱动其中一个。
    """
    loop, reactor, ctx = make_loop()
    done = []

    async def cb(tag):
        await WaitRounds(2)
        done.append(tag)

    call_proxy(loop, cb, "A")
    call_proxy(loop, cb, "B")
    rounds = drive(loop)
    assert sorted(done) == ["A", "B"], (
        f"并发协程未都恰好完成一次(rounds={rounds}): {done}"
    )


def test_timer_fires_at_exact_due_time():
    """P2 复现:call_at(when) 在 reactor.now()==when 那一刻应触发。

    event_loop.py:57 用 `handle._when < now()`(严格小于),到期时刻当轮不触发。
    """
    loop, reactor, ctx = make_loop()
    fired = []
    when = 1000
    loop.call_at(when, lambda: fired.append(reactor.now()))
    reactor._now = when  # 引擎时间恰好推进到到期时刻
    loop.post_step()
    assert fired == [when], (
        f"到期时刻定时器未触发(now={reactor.now()}, when={when}): {fired}"
    )


def test_pending_future_does_not_self_resolve():
    """P1 连带:新 event_loop 下 await 一个永不 set_result 的 future 会正确挂起,不靠忙轮询自动跑完。

    旧 post_step 靠'无条件重新入队'重复驱动协程,使 AsyncOrderAction 那种'永不完成 future +
    每轮重新轮询订单状态'的忙轮询得以推进。移除重排后该假设不再成立 => 依赖它的
    AsyncOrderAction 必须改成事件驱动 set_result(否则 await ctx.buy() 死锁)。
    """
    loop, reactor, ctx = make_loop()
    done = []

    async def cb():
        fut = loop.create_future()
        await fut  # 永不 set_result
        done.append("resolved")

    call_proxy(loop, cb)
    rounds = drive(loop, max_rounds=20)
    assert done == [], f"未完成 future 不应让协程跑完(忙轮询残留?): {done}"
    # drive 在无待处理回调时提前退出(rounds<20)=协程挂起在 future 上、事件循环无事可做。
    # 这正说明 AsyncOrderAction 的'永不完成 future'会让 await ctx.buy() 彻底挂死,
    # 必须改成 on_order 回调里 set_result 的事件驱动(见 test_future_resolves_when_set_result)。
    assert rounds < 20, f"应在无待处理回调时提前退出(挂起=预期),实际跑满 {rounds}"


def test_future_resolves_when_set_result():
    """P1 修复方向:future.set_result 后 await 它的协程应被唤醒续跑。

    这是 AsyncOrderAction 应改成的事件驱动模式(在 on_order/on_trade 回调里对订单终态 set_result),
    替代'永不完成 future + 外部重轮询'。本测试证明新 event_loop 支持该标准模式。
    """
    loop, reactor, ctx = make_loop()
    done = []
    holder = {}

    async def cb():
        fut = loop.create_future()
        holder["fut"] = fut
        result = await fut
        done.append(result)

    call_proxy(loop, cb)
    drive(loop, max_rounds=5)  # 推进到 await fut 挂起
    assert done == [], f"set_result 前不应完成: {done}"

    holder["fut"].set_result("filled")  # 模拟 on_order 回调里对终态订单 resolve
    drive(loop, max_rounds=5)
    assert done == ["filled"], f"set_result 后协程应续跑: {done}"


# --- 照搬 strategy.py AsyncOrderAction/Iter 真实逻辑(不 import strategy.py,避开 pykungfu) ---


class _ReplicaOrderActionIter:
    """照搬 strategy.py:317-331 AsyncOrderActionIter.__next__:future 永不 set_result,
    每次被迭代时重新轮询 book 里订单状态,终态才 StopIteration。"""

    def __init__(self, book, order_id, status_set, future):
        self.book = book
        self.order_id = order_id
        self.status_set = status_set
        self.future = future

    def __iter__(self):
        return self

    def __next__(self):
        if self.order_id in self.book:
            if self.book[self.order_id] in self.status_set:
                raise StopIteration
        return next(iter(self.future))


class _ReplicaOrderAction:
    """照搬 strategy.py:306-314 AsyncOrderAction。"""

    def __init__(self, loop, book, order_id, status_set):
        self.future = loop.create_future()
        self._it = _ReplicaOrderActionIter(book, order_id, status_set, self.future)

    def __await__(self):
        return self._it


def test_legacy_order_action_deadlocks_on_new_loop():
    """P1 坐实:旧 AsyncOrderAction(永不完成 future + 重轮询)在新 event_loop 下,即使订单成交也死锁。

    旧 post_step 的'无条件重新入队'被移除后,没有谁重新驱动协程去重轮询订单状态;而 future
    永不 set_result,Task 永久挂起。这证明 P0 修复必须配套把下单 await 改成事件驱动 set_result。
    """
    loop, reactor, ctx = make_loop()
    book = {}  # order_id -> status
    done = []

    async def cb():
        await _ReplicaOrderAction(loop, book, 1, {"Filled"})
        done.append("filled")

    call_proxy(loop, cb)
    drive(loop, max_rounds=10)
    assert done == [], "订单未终态,await 应挂起"

    book[1] = "Filled"  # 订单成交,但旧逻辑无事件回调去 set_result
    drive(loop, max_rounds=10)
    assert done == [], (
        f"旧 AsyncOrderAction 在新 event_loop 下:订单成交后 await 仍死锁(必须改 set_result): {done}"
    )
