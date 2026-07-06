from __future__ import annotations
import pykungfu.longfist.types
__all__: list[str] = ['Basket', 'BasketInstrument', 'Commission', 'Config', 'Instrument', 'OperatorStateUpdate', 'RiskSetting', 'StrategyStateUpdate', 'TimeKeyValue', 'TimeValue']
class Basket:
    @property
    def data(self) -> pykungfu.longfist.types.Basket:
        ...
    @property
    def source(self) -> int:
        ...
    @property
    def update_time(self) -> int:
        ...
class BasketInstrument:
    @property
    def data(self) -> pykungfu.longfist.types.BasketInstrument:
        ...
    @property
    def source(self) -> int:
        ...
    @property
    def update_time(self) -> int:
        ...
class Commission:
    @property
    def data(self) -> pykungfu.longfist.types.Commission:
        ...
    @property
    def source(self) -> int:
        ...
    @property
    def update_time(self) -> int:
        ...
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
class Instrument:
    @property
    def data(self) -> pykungfu.longfist.types.Instrument:
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
class RiskSetting:
    @property
    def data(self) -> pykungfu.longfist.types.RiskSetting:
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
