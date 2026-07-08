from __future__ import annotations
import pykungfu.longfist.types
__all__: list[str] = ['Config', 'OperatorStateUpdate', 'StrategyStateUpdate', 'TimeKeyValue', 'TimeValue']
class Config:
    @property
    def data(self) -> pykungfu.longfist.types.Config:
        ...
    @property
    def source(self) -> int:
        ...
    @property
    def update_time(self) -> int:
        ...
class OperatorStateUpdate:
    @property
    def data(self) -> pykungfu.longfist.types.OperatorStateUpdate:
        ...
    @property
    def source(self) -> int:
        ...
    @property
    def update_time(self) -> int:
        ...
class StrategyStateUpdate:
    @property
    def data(self) -> pykungfu.longfist.types.StrategyStateUpdate:
        ...
    @property
    def source(self) -> int:
        ...
    @property
    def update_time(self) -> int:
        ...
class TimeKeyValue:
    @property
    def data(self) -> pykungfu.longfist.types.TimeKeyValue:
        ...
    @property
    def source(self) -> int:
        ...
    @property
    def update_time(self) -> int:
        ...
class TimeValue:
    @property
    def data(self) -> pykungfu.longfist.types.TimeValue:
        ...
    @property
    def source(self) -> int:
        ...
    @property
    def update_time(self) -> int:
        ...
