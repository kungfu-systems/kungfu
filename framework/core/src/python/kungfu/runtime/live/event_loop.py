#  SPDX-License-Identifier: Apache-2.0

import asyncio
import heapq
import socket
import subprocess

from collections import deque


class LiveEventLoop(asyncio.AbstractEventLoop):
    def __init__(self, ctx, reactor):
        self._time = 0
        self._running = False
        self._immediate = deque()
        self._scheduled = []
        self._exception = None
        self._current = None
        self._ctx = ctx
        self._reactor = reactor
        self.home = self._reactor.home
        asyncio.set_event_loop(self)

    def get_debug(self):
        return False

    def time(self):
        return self._reactor.now()

    def get_home_uid(self):
        return self._reactor.get_home_uid()

    def get_home_uname(self):
        return self._reactor.get_home_uname()

    def get_begin_time(self):
        return self._reactor.get_begin_time()

    def get_end_time(self):
        return self._reactor.get_end_time()

    def pre_setup(self):
        self._reactor.pre_setup()

    def setup(self):
        self._reactor.setup()

    def post_step(self):
        ready = deque()
        while self._immediate:
            ready.append(self._immediate.popleft())

        if self._scheduled:
            scheduled = []
            while self._scheduled:
                handle = heapq.heappop(self._scheduled)
                if handle._when <= self._reactor.now():
                    handle._scheduled = False
                    ready.append(handle)
                else:
                    heapq.heappush(scheduled, handle)
            self._scheduled = scheduled

        # 一次性执行本轮就绪 handle。不再用单槽 self._current + 无条件重新入队:
        # asyncio Task/Future 自身通过 call_soon(-> self._immediate) 与 future done-callback
        # 安排续跑;事件循环重复入队已跑过的 handle 会与该自调度冲突,对已完成 Task 重复
        # __step 触发 InvalidStateError(见 tests/python/test_event_loop_concurrency.py)。
        while ready:
            handle = ready.popleft()
            if not handle._cancelled:
                handle._run()

        if self._exception is not None:
            raise self._exception

    def run(self, step_limit=0):
        self._running = True
        self._ctx.logger.info(
            "[{:08x}] {} running".format(
                self._reactor.home.uid, self._reactor.home.uname
            )
        )
        self.setup()
        while self.is_live():
            self.step()
            self.post_step()

        self.on_exit()
        self._ctx.logger.info(
            "[{:08x}] {} done".format(self._reactor.home.uid, self._reactor.home.uname)
        )

    def step(self, num=0):
        self._reactor.step(num)
        self.post_step()

    def on_exit(self):
        self._reactor.on_exit()

    def _timer_handle_cancelled(self, handle):
        pass

    def is_live(self):
        return self._reactor.live

    def is_running(self):
        return self._reactor.live

    def is_closed(self):
        return not self._reactor.live

    def stop(self):
        self._running = False

    def close(self):
        self._running = False

    def shutdown_asyncgens(self):
        pass

    def call_exception_handler(self, context):
        self._exception = context.get("exception", None)

    def call_soon(self, callback, *args, context=None):
        handle = asyncio.Handle(callback, args, self, context)
        self._immediate.append(handle)
        return handle

    def call_later(self, delay, callback, *args, context=None):
        if delay < 0:
            raise Exception("Can't schedule in the past")
        return self.call_at(
            self._reactor.now() + delay * int(1e9), callback, *args, context=context
        )

    def call_at(self, when, callback, *args, context=None):
        if when < self._reactor.now():
            raise Exception("Can't schedule in the past")
        handle = asyncio.TimerHandle(when, callback, args, self, context)
        heapq.heappush(self._scheduled, handle)
        handle._scheduled = True
        return handle

    def create_task(self, coro, *, name=None, context=None):
        async def wrapper():
            try:
                await coro
            except Exception as e:
                self._exception = e

        return asyncio.Task(wrapper(), loop=self, name=name, context=context)

    def create_future(self):
        return asyncio.Future(loop=self)

    def set_task_factory(self, factory):
        raise NotImplementedError

    def get_task_factory(self):
        raise NotImplementedError

    def call_soon_threadsafe(self, callback, *args):
        raise NotImplementedError

    def run_until_complete(self, future):
        raise NotImplementedError

    def set_default_executor(self, executor):
        raise NotImplementedError

    async def run_in_executor(self, executor, func, *args):
        raise NotImplementedError

    async def getaddrinfo(self, host, port, *, family=0, type=0, proto=0, flags=0):
        raise NotImplementedError

    async def getnameinfo(self, sockaddr, flags=0):
        raise NotImplementedError

    async def create_connection(
        self,
        protocol_factory,
        host=None,
        port=None,
        *,
        ssl=None,
        family=0,
        proto=0,
        flags=0,
        sock=None,
        local_addr=None,
        server_hostname=None,
        ssl_handshake_timeout=None,
        happy_eyeballs_delay=None,
        interleave=None,
    ):
        raise NotImplementedError

    async def create_server(
        self,
        protocol_factory,
        host=None,
        port=None,
        *,
        family=socket.AF_UNSPEC,
        flags=socket.AI_PASSIVE,
        sock=None,
        backlog=100,
        ssl=None,
        reuse_address=None,
        reuse_port=None,
        ssl_handshake_timeout=None,
        start_serving=True,
    ):
        raise NotImplementedError

    async def create_unix_connection(
        self,
        protocol_factory,
        path=None,
        *,
        ssl=None,
        sock=None,
        server_hostname=None,
        ssl_handshake_timeout=None,
    ):
        raise NotImplementedError

    async def create_unix_server(
        self,
        protocol_factory,
        path=None,
        *,
        sock=None,
        backlog=100,
        ssl=None,
        ssl_handshake_timeout=None,
        start_serving=True,
    ):
        raise NotImplementedError

    async def connect_accepted_socket(
        self, protocol_factory, sock, *, ssl=None, ssl_handshake_timeout=None
    ):
        raise NotImplementedError

    async def sendfile(self, transport, file, offset=0, count=None, *, fallback=True):
        raise NotImplementedError

    async def sock_sendfile(self, sock, file, offset=0, count=None, *, fallback=None):
        raise NotImplementedError

    async def start_tls(
        self,
        transport,
        protocol,
        sslcontext,
        *,
        server_side=False,
        server_hostname=None,
        ssl_handshake_timeout=None,
    ):
        raise NotImplementedError

    async def create_datagram_endpoint(
        self,
        protocol_factory,
        local_addr=None,
        remote_addr=None,
        *,
        family=0,
        proto=0,
        flags=0,
        reuse_address=None,
        reuse_port=None,
        allow_broadcast=None,
        sock=None,
    ):
        raise NotImplementedError

    async def connect_read_pipe(self, protocol_factory, pipe):
        raise NotImplementedError

    async def connect_write_pipe(self, protocol_factory, pipe):
        raise NotImplementedError

    async def subprocess_shell(
        self,
        protocol_factory,
        cmd,
        *,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        **kwargs,
    ):
        raise NotImplementedError

    async def subprocess_exec(
        self,
        protocol_factory,
        *args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        **kwargs,
    ):
        raise NotImplementedError

    def add_reader(self, fd, callback, *args):
        raise NotImplementedError

    def remove_reader(self, fd):
        raise NotImplementedError

    def add_writer(self, fd, callback, *args):
        raise NotImplementedError

    def remove_writer(self, fd):
        raise NotImplementedError

    async def sock_recv(self, sock, nbytes):
        raise NotImplementedError

    async def sock_recv_into(self, sock, buf):
        raise NotImplementedError

    async def sock_sendall(self, sock, data):
        raise NotImplementedError

    async def sock_connect(self, sock, address):
        raise NotImplementedError

    async def sock_accept(self, sock):
        raise NotImplementedError

    def add_signal_handler(self, sig, callback, *args):
        raise NotImplementedError

    def remove_signal_handler(self, sig):
        raise NotImplementedError

    def set_exception_handler(self, handler):
        raise NotImplementedError

    def get_exception_handler(self):
        raise NotImplementedError

    def default_exception_handler(self, context):
        raise NotImplementedError

    def set_debug(self, enabled: bool):
        raise NotImplementedError
