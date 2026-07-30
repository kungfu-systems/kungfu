from __future__ import annotations
import pykungfu.yijinjing.types
__all__: list[str] = ['Config', 'OperatorStateUpdate', 'TimeKeyValue', 'TimeValue']
class Config:
    @property
    def data(self) -> pykungfu.yijinjing.types.Config:
        ...
    @property
    def source(self) -> int:
        ...
    @property
    def update_time(self) -> int:
        ...
class OperatorStateUpdate:
    @property
    def data(self) -> pykungfu.yijinjing.types.OperatorStateUpdate:
        ...
    @property
    def source(self) -> int:
        ...
    @property
    def update_time(self) -> int:
        ...
class TimeKeyValue:
    @property
    def data(self) -> pykungfu.yijinjing.types.TimeKeyValue:
        ...
    @property
    def source(self) -> int:
        ...
    @property
    def update_time(self) -> int:
        ...
class TimeValue:
    @property
    def data(self) -> pykungfu.yijinjing.types.TimeValue:
        ...
    @property
    def source(self) -> int:
        ...
    @property
    def update_time(self) -> int:
        ...
