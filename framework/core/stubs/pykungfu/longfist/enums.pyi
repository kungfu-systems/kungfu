from __future__ import annotations
import typing
__all__: list[str] = ['Account', 'AccountType', 'AccountingMethodType', 'AlgoOrderActionFlag', 'All', 'Allow', 'Any', 'Arbitrage', 'AskPriceGreaterEqualStopPrice', 'AskPriceGreaterThanStopPrice', 'AskPriceLesserEqualStopPrice', 'AskPriceLesserThanStopPrice', 'AssembleMode', 'AtAuction', 'AtAuctionLimit', 'BACKTEST', 'BSE', 'BadDebtInterest', 'BasketType', 'BasketVolumeType', 'BidPriceGreaterEqualStopPrice', 'BidPriceGreaterThanStopPrice', 'BidPriceLesserEqualStopPrice', 'BidPriceLesserThanStopPrice', 'Bond', 'BrokerState', 'BsFlag', 'Buy', 'ByAmount', 'ByVolume', 'CEN', 'CFFEX', 'CNH', 'CNY', 'CZCE', 'Cancel', 'Cancelled', 'Cancelling', 'CapitalOccupationFee', 'CapitalRightsCompensation', 'CashBondETF', 'CashRepayMargin', 'CashReplaceFlag', 'Close', 'CloseOut', 'CloseOutFlag', 'CloseToday', 'CloseYesterday', 'CommissionRateMode', 'CommodityETF', 'Connected', 'Continuous', 'ContractType', 'Covered', 'CrdBuyContract', 'CrdBuyInterest', 'CrdSellContract', 'CrdSellFee', 'Credit', 'CrossCountryETF', 'CrossMarketETF', 'Crypto', 'CryptoFuture', 'CryptoUFuture', 'Currency', 'CurrencyETF', 'Custom', 'DATA', 'DCE', 'Default', 'Depth', 'Direction', 'DisConnected', 'Drop', 'ETF', 'ETFStatus', 'ETFType', 'EUR', 'EnReplace', 'EnhancedLimit', 'Entrust', 'Error', 'Exec', 'ExecType', 'Fak', 'FakBest5', 'Filled', 'Fok', 'Forbid', 'ForwardBest', 'FrameDataType', 'Fund', 'Future', 'FutureOption', 'GBP', 'GFA', 'GFD', 'GFS', 'GTC', 'GTD', 'GuaranteeStockBuy', 'GuaranteeStockSell', 'GuaranteeStockTransferIn', 'GuaranteeStockTransferOut', 'HKD', 'HKT', 'Hedge', 'HedgeFlag', 'High', 'HistoryDataType', 'INE', 'IOC', 'Idle', 'Immediately', 'Index', 'InitNotCloseOut', 'InstrumentType', 'Intraday', 'JOURNAL', 'JPY', 'Json', 'LIVE', 'LOG', 'Last', 'LastPriceGreaterEqualStopPrice', 'LastPriceGreaterThanStopPrice', 'LastPriceLesserEqualStopPrice', 'LastPriceLesserThanStopPrice', 'LedgerCategory', 'Limit', 'LocalETF', 'Lock', 'LoggedIn', 'LoginFailed', 'Long', 'Lost', 'Low', 'MD', 'MYR', 'ManagementFee', 'MarginTrade', 'MarketType', 'Medium', 'Merge', 'Min', 'MustReplace', 'NANOMSG', 'Normal', 'NotCloseOut', 'Now', 'OPERATOR', 'OTC', 'Offset', 'Open', 'OperatorState', 'Opposing1', 'Opposing2', 'Opposing3', 'Opposing4', 'Opposing5', 'OrderActionFlag', 'OrderStatus', 'OrderTriggerFlag', 'OrderTriggerType', 'OverdueInterest', 'Own1', 'Own2', 'Own3', 'Own4', 'Own5', 'PageEnd', 'PageStatus', 'ParkedOrder', 'PartialFilledActive', 'PartialFilledNotActive', 'Pending', 'PendingSettlement', 'PhysicalBondETF', 'PreOpen', 'PriceLevel', 'PriceType', 'Priority', 'Proportion', 'Purchase', 'PurchaseOnly', 'Quantity', 'REPLAY', 'Raw', 'Ready', 'Redemption', 'RedemptionOnly', 'RepayMargin', 'RepayStock', 'Repo', 'ResumePolicy', 'ReverseBest', 'SGD', 'SHFE', 'SQLITE', 'SSE', 'STRATEGY', 'SYSTEM', 'SZE', 'Sell', 'ShareRightsCompensation', 'Short', 'ShortSell', 'Side', 'Snapshot', 'Speculation', 'Split', 'Start', 'Stateless', 'Stock', 'StockOption', 'StockRepayStock', 'Stop', 'Strategy', 'StrategyState', 'Submitted', 'SubscribeDataType', 'SubscribeInstrumentType', 'SurplusStockTransfer', 'TD', 'TechStock', 'Tick', 'TimeCondition', 'TotalEnd', 'Touch', 'TouchProfit', 'Trade', 'Transaction', 'Tree', 'TriggerCancel', 'TriggerInsert', 'USD', 'UnHKMustReplace', 'UnHKReplace', 'UnReplace', 'UnSSEMustReplace', 'UnSSEReplace', 'UnSSESZEMustReplace', 'UnSSESZEReplace', 'Unknown', 'Unlock', 'UpperLimitPrice', 'VolumeCondition', 'Warn', 'category', 'get_category_by_name', 'get_category_name', 'get_layout_name', 'get_mode_by_name', 'get_mode_name', 'layout', 'lowerLimitPrice', 'mode']
class AccountType:
    """
    Members:
    
      Stock
    
      Credit
    
      Future
    """
    Credit: typing.ClassVar[AccountType]  # value = <AccountType.Credit: 1>
    Future: typing.ClassVar[AccountType]  # value = <AccountType.Future: 2>
    Stock: typing.ClassVar[AccountType]  # value = <AccountType.Stock: 0>
    __members__: typing.ClassVar[dict[str, AccountType]]  # value = {'Stock': <AccountType.Stock: 0>, 'Credit': <AccountType.Credit: 1>, 'Future': <AccountType.Future: 2>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class AccountingMethodType:
    """
    Members:
    
      Default
    
      OTC
    """
    Default: typing.ClassVar[AccountingMethodType]  # value = <AccountingMethodType.Default: 0>
    OTC: typing.ClassVar[AccountingMethodType]  # value = <AccountingMethodType.OTC: 1>
    __members__: typing.ClassVar[dict[str, AccountingMethodType]]  # value = {'Default': <AccountingMethodType.Default: 0>, 'OTC': <AccountingMethodType.OTC: 1>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class AlgoOrderActionFlag:
    """
    Members:
    
      Cancel
    
      Start
    
      Stop
    """
    Cancel: typing.ClassVar[AlgoOrderActionFlag]  # value = <AlgoOrderActionFlag.Cancel: 0>
    Start: typing.ClassVar[AlgoOrderActionFlag]  # value = <AlgoOrderActionFlag.Start: 1>
    Stop: typing.ClassVar[AlgoOrderActionFlag]  # value = <AlgoOrderActionFlag.Stop: 2>
    __members__: typing.ClassVar[dict[str, AlgoOrderActionFlag]]  # value = {'Cancel': <AlgoOrderActionFlag.Cancel: 0>, 'Start': <AlgoOrderActionFlag.Start: 1>, 'Stop': <AlgoOrderActionFlag.Stop: 2>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class AssembleMode:
    All: typing.ClassVar[int] = 32
    Channel: typing.ClassVar[int] = 1
    Public: typing.ClassVar[int] = 8
    Read: typing.ClassVar[int] = 4
    Sync: typing.ClassVar[int] = 16
    Write: typing.ClassVar[int] = 2
    def __init__(self) -> None:
        ...
class BasketType:
    """
    Members:
    
      Custom
    
      ETF
    """
    Custom: typing.ClassVar[BasketType]  # value = <BasketType.Custom: 0>
    ETF: typing.ClassVar[BasketType]  # value = <BasketType.ETF: 1>
    __members__: typing.ClassVar[dict[str, BasketType]]  # value = {'Custom': <BasketType.Custom: 0>, 'ETF': <BasketType.ETF: 1>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class BasketVolumeType:
    """
    Members:
    
      Unknown
    
      Quantity
    
      Proportion
    """
    Proportion: typing.ClassVar[BasketVolumeType]  # value = <BasketVolumeType.Proportion: 2>
    Quantity: typing.ClassVar[BasketVolumeType]  # value = <BasketVolumeType.Quantity: 1>
    Unknown: typing.ClassVar[BasketVolumeType]  # value = <BasketVolumeType.Unknown: 0>
    __members__: typing.ClassVar[dict[str, BasketVolumeType]]  # value = {'Unknown': <BasketVolumeType.Unknown: 0>, 'Quantity': <BasketVolumeType.Quantity: 1>, 'Proportion': <BasketVolumeType.Proportion: 2>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class BrokerState:
    """
    Members:
    
      Pending
    
      Idle
    
      DisConnected
    
      Connected
    
      LoggedIn
    
      LoginFailed
    
      Ready
    """
    Connected: typing.ClassVar[BrokerState]  # value = <BrokerState.Connected: 3>
    DisConnected: typing.ClassVar[BrokerState]  # value = <BrokerState.DisConnected: 2>
    Idle: typing.ClassVar[BrokerState]  # value = <BrokerState.Idle: 1>
    LoggedIn: typing.ClassVar[BrokerState]  # value = <BrokerState.LoggedIn: 4>
    LoginFailed: typing.ClassVar[BrokerState]  # value = <BrokerState.LoginFailed: 5>
    Pending: typing.ClassVar[BrokerState]  # value = <BrokerState.Pending: 0>
    Ready: typing.ClassVar[BrokerState]  # value = <BrokerState.Ready: 100>
    __members__: typing.ClassVar[dict[str, BrokerState]]  # value = {'Pending': <BrokerState.Pending: 0>, 'Idle': <BrokerState.Idle: 1>, 'DisConnected': <BrokerState.DisConnected: 2>, 'Connected': <BrokerState.Connected: 3>, 'LoggedIn': <BrokerState.LoggedIn: 4>, 'LoginFailed': <BrokerState.LoginFailed: 5>, 'Ready': <BrokerState.Ready: 100>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class BsFlag:
    """
    Members:
    
      Unknown
    
      Buy
    
      Sell
    """
    Buy: typing.ClassVar[BsFlag]  # value = <BsFlag.Buy: 1>
    Sell: typing.ClassVar[BsFlag]  # value = <BsFlag.Sell: 2>
    Unknown: typing.ClassVar[BsFlag]  # value = <BsFlag.Unknown: 0>
    __members__: typing.ClassVar[dict[str, BsFlag]]  # value = {'Unknown': <BsFlag.Unknown: 0>, 'Buy': <BsFlag.Buy: 1>, 'Sell': <BsFlag.Sell: 2>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class CashReplaceFlag:
    """
    Members:
    
      UnReplace
    
      EnReplace
    
      MustReplace
    
      UnSSEReplace
    
      UnSSEMustReplace
    
      UnSSESZEReplace
    
      UnSSESZEMustReplace
    
      UnHKReplace
    
      UnHKMustReplace
    
      Unknown
    """
    EnReplace: typing.ClassVar[CashReplaceFlag]  # value = <CashReplaceFlag.EnReplace: 1>
    MustReplace: typing.ClassVar[CashReplaceFlag]  # value = <CashReplaceFlag.MustReplace: 2>
    UnHKMustReplace: typing.ClassVar[CashReplaceFlag]  # value = <CashReplaceFlag.UnHKMustReplace: 8>
    UnHKReplace: typing.ClassVar[CashReplaceFlag]  # value = <CashReplaceFlag.UnHKReplace: 7>
    UnReplace: typing.ClassVar[CashReplaceFlag]  # value = <CashReplaceFlag.UnReplace: 0>
    UnSSEMustReplace: typing.ClassVar[CashReplaceFlag]  # value = <CashReplaceFlag.UnSSEMustReplace: 4>
    UnSSEReplace: typing.ClassVar[CashReplaceFlag]  # value = <CashReplaceFlag.UnSSEReplace: 3>
    UnSSESZEMustReplace: typing.ClassVar[CashReplaceFlag]  # value = <CashReplaceFlag.UnSSESZEMustReplace: 6>
    UnSSESZEReplace: typing.ClassVar[CashReplaceFlag]  # value = <CashReplaceFlag.UnSSESZEReplace: 5>
    Unknown: typing.ClassVar[CashReplaceFlag]  # value = <CashReplaceFlag.Unknown: 9>
    __members__: typing.ClassVar[dict[str, CashReplaceFlag]]  # value = {'UnReplace': <CashReplaceFlag.UnReplace: 0>, 'EnReplace': <CashReplaceFlag.EnReplace: 1>, 'MustReplace': <CashReplaceFlag.MustReplace: 2>, 'UnSSEReplace': <CashReplaceFlag.UnSSEReplace: 3>, 'UnSSEMustReplace': <CashReplaceFlag.UnSSEMustReplace: 4>, 'UnSSESZEReplace': <CashReplaceFlag.UnSSESZEReplace: 5>, 'UnSSESZEMustReplace': <CashReplaceFlag.UnSSESZEMustReplace: 6>, 'UnHKReplace': <CashReplaceFlag.UnHKReplace: 7>, 'UnHKMustReplace': <CashReplaceFlag.UnHKMustReplace: 8>, 'Unknown': <CashReplaceFlag.Unknown: 9>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class CloseOutFlag:
    """
    Members:
    
      NotCloseOut
    
      CloseOut
    
      InitNotCloseOut
    """
    CloseOut: typing.ClassVar[CloseOutFlag]  # value = <CloseOutFlag.CloseOut: 1>
    InitNotCloseOut: typing.ClassVar[CloseOutFlag]  # value = <CloseOutFlag.InitNotCloseOut: 2>
    NotCloseOut: typing.ClassVar[CloseOutFlag]  # value = <CloseOutFlag.NotCloseOut: 0>
    __members__: typing.ClassVar[dict[str, CloseOutFlag]]  # value = {'NotCloseOut': <CloseOutFlag.NotCloseOut: 0>, 'CloseOut': <CloseOutFlag.CloseOut: 1>, 'InitNotCloseOut': <CloseOutFlag.InitNotCloseOut: 2>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class CommissionRateMode:
    """
    Members:
    
      ByAmount
    
      ByVolume
    """
    ByAmount: typing.ClassVar[CommissionRateMode]  # value = <CommissionRateMode.ByAmount: 0>
    ByVolume: typing.ClassVar[CommissionRateMode]  # value = <CommissionRateMode.ByVolume: 1>
    __members__: typing.ClassVar[dict[str, CommissionRateMode]]  # value = {'ByAmount': <CommissionRateMode.ByAmount: 0>, 'ByVolume': <CommissionRateMode.ByVolume: 1>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class ContractType:
    """
    Members:
    
      CrdBuyContract
    
      CrdSellContract
    
      CrdBuyInterest
    
      CrdSellFee
    
      CapitalRightsCompensation
    
      ShareRightsCompensation
    
      OverdueInterest
    
      BadDebtInterest
    
      CapitalOccupationFee
    
      ManagementFee
    """
    BadDebtInterest: typing.ClassVar[ContractType]  # value = <ContractType.BadDebtInterest: 7>
    CapitalOccupationFee: typing.ClassVar[ContractType]  # value = <ContractType.CapitalOccupationFee: 8>
    CapitalRightsCompensation: typing.ClassVar[ContractType]  # value = <ContractType.CapitalRightsCompensation: 4>
    CrdBuyContract: typing.ClassVar[ContractType]  # value = <ContractType.CrdBuyContract: 0>
    CrdBuyInterest: typing.ClassVar[ContractType]  # value = <ContractType.CrdBuyInterest: 2>
    CrdSellContract: typing.ClassVar[ContractType]  # value = <ContractType.CrdSellContract: 1>
    CrdSellFee: typing.ClassVar[ContractType]  # value = <ContractType.CrdSellFee: 3>
    ManagementFee: typing.ClassVar[ContractType]  # value = <ContractType.ManagementFee: 9>
    OverdueInterest: typing.ClassVar[ContractType]  # value = <ContractType.OverdueInterest: 6>
    ShareRightsCompensation: typing.ClassVar[ContractType]  # value = <ContractType.ShareRightsCompensation: 5>
    __members__: typing.ClassVar[dict[str, ContractType]]  # value = {'CrdBuyContract': <ContractType.CrdBuyContract: 0>, 'CrdSellContract': <ContractType.CrdSellContract: 1>, 'CrdBuyInterest': <ContractType.CrdBuyInterest: 2>, 'CrdSellFee': <ContractType.CrdSellFee: 3>, 'CapitalRightsCompensation': <ContractType.CapitalRightsCompensation: 4>, 'ShareRightsCompensation': <ContractType.ShareRightsCompensation: 5>, 'OverdueInterest': <ContractType.OverdueInterest: 6>, 'BadDebtInterest': <ContractType.BadDebtInterest: 7>, 'CapitalOccupationFee': <ContractType.CapitalOccupationFee: 8>, 'ManagementFee': <ContractType.ManagementFee: 9>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class Currency:
    """
    Members:
    
      Unknown
    
      CNY
    
      HKD
    
      USD
    
      JPY
    
      GBP
    
      EUR
    
      CNH
    
      SGD
    
      MYR
    
      CEN
    """
    CEN: typing.ClassVar[Currency]  # value = <Currency.CEN: 10>
    CNH: typing.ClassVar[Currency]  # value = <Currency.CNH: 7>
    CNY: typing.ClassVar[Currency]  # value = <Currency.CNY: 1>
    EUR: typing.ClassVar[Currency]  # value = <Currency.EUR: 6>
    GBP: typing.ClassVar[Currency]  # value = <Currency.GBP: 5>
    HKD: typing.ClassVar[Currency]  # value = <Currency.HKD: 2>
    JPY: typing.ClassVar[Currency]  # value = <Currency.JPY: 4>
    MYR: typing.ClassVar[Currency]  # value = <Currency.MYR: 9>
    SGD: typing.ClassVar[Currency]  # value = <Currency.SGD: 8>
    USD: typing.ClassVar[Currency]  # value = <Currency.USD: 3>
    Unknown: typing.ClassVar[Currency]  # value = <Currency.Unknown: 0>
    __members__: typing.ClassVar[dict[str, Currency]]  # value = {'Unknown': <Currency.Unknown: 0>, 'CNY': <Currency.CNY: 1>, 'HKD': <Currency.HKD: 2>, 'USD': <Currency.USD: 3>, 'JPY': <Currency.JPY: 4>, 'GBP': <Currency.GBP: 5>, 'EUR': <Currency.EUR: 6>, 'CNH': <Currency.CNH: 7>, 'SGD': <Currency.SGD: 8>, 'MYR': <Currency.MYR: 9>, 'CEN': <Currency.CEN: 10>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class Direction:
    """
    Members:
    
      Long
    
      Short
    """
    Long: typing.ClassVar[Direction]  # value = <Direction.Long: 0>
    Short: typing.ClassVar[Direction]  # value = <Direction.Short: 1>
    __members__: typing.ClassVar[dict[str, Direction]]  # value = {'Long': <Direction.Long: 0>, 'Short': <Direction.Short: 1>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class ETFStatus:
    """
    Members:
    
      Forbid
    
      Allow
    
      PurchaseOnly
    
      RedemptionOnly
    
      Unknown
    """
    Allow: typing.ClassVar[ETFStatus]  # value = <ETFStatus.Allow: 1>
    Forbid: typing.ClassVar[ETFStatus]  # value = <ETFStatus.Forbid: 0>
    PurchaseOnly: typing.ClassVar[ETFStatus]  # value = <ETFStatus.PurchaseOnly: 2>
    RedemptionOnly: typing.ClassVar[ETFStatus]  # value = <ETFStatus.RedemptionOnly: 3>
    Unknown: typing.ClassVar[ETFStatus]  # value = <ETFStatus.Unknown: 4>
    __members__: typing.ClassVar[dict[str, ETFStatus]]  # value = {'Forbid': <ETFStatus.Forbid: 0>, 'Allow': <ETFStatus.Allow: 1>, 'PurchaseOnly': <ETFStatus.PurchaseOnly: 2>, 'RedemptionOnly': <ETFStatus.RedemptionOnly: 3>, 'Unknown': <ETFStatus.Unknown: 4>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class ETFType:
    """
    Members:
    
      LocalETF
    
      CrossCountryETF
    
      CrossMarketETF
    
      CurrencyETF
    
      PhysicalBondETF
    
      CommodityETF
    
      CashBondETF
    
      Unknown
    """
    CashBondETF: typing.ClassVar[ETFType]  # value = <ETFType.CashBondETF: 6>
    CommodityETF: typing.ClassVar[ETFType]  # value = <ETFType.CommodityETF: 5>
    CrossCountryETF: typing.ClassVar[ETFType]  # value = <ETFType.CrossCountryETF: 1>
    CrossMarketETF: typing.ClassVar[ETFType]  # value = <ETFType.CrossMarketETF: 2>
    CurrencyETF: typing.ClassVar[ETFType]  # value = <ETFType.CurrencyETF: 3>
    LocalETF: typing.ClassVar[ETFType]  # value = <ETFType.LocalETF: 0>
    PhysicalBondETF: typing.ClassVar[ETFType]  # value = <ETFType.PhysicalBondETF: 4>
    Unknown: typing.ClassVar[ETFType]  # value = <ETFType.Unknown: 7>
    __members__: typing.ClassVar[dict[str, ETFType]]  # value = {'LocalETF': <ETFType.LocalETF: 0>, 'CrossCountryETF': <ETFType.CrossCountryETF: 1>, 'CrossMarketETF': <ETFType.CrossMarketETF: 2>, 'CurrencyETF': <ETFType.CurrencyETF: 3>, 'PhysicalBondETF': <ETFType.PhysicalBondETF: 4>, 'CommodityETF': <ETFType.CommodityETF: 5>, 'CashBondETF': <ETFType.CashBondETF: 6>, 'Unknown': <ETFType.Unknown: 7>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class ExecType:
    """
    Members:
    
      Unknown
    
      Cancel
    
      Trade
    """
    Cancel: typing.ClassVar[ExecType]  # value = <ExecType.Cancel: 1>
    Trade: typing.ClassVar[ExecType]  # value = <ExecType.Trade: 2>
    Unknown: typing.ClassVar[ExecType]  # value = <ExecType.Unknown: 0>
    __members__: typing.ClassVar[dict[str, ExecType]]  # value = {'Unknown': <ExecType.Unknown: 0>, 'Cancel': <ExecType.Cancel: 1>, 'Trade': <ExecType.Trade: 2>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class FrameDataType:
    """
    Members:
    
      Raw
    
      Json
    
      Unknown
    """
    Json: typing.ClassVar[FrameDataType]  # value = <FrameDataType.Json: 1>
    Raw: typing.ClassVar[FrameDataType]  # value = <FrameDataType.Raw: 0>
    Unknown: typing.ClassVar[FrameDataType]  # value = <FrameDataType.Unknown: 2>
    __members__: typing.ClassVar[dict[str, FrameDataType]]  # value = {'Raw': <FrameDataType.Raw: 0>, 'Json': <FrameDataType.Json: 1>, 'Unknown': <FrameDataType.Unknown: 2>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class HedgeFlag:
    """
    Members:
    
      Speculation
    
      Arbitrage
    
      Hedge
    
      Covered
    """
    Arbitrage: typing.ClassVar[HedgeFlag]  # value = <HedgeFlag.Arbitrage: 1>
    Covered: typing.ClassVar[HedgeFlag]  # value = <HedgeFlag.Covered: 3>
    Hedge: typing.ClassVar[HedgeFlag]  # value = <HedgeFlag.Hedge: 2>
    Speculation: typing.ClassVar[HedgeFlag]  # value = <HedgeFlag.Speculation: 0>
    __members__: typing.ClassVar[dict[str, HedgeFlag]]  # value = {'Speculation': <HedgeFlag.Speculation: 0>, 'Arbitrage': <HedgeFlag.Arbitrage: 1>, 'Hedge': <HedgeFlag.Hedge: 2>, 'Covered': <HedgeFlag.Covered: 3>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class HistoryDataType:
    """
    Members:
    
      Normal
    
      PageEnd
    
      TotalEnd
    """
    Normal: typing.ClassVar[HistoryDataType]  # value = <HistoryDataType.Normal: 0>
    PageEnd: typing.ClassVar[HistoryDataType]  # value = <HistoryDataType.PageEnd: 1>
    TotalEnd: typing.ClassVar[HistoryDataType]  # value = <HistoryDataType.TotalEnd: 2>
    __members__: typing.ClassVar[dict[str, HistoryDataType]]  # value = {'Normal': <HistoryDataType.Normal: 0>, 'PageEnd': <HistoryDataType.PageEnd: 1>, 'TotalEnd': <HistoryDataType.TotalEnd: 2>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class InstrumentType:
    """
    Members:
    
      Unknown
    
      Stock
    
      Future
    
      Bond
    
      StockOption
    
      TechStock
    
      Fund
    
      Index
    
      Repo
    
      Crypto
    
      CryptoFuture
    
      CryptoUFuture
    """
    Bond: typing.ClassVar[InstrumentType]  # value = <InstrumentType.Bond: 5>
    Crypto: typing.ClassVar[InstrumentType]  # value = <InstrumentType.Crypto: 9>
    CryptoFuture: typing.ClassVar[InstrumentType]  # value = <InstrumentType.CryptoFuture: 10>
    CryptoUFuture: typing.ClassVar[InstrumentType]  # value = <InstrumentType.CryptoUFuture: 11>
    Fund: typing.ClassVar[InstrumentType]  # value = <InstrumentType.Fund: 6>
    Future: typing.ClassVar[InstrumentType]  # value = <InstrumentType.Future: 4>
    Index: typing.ClassVar[InstrumentType]  # value = <InstrumentType.Index: 7>
    Repo: typing.ClassVar[InstrumentType]  # value = <InstrumentType.Repo: 8>
    Stock: typing.ClassVar[InstrumentType]  # value = <InstrumentType.Stock: 1>
    StockOption: typing.ClassVar[InstrumentType]  # value = <InstrumentType.StockOption: 2>
    TechStock: typing.ClassVar[InstrumentType]  # value = <InstrumentType.TechStock: 3>
    Unknown: typing.ClassVar[InstrumentType]  # value = <InstrumentType.Unknown: 0>
    __members__: typing.ClassVar[dict[str, InstrumentType]]  # value = {'Unknown': <InstrumentType.Unknown: 0>, 'Stock': <InstrumentType.Stock: 1>, 'Future': <InstrumentType.Future: 4>, 'Bond': <InstrumentType.Bond: 5>, 'StockOption': <InstrumentType.StockOption: 2>, 'TechStock': <InstrumentType.TechStock: 3>, 'Fund': <InstrumentType.Fund: 6>, 'Index': <InstrumentType.Index: 7>, 'Repo': <InstrumentType.Repo: 8>, 'Crypto': <InstrumentType.Crypto: 9>, 'CryptoFuture': <InstrumentType.CryptoFuture: 10>, 'CryptoUFuture': <InstrumentType.CryptoUFuture: 11>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class LedgerCategory:
    """
    Members:
    
      Account
    
      Strategy
    """
    Account: typing.ClassVar[LedgerCategory]  # value = <LedgerCategory.Account: 0>
    Strategy: typing.ClassVar[LedgerCategory]  # value = <LedgerCategory.Strategy: 1>
    __members__: typing.ClassVar[dict[str, LedgerCategory]]  # value = {'Account': <LedgerCategory.Account: 0>, 'Strategy': <LedgerCategory.Strategy: 1>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class MarketType:
    """
    Members:
    
      All
    
      BSE
    
      SHFE
    
      CFFEX
    
      DCE
    
      CZCE
    
      INE
    
      SSE
    
      SZE
    """
    All: typing.ClassVar[MarketType]  # value = <MarketType.All: 0>
    BSE: typing.ClassVar[MarketType]  # value = <MarketType.BSE: 1>
    CFFEX: typing.ClassVar[MarketType]  # value = <MarketType.CFFEX: 3>
    CZCE: typing.ClassVar[MarketType]  # value = <MarketType.CZCE: 5>
    DCE: typing.ClassVar[MarketType]  # value = <MarketType.DCE: 4>
    INE: typing.ClassVar[MarketType]  # value = <MarketType.INE: 6>
    SHFE: typing.ClassVar[MarketType]  # value = <MarketType.SHFE: 2>
    SSE: typing.ClassVar[MarketType]  # value = <MarketType.SSE: 7>
    SZE: typing.ClassVar[MarketType]  # value = <MarketType.SZE: 8>
    __members__: typing.ClassVar[dict[str, MarketType]]  # value = {'All': <MarketType.All: 0>, 'BSE': <MarketType.BSE: 1>, 'SHFE': <MarketType.SHFE: 2>, 'CFFEX': <MarketType.CFFEX: 3>, 'DCE': <MarketType.DCE: 4>, 'CZCE': <MarketType.CZCE: 5>, 'INE': <MarketType.INE: 6>, 'SSE': <MarketType.SSE: 7>, 'SZE': <MarketType.SZE: 8>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class Offset:
    """
    Members:
    
      Open
    
      Close
    
      CloseToday
    
      CloseYesterday
    """
    Close: typing.ClassVar[Offset]  # value = <Offset.Close: 1>
    CloseToday: typing.ClassVar[Offset]  # value = <Offset.CloseToday: 2>
    CloseYesterday: typing.ClassVar[Offset]  # value = <Offset.CloseYesterday: 3>
    Open: typing.ClassVar[Offset]  # value = <Offset.Open: 0>
    __members__: typing.ClassVar[dict[str, Offset]]  # value = {'Open': <Offset.Open: 0>, 'Close': <Offset.Close: 1>, 'CloseToday': <Offset.CloseToday: 2>, 'CloseYesterday': <Offset.CloseYesterday: 3>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class OperatorState:
    """
    Members:
    
      Pending
    
      DisConnected
    
      Connected
    
      Ready
    """
    Connected: typing.ClassVar[OperatorState]  # value = <OperatorState.Connected: 3>
    DisConnected: typing.ClassVar[OperatorState]  # value = <OperatorState.DisConnected: 2>
    Pending: typing.ClassVar[OperatorState]  # value = <OperatorState.Pending: 0>
    Ready: typing.ClassVar[OperatorState]  # value = <OperatorState.Ready: 100>
    __members__: typing.ClassVar[dict[str, OperatorState]]  # value = {'Pending': <OperatorState.Pending: 0>, 'DisConnected': <OperatorState.DisConnected: 2>, 'Connected': <OperatorState.Connected: 3>, 'Ready': <OperatorState.Ready: 100>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class OrderActionFlag:
    """
    Members:
    
      Cancel
    
      TriggerCancel
    """
    Cancel: typing.ClassVar[OrderActionFlag]  # value = <OrderActionFlag.Cancel: 0>
    TriggerCancel: typing.ClassVar[OrderActionFlag]  # value = <OrderActionFlag.TriggerCancel: 1>
    __members__: typing.ClassVar[dict[str, OrderActionFlag]]  # value = {'Cancel': <OrderActionFlag.Cancel: 0>, 'TriggerCancel': <OrderActionFlag.TriggerCancel: 1>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class OrderStatus:
    """
    Members:
    
      Unknown
    
      Submitted
    
      Pending
    
      Cancelled
    
      Error
    
      Filled
    
      PartialFilledNotActive
    
      PartialFilledActive
    
      Lost
    
      Cancelling
    
      PendingSettlement
    """
    Cancelled: typing.ClassVar[OrderStatus]  # value = <OrderStatus.Cancelled: 3>
    Cancelling: typing.ClassVar[OrderStatus]  # value = <OrderStatus.Cancelling: 9>
    Error: typing.ClassVar[OrderStatus]  # value = <OrderStatus.Error: 4>
    Filled: typing.ClassVar[OrderStatus]  # value = <OrderStatus.Filled: 5>
    Lost: typing.ClassVar[OrderStatus]  # value = <OrderStatus.Lost: 8>
    PartialFilledActive: typing.ClassVar[OrderStatus]  # value = <OrderStatus.PartialFilledActive: 7>
    PartialFilledNotActive: typing.ClassVar[OrderStatus]  # value = <OrderStatus.PartialFilledNotActive: 6>
    Pending: typing.ClassVar[OrderStatus]  # value = <OrderStatus.Pending: 2>
    PendingSettlement: typing.ClassVar[OrderStatus]  # value = <OrderStatus.PendingSettlement: 11>
    Submitted: typing.ClassVar[OrderStatus]  # value = <OrderStatus.Submitted: 1>
    Unknown: typing.ClassVar[OrderStatus]  # value = <OrderStatus.Unknown: 0>
    __members__: typing.ClassVar[dict[str, OrderStatus]]  # value = {'Unknown': <OrderStatus.Unknown: 0>, 'Submitted': <OrderStatus.Submitted: 1>, 'Pending': <OrderStatus.Pending: 2>, 'Cancelled': <OrderStatus.Cancelled: 3>, 'Error': <OrderStatus.Error: 4>, 'Filled': <OrderStatus.Filled: 5>, 'PartialFilledNotActive': <OrderStatus.PartialFilledNotActive: 6>, 'PartialFilledActive': <OrderStatus.PartialFilledActive: 7>, 'Lost': <OrderStatus.Lost: 8>, 'Cancelling': <OrderStatus.Cancelling: 9>, 'PendingSettlement': <OrderStatus.PendingSettlement: 11>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class OrderTriggerFlag:
    """
    Members:
    
      TriggerInsert
    
      TriggerCancel
    """
    TriggerCancel: typing.ClassVar[OrderTriggerFlag]  # value = <OrderTriggerFlag.TriggerCancel: 1>
    TriggerInsert: typing.ClassVar[OrderTriggerFlag]  # value = <OrderTriggerFlag.TriggerInsert: 0>
    __members__: typing.ClassVar[dict[str, OrderTriggerFlag]]  # value = {'TriggerInsert': <OrderTriggerFlag.TriggerInsert: 0>, 'TriggerCancel': <OrderTriggerFlag.TriggerCancel: 1>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class OrderTriggerType:
    """
    Members:
    
      Immediately
    
      Touch
    
      TouchProfit
    
      ParkedOrder
    
      LastPriceGreaterThanStopPrice
    
      LastPriceGreaterEqualStopPrice
    
      LastPriceLesserThanStopPrice
    
      LastPriceLesserEqualStopPrice
    
      AskPriceGreaterThanStopPrice
    
      AskPriceGreaterEqualStopPrice
    
      AskPriceLesserThanStopPrice
    
      AskPriceLesserEqualStopPrice
    
      BidPriceGreaterThanStopPrice
    
      BidPriceGreaterEqualStopPrice
    
      BidPriceLesserThanStopPrice
    
      BidPriceLesserEqualStopPrice
    """
    AskPriceGreaterEqualStopPrice: typing.ClassVar[OrderTriggerType]  # value = <OrderTriggerType.AskPriceGreaterEqualStopPrice: 9>
    AskPriceGreaterThanStopPrice: typing.ClassVar[OrderTriggerType]  # value = <OrderTriggerType.AskPriceGreaterThanStopPrice: 8>
    AskPriceLesserEqualStopPrice: typing.ClassVar[OrderTriggerType]  # value = <OrderTriggerType.AskPriceLesserEqualStopPrice: 11>
    AskPriceLesserThanStopPrice: typing.ClassVar[OrderTriggerType]  # value = <OrderTriggerType.AskPriceLesserThanStopPrice: 10>
    BidPriceGreaterEqualStopPrice: typing.ClassVar[OrderTriggerType]  # value = <OrderTriggerType.BidPriceGreaterEqualStopPrice: 13>
    BidPriceGreaterThanStopPrice: typing.ClassVar[OrderTriggerType]  # value = <OrderTriggerType.BidPriceGreaterThanStopPrice: 12>
    BidPriceLesserEqualStopPrice: typing.ClassVar[OrderTriggerType]  # value = <OrderTriggerType.BidPriceLesserEqualStopPrice: 15>
    BidPriceLesserThanStopPrice: typing.ClassVar[OrderTriggerType]  # value = <OrderTriggerType.BidPriceLesserThanStopPrice: 14>
    Immediately: typing.ClassVar[OrderTriggerType]  # value = <OrderTriggerType.Immediately: 0>
    LastPriceGreaterEqualStopPrice: typing.ClassVar[OrderTriggerType]  # value = <OrderTriggerType.LastPriceGreaterEqualStopPrice: 5>
    LastPriceGreaterThanStopPrice: typing.ClassVar[OrderTriggerType]  # value = <OrderTriggerType.LastPriceGreaterThanStopPrice: 4>
    LastPriceLesserEqualStopPrice: typing.ClassVar[OrderTriggerType]  # value = <OrderTriggerType.LastPriceLesserEqualStopPrice: 7>
    LastPriceLesserThanStopPrice: typing.ClassVar[OrderTriggerType]  # value = <OrderTriggerType.LastPriceLesserThanStopPrice: 6>
    ParkedOrder: typing.ClassVar[OrderTriggerType]  # value = <OrderTriggerType.ParkedOrder: 3>
    Touch: typing.ClassVar[OrderTriggerType]  # value = <OrderTriggerType.Touch: 1>
    TouchProfit: typing.ClassVar[OrderTriggerType]  # value = <OrderTriggerType.TouchProfit: 2>
    __members__: typing.ClassVar[dict[str, OrderTriggerType]]  # value = {'Immediately': <OrderTriggerType.Immediately: 0>, 'Touch': <OrderTriggerType.Touch: 1>, 'TouchProfit': <OrderTriggerType.TouchProfit: 2>, 'ParkedOrder': <OrderTriggerType.ParkedOrder: 3>, 'LastPriceGreaterThanStopPrice': <OrderTriggerType.LastPriceGreaterThanStopPrice: 4>, 'LastPriceGreaterEqualStopPrice': <OrderTriggerType.LastPriceGreaterEqualStopPrice: 5>, 'LastPriceLesserThanStopPrice': <OrderTriggerType.LastPriceLesserThanStopPrice: 6>, 'LastPriceLesserEqualStopPrice': <OrderTriggerType.LastPriceLesserEqualStopPrice: 7>, 'AskPriceGreaterThanStopPrice': <OrderTriggerType.AskPriceGreaterThanStopPrice: 8>, 'AskPriceGreaterEqualStopPrice': <OrderTriggerType.AskPriceGreaterEqualStopPrice: 9>, 'AskPriceLesserThanStopPrice': <OrderTriggerType.AskPriceLesserThanStopPrice: 10>, 'AskPriceLesserEqualStopPrice': <OrderTriggerType.AskPriceLesserEqualStopPrice: 11>, 'BidPriceGreaterThanStopPrice': <OrderTriggerType.BidPriceGreaterThanStopPrice: 12>, 'BidPriceGreaterEqualStopPrice': <OrderTriggerType.BidPriceGreaterEqualStopPrice: 13>, 'BidPriceLesserThanStopPrice': <OrderTriggerType.BidPriceLesserThanStopPrice: 14>, 'BidPriceLesserEqualStopPrice': <OrderTriggerType.BidPriceLesserEqualStopPrice: 15>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class PageStatus:
    """
    Members:
    
      Normal
    
      PreOpen
    """
    Normal: typing.ClassVar[PageStatus]  # value = <PageStatus.Normal: 0>
    PreOpen: typing.ClassVar[PageStatus]  # value = <PageStatus.PreOpen: 1>
    __members__: typing.ClassVar[dict[str, PageStatus]]  # value = {'Normal': <PageStatus.Normal: 0>, 'PreOpen': <PageStatus.PreOpen: 1>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class PriceLevel:
    """
    Members:
    
      Last
    
      Opposing5
    
      Opposing4
    
      Opposing3
    
      Opposing2
    
      Opposing1
    
      Own1
    
      Own2
    
      Own3
    
      Own4
    
      Own5
    
      UpperLimitPrice
    
      lowerLimitPrice
    
      Unknown
    """
    Last: typing.ClassVar[PriceLevel]  # value = <PriceLevel.Last: 0>
    Opposing1: typing.ClassVar[PriceLevel]  # value = <PriceLevel.Opposing1: 5>
    Opposing2: typing.ClassVar[PriceLevel]  # value = <PriceLevel.Opposing2: 4>
    Opposing3: typing.ClassVar[PriceLevel]  # value = <PriceLevel.Opposing3: 3>
    Opposing4: typing.ClassVar[PriceLevel]  # value = <PriceLevel.Opposing4: 2>
    Opposing5: typing.ClassVar[PriceLevel]  # value = <PriceLevel.Opposing5: 1>
    Own1: typing.ClassVar[PriceLevel]  # value = <PriceLevel.Own1: 6>
    Own2: typing.ClassVar[PriceLevel]  # value = <PriceLevel.Own2: 7>
    Own3: typing.ClassVar[PriceLevel]  # value = <PriceLevel.Own3: 8>
    Own4: typing.ClassVar[PriceLevel]  # value = <PriceLevel.Own4: 9>
    Own5: typing.ClassVar[PriceLevel]  # value = <PriceLevel.Own5: 10>
    Unknown: typing.ClassVar[PriceLevel]  # value = <PriceLevel.Unknown: 13>
    UpperLimitPrice: typing.ClassVar[PriceLevel]  # value = <PriceLevel.UpperLimitPrice: 11>
    __members__: typing.ClassVar[dict[str, PriceLevel]]  # value = {'Last': <PriceLevel.Last: 0>, 'Opposing5': <PriceLevel.Opposing5: 1>, 'Opposing4': <PriceLevel.Opposing4: 2>, 'Opposing3': <PriceLevel.Opposing3: 3>, 'Opposing2': <PriceLevel.Opposing2: 4>, 'Opposing1': <PriceLevel.Opposing1: 5>, 'Own1': <PriceLevel.Own1: 6>, 'Own2': <PriceLevel.Own2: 7>, 'Own3': <PriceLevel.Own3: 8>, 'Own4': <PriceLevel.Own4: 9>, 'Own5': <PriceLevel.Own5: 10>, 'UpperLimitPrice': <PriceLevel.UpperLimitPrice: 11>, 'lowerLimitPrice': <PriceLevel.lowerLimitPrice: 12>, 'Unknown': <PriceLevel.Unknown: 13>}
    lowerLimitPrice: typing.ClassVar[PriceLevel]  # value = <PriceLevel.lowerLimitPrice: 12>
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self: Direction, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class PriceType:
    """
    Members:
    
      Any
    
      FakBest5
    
      Fak
    
      Fok
    
      Limit
    
      ForwardBest
    
      ReverseBest
    
      EnhancedLimit
    
      AtAuctionLimit
    
      AtAuction
    
      Unknown
    """
    Any: typing.ClassVar[PriceType]  # value = <PriceType.Any: 1>
    AtAuction: typing.ClassVar[PriceType]  # value = <PriceType.AtAuction: 9>
    AtAuctionLimit: typing.ClassVar[PriceType]  # value = <PriceType.AtAuctionLimit: 8>
    EnhancedLimit: typing.ClassVar[PriceType]  # value = <PriceType.EnhancedLimit: 7>
    Fak: typing.ClassVar[PriceType]  # value = <PriceType.Fak: 5>
    FakBest5: typing.ClassVar[PriceType]  # value = <PriceType.FakBest5: 2>
    Fok: typing.ClassVar[PriceType]  # value = <PriceType.Fok: 6>
    ForwardBest: typing.ClassVar[PriceType]  # value = <PriceType.ForwardBest: 3>
    Limit: typing.ClassVar[PriceType]  # value = <PriceType.Limit: 0>
    ReverseBest: typing.ClassVar[PriceType]  # value = <PriceType.ReverseBest: 4>
    Unknown: typing.ClassVar[PriceType]  # value = <PriceType.Unknown: 10>
    __members__: typing.ClassVar[dict[str, PriceType]]  # value = {'Any': <PriceType.Any: 1>, 'FakBest5': <PriceType.FakBest5: 2>, 'Fak': <PriceType.Fak: 5>, 'Fok': <PriceType.Fok: 6>, 'Limit': <PriceType.Limit: 0>, 'ForwardBest': <PriceType.ForwardBest: 3>, 'ReverseBest': <PriceType.ReverseBest: 4>, 'EnhancedLimit': <PriceType.EnhancedLimit: 7>, 'AtAuctionLimit': <PriceType.AtAuctionLimit: 8>, 'AtAuction': <PriceType.AtAuction: 9>, 'Unknown': <PriceType.Unknown: 10>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class Priority:
    """
    Members:
    
      Low
    
      Medium
    
      High
    """
    High: typing.ClassVar[Priority]  # value = <Priority.High: 2>
    Low: typing.ClassVar[Priority]  # value = <Priority.Low: 0>
    Medium: typing.ClassVar[Priority]  # value = <Priority.Medium: 1>
    __members__: typing.ClassVar[dict[str, Priority]]  # value = {'Low': <Priority.Low: 0>, 'Medium': <Priority.Medium: 1>, 'High': <Priority.High: 2>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class ResumePolicy:
    """
    Members:
    
      Now
    
      Intraday
    
      Stateless
    
      Continuous
    """
    Continuous: typing.ClassVar[ResumePolicy]  # value = <ResumePolicy.Continuous: 3>
    Intraday: typing.ClassVar[ResumePolicy]  # value = <ResumePolicy.Intraday: 1>
    Now: typing.ClassVar[ResumePolicy]  # value = <ResumePolicy.Now: 0>
    Stateless: typing.ClassVar[ResumePolicy]  # value = <ResumePolicy.Stateless: 2>
    __members__: typing.ClassVar[dict[str, ResumePolicy]]  # value = {'Now': <ResumePolicy.Now: 0>, 'Intraday': <ResumePolicy.Intraday: 1>, 'Stateless': <ResumePolicy.Stateless: 2>, 'Continuous': <ResumePolicy.Continuous: 3>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self: AlgoOrderActionFlag, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class Side:
    """
    Members:
    
      Buy
    
      Sell
    
      Lock
    
      Unlock
    
      Exec
    
      Drop
    
      Purchase
    
      Redemption
    
      Split
    
      Merge
    
      MarginTrade
    
      ShortSell
    
      RepayMargin
    
      RepayStock
    
      CashRepayMargin
    
      StockRepayStock
    
      SurplusStockTransfer
    
      GuaranteeStockTransferIn
    
      GuaranteeStockTransferOut
    
      GuaranteeStockBuy
    
      GuaranteeStockSell
    
      Unknown
    """
    Buy: typing.ClassVar[Side]  # value = <Side.Buy: 0>
    CashRepayMargin: typing.ClassVar[Side]  # value = <Side.CashRepayMargin: 14>
    Drop: typing.ClassVar[Side]  # value = <Side.Drop: 5>
    Exec: typing.ClassVar[Side]  # value = <Side.Exec: 4>
    GuaranteeStockBuy: typing.ClassVar[Side]  # value = <Side.GuaranteeStockBuy: 19>
    GuaranteeStockSell: typing.ClassVar[Side]  # value = <Side.GuaranteeStockSell: 20>
    GuaranteeStockTransferIn: typing.ClassVar[Side]  # value = <Side.GuaranteeStockTransferIn: 17>
    GuaranteeStockTransferOut: typing.ClassVar[Side]  # value = <Side.GuaranteeStockTransferOut: 18>
    Lock: typing.ClassVar[Side]  # value = <Side.Lock: 2>
    MarginTrade: typing.ClassVar[Side]  # value = <Side.MarginTrade: 10>
    Merge: typing.ClassVar[Side]  # value = <Side.Merge: 9>
    Purchase: typing.ClassVar[Side]  # value = <Side.Purchase: 6>
    Redemption: typing.ClassVar[Side]  # value = <Side.Redemption: 7>
    RepayMargin: typing.ClassVar[Side]  # value = <Side.RepayMargin: 12>
    RepayStock: typing.ClassVar[Side]  # value = <Side.RepayStock: 13>
    Sell: typing.ClassVar[Side]  # value = <Side.Sell: 1>
    ShortSell: typing.ClassVar[Side]  # value = <Side.ShortSell: 11>
    Split: typing.ClassVar[Side]  # value = <Side.Split: 8>
    StockRepayStock: typing.ClassVar[Side]  # value = <Side.StockRepayStock: 15>
    SurplusStockTransfer: typing.ClassVar[Side]  # value = <Side.SurplusStockTransfer: 16>
    Unknown: typing.ClassVar[Side]  # value = <Side.Unknown: 99>
    Unlock: typing.ClassVar[Side]  # value = <Side.Unlock: 3>
    __members__: typing.ClassVar[dict[str, Side]]  # value = {'Buy': <Side.Buy: 0>, 'Sell': <Side.Sell: 1>, 'Lock': <Side.Lock: 2>, 'Unlock': <Side.Unlock: 3>, 'Exec': <Side.Exec: 4>, 'Drop': <Side.Drop: 5>, 'Purchase': <Side.Purchase: 6>, 'Redemption': <Side.Redemption: 7>, 'Split': <Side.Split: 8>, 'Merge': <Side.Merge: 9>, 'MarginTrade': <Side.MarginTrade: 10>, 'ShortSell': <Side.ShortSell: 11>, 'RepayMargin': <Side.RepayMargin: 12>, 'RepayStock': <Side.RepayStock: 13>, 'CashRepayMargin': <Side.CashRepayMargin: 14>, 'StockRepayStock': <Side.StockRepayStock: 15>, 'SurplusStockTransfer': <Side.SurplusStockTransfer: 16>, 'GuaranteeStockTransferIn': <Side.GuaranteeStockTransferIn: 17>, 'GuaranteeStockTransferOut': <Side.GuaranteeStockTransferOut: 18>, 'GuaranteeStockBuy': <Side.GuaranteeStockBuy: 19>, 'GuaranteeStockSell': <Side.GuaranteeStockSell: 20>, 'Unknown': <Side.Unknown: 99>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class StrategyState:
    """
    Members:
    
      Normal
    
      Warn
    
      Error
    """
    Error: typing.ClassVar[StrategyState]  # value = <StrategyState.Error: 2>
    Normal: typing.ClassVar[StrategyState]  # value = <StrategyState.Normal: 0>
    Warn: typing.ClassVar[StrategyState]  # value = <StrategyState.Warn: 1>
    __members__: typing.ClassVar[dict[str, StrategyState]]  # value = {'Normal': <StrategyState.Normal: 0>, 'Warn': <StrategyState.Warn: 1>, 'Error': <StrategyState.Error: 2>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class SubscribeDataType:
    """
    Members:
    
      All
    
      Snapshot
    
      Transaction
    
      Entrust
    
      Tree
    
      Depth
    
      Tick
    """
    All: typing.ClassVar[SubscribeDataType]  # value = <SubscribeDataType.All: 0>
    Depth: typing.ClassVar[SubscribeDataType]  # value = <SubscribeDataType.Depth: 50>
    Entrust: typing.ClassVar[SubscribeDataType]  # value = <SubscribeDataType.Entrust: 2>
    Snapshot: typing.ClassVar[SubscribeDataType]  # value = <SubscribeDataType.Snapshot: 1>
    Tick: typing.ClassVar[SubscribeDataType]  # value = <SubscribeDataType.Tick: 22>
    Transaction: typing.ClassVar[SubscribeDataType]  # value = <SubscribeDataType.Transaction: 4>
    Tree: typing.ClassVar[SubscribeDataType]  # value = <SubscribeDataType.Tree: 8>
    __members__: typing.ClassVar[dict[str, SubscribeDataType]]  # value = {'All': <SubscribeDataType.All: 0>, 'Snapshot': <SubscribeDataType.Snapshot: 1>, 'Transaction': <SubscribeDataType.Transaction: 4>, 'Entrust': <SubscribeDataType.Entrust: 2>, 'Tree': <SubscribeDataType.Tree: 8>, 'Depth': <SubscribeDataType.Depth: 50>, 'Tick': <SubscribeDataType.Tick: 22>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __or__(self, arg0: SubscribeDataType) -> SubscribeDataType:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class SubscribeInstrumentType:
    """
    Members:
    
      All
    
      Stock
    
      Future
    
      Bond
    
      StockOption
    
      FutureOption
    
      Fund
    
      Index
    
      HKT
    """
    All: typing.ClassVar[SubscribeInstrumentType]  # value = <SubscribeInstrumentType.All: 0>
    Bond: typing.ClassVar[SubscribeInstrumentType]  # value = <SubscribeInstrumentType.Bond: 4>
    Fund: typing.ClassVar[SubscribeInstrumentType]  # value = <SubscribeInstrumentType.Fund: 32>
    Future: typing.ClassVar[SubscribeInstrumentType]  # value = <SubscribeInstrumentType.Future: 2>
    FutureOption: typing.ClassVar[SubscribeInstrumentType]  # value = <SubscribeInstrumentType.FutureOption: 16>
    HKT: typing.ClassVar[SubscribeInstrumentType]  # value = <SubscribeInstrumentType.HKT: 128>
    Index: typing.ClassVar[SubscribeInstrumentType]  # value = <SubscribeInstrumentType.Index: 64>
    Stock: typing.ClassVar[SubscribeInstrumentType]  # value = <SubscribeInstrumentType.Stock: 1>
    StockOption: typing.ClassVar[SubscribeInstrumentType]  # value = <SubscribeInstrumentType.StockOption: 8>
    __members__: typing.ClassVar[dict[str, SubscribeInstrumentType]]  # value = {'All': <SubscribeInstrumentType.All: 0>, 'Stock': <SubscribeInstrumentType.Stock: 1>, 'Future': <SubscribeInstrumentType.Future: 2>, 'Bond': <SubscribeInstrumentType.Bond: 4>, 'StockOption': <SubscribeInstrumentType.StockOption: 8>, 'FutureOption': <SubscribeInstrumentType.FutureOption: 16>, 'Fund': <SubscribeInstrumentType.Fund: 32>, 'Index': <SubscribeInstrumentType.Index: 64>, 'HKT': <SubscribeInstrumentType.HKT: 128>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __or__(self, arg0: SubscribeInstrumentType) -> SubscribeInstrumentType:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class TimeCondition:
    """
    Members:
    
      IOC
    
      GFD
    
      GTC
    
      GFS
    
      GTD
    
      GFA
    
      Unknown
    """
    GFA: typing.ClassVar[TimeCondition]  # value = <TimeCondition.GFA: 5>
    GFD: typing.ClassVar[TimeCondition]  # value = <TimeCondition.GFD: 1>
    GFS: typing.ClassVar[TimeCondition]  # value = <TimeCondition.GFS: 3>
    GTC: typing.ClassVar[TimeCondition]  # value = <TimeCondition.GTC: 2>
    GTD: typing.ClassVar[TimeCondition]  # value = <TimeCondition.GTD: 4>
    IOC: typing.ClassVar[TimeCondition]  # value = <TimeCondition.IOC: 0>
    Unknown: typing.ClassVar[TimeCondition]  # value = <TimeCondition.Unknown: 6>
    __members__: typing.ClassVar[dict[str, TimeCondition]]  # value = {'IOC': <TimeCondition.IOC: 0>, 'GFD': <TimeCondition.GFD: 1>, 'GTC': <TimeCondition.GTC: 2>, 'GFS': <TimeCondition.GFS: 3>, 'GTD': <TimeCondition.GTD: 4>, 'GFA': <TimeCondition.GFA: 5>, 'Unknown': <TimeCondition.Unknown: 6>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class VolumeCondition:
    """
    Members:
    
      Any
    
      Min
    
      All
    """
    All: typing.ClassVar[VolumeCondition]  # value = <VolumeCondition.All: 2>
    Any: typing.ClassVar[VolumeCondition]  # value = <VolumeCondition.Any: 0>
    Min: typing.ClassVar[VolumeCondition]  # value = <VolumeCondition.Min: 1>
    __members__: typing.ClassVar[dict[str, VolumeCondition]]  # value = {'Any': <VolumeCondition.Any: 0>, 'Min': <VolumeCondition.Min: 1>, 'All': <VolumeCondition.All: 2>}
    @typing.overload
    def __eq__(self, other: typing.Any) -> bool:
        ...
    @typing.overload
    def __eq__(self, arg0: int) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class category:
    """
    Kungfu Data Category
    
    Members:
    
      MD
    
      TD
    
      STRATEGY
    
      SYSTEM
    
      OPERATOR
    """
    MD: typing.ClassVar[category]  # value = <category.MD: 0>
    OPERATOR: typing.ClassVar[category]  # value = <category.OPERATOR: 4>
    STRATEGY: typing.ClassVar[category]  # value = <category.STRATEGY: 2>
    SYSTEM: typing.ClassVar[category]  # value = <category.SYSTEM: 3>
    TD: typing.ClassVar[category]  # value = <category.TD: 1>
    __members__: typing.ClassVar[dict[str, category]]  # value = {'MD': <category.MD: 0>, 'TD': <category.TD: 1>, 'STRATEGY': <category.STRATEGY: 2>, 'SYSTEM': <category.SYSTEM: 3>, 'OPERATOR': <category.OPERATOR: 4>}
    def __eq__(self, other: typing.Any) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class layout:
    """
    Kungfu Data Layout
    
    Members:
    
      JOURNAL
    
      SQLITE
    
      NANOMSG
    
      LOG
    """
    JOURNAL: typing.ClassVar[layout]  # value = <layout.JOURNAL: 0>
    LOG: typing.ClassVar[layout]  # value = <layout.LOG: 3>
    NANOMSG: typing.ClassVar[layout]  # value = <layout.NANOMSG: 2>
    SQLITE: typing.ClassVar[layout]  # value = <layout.SQLITE: 1>
    __members__: typing.ClassVar[dict[str, layout]]  # value = {'JOURNAL': <layout.JOURNAL: 0>, 'SQLITE': <layout.SQLITE: 1>, 'NANOMSG': <layout.NANOMSG: 2>, 'LOG': <layout.LOG: 3>}
    def __eq__(self, other: typing.Any) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
class mode:
    """
    Kungfu Run Mode
    
    Members:
    
      LIVE
    
      DATA
    
      REPLAY
    
      BACKTEST
    """
    BACKTEST: typing.ClassVar[mode]  # value = <mode.BACKTEST: 3>
    DATA: typing.ClassVar[mode]  # value = <mode.DATA: 1>
    LIVE: typing.ClassVar[mode]  # value = <mode.LIVE: 0>
    REPLAY: typing.ClassVar[mode]  # value = <mode.REPLAY: 2>
    __members__: typing.ClassVar[dict[str, mode]]  # value = {'LIVE': <mode.LIVE: 0>, 'DATA': <mode.DATA: 1>, 'REPLAY': <mode.REPLAY: 2>, 'BACKTEST': <mode.BACKTEST: 3>}
    def __eq__(self, other: typing.Any) -> bool:
        ...
    def __ge__(self, other: typing.Any) -> bool:
        ...
    def __getstate__(self) -> int:
        ...
    def __gt__(self, other: typing.Any) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    def __index__(self) -> int:
        ...
    def __init__(self, value: int) -> None:
        ...
    def __int__(self) -> int:
        ...
    def __le__(self, other: typing.Any) -> bool:
        ...
    def __lt__(self, other: typing.Any) -> bool:
        ...
    def __ne__(self, other: typing.Any) -> bool:
        ...
    def __repr__(self) -> str:
        ...
    def __setstate__(self, state: int) -> None:
        ...
    def __str__(self) -> str:
        ...
    @property
    def name(self) -> str:
        ...
    @property
    def value(self) -> int:
        ...
def get_category_by_name(arg0: str) -> category:
    ...
def get_category_name(arg0: category) -> str:
    ...
def get_layout_name(arg0: layout) -> str:
    ...
def get_mode_by_name(arg0: str) -> mode:
    ...
def get_mode_name(arg0: mode) -> str:
    ...
Account: LedgerCategory  # value = <LedgerCategory.Account: 0>
All: SubscribeInstrumentType  # value = <SubscribeInstrumentType.All: 0>
Allow: ETFStatus  # value = <ETFStatus.Allow: 1>
Any: VolumeCondition  # value = <VolumeCondition.Any: 0>
Arbitrage: HedgeFlag  # value = <HedgeFlag.Arbitrage: 1>
AskPriceGreaterEqualStopPrice: OrderTriggerType  # value = <OrderTriggerType.AskPriceGreaterEqualStopPrice: 9>
AskPriceGreaterThanStopPrice: OrderTriggerType  # value = <OrderTriggerType.AskPriceGreaterThanStopPrice: 8>
AskPriceLesserEqualStopPrice: OrderTriggerType  # value = <OrderTriggerType.AskPriceLesserEqualStopPrice: 11>
AskPriceLesserThanStopPrice: OrderTriggerType  # value = <OrderTriggerType.AskPriceLesserThanStopPrice: 10>
AtAuction: PriceType  # value = <PriceType.AtAuction: 9>
AtAuctionLimit: PriceType  # value = <PriceType.AtAuctionLimit: 8>
BACKTEST: mode  # value = <mode.BACKTEST: 3>
BSE: MarketType  # value = <MarketType.BSE: 1>
BadDebtInterest: ContractType  # value = <ContractType.BadDebtInterest: 7>
BidPriceGreaterEqualStopPrice: OrderTriggerType  # value = <OrderTriggerType.BidPriceGreaterEqualStopPrice: 13>
BidPriceGreaterThanStopPrice: OrderTriggerType  # value = <OrderTriggerType.BidPriceGreaterThanStopPrice: 12>
BidPriceLesserEqualStopPrice: OrderTriggerType  # value = <OrderTriggerType.BidPriceLesserEqualStopPrice: 15>
BidPriceLesserThanStopPrice: OrderTriggerType  # value = <OrderTriggerType.BidPriceLesserThanStopPrice: 14>
Bond: SubscribeInstrumentType  # value = <SubscribeInstrumentType.Bond: 4>
Buy: BsFlag  # value = <BsFlag.Buy: 1>
ByAmount: CommissionRateMode  # value = <CommissionRateMode.ByAmount: 0>
ByVolume: CommissionRateMode  # value = <CommissionRateMode.ByVolume: 1>
CEN: Currency  # value = <Currency.CEN: 10>
CFFEX: MarketType  # value = <MarketType.CFFEX: 3>
CNH: Currency  # value = <Currency.CNH: 7>
CNY: Currency  # value = <Currency.CNY: 1>
CZCE: MarketType  # value = <MarketType.CZCE: 5>
Cancel: AlgoOrderActionFlag  # value = <AlgoOrderActionFlag.Cancel: 0>
Cancelled: OrderStatus  # value = <OrderStatus.Cancelled: 3>
Cancelling: OrderStatus  # value = <OrderStatus.Cancelling: 9>
CapitalOccupationFee: ContractType  # value = <ContractType.CapitalOccupationFee: 8>
CapitalRightsCompensation: ContractType  # value = <ContractType.CapitalRightsCompensation: 4>
CashBondETF: ETFType  # value = <ETFType.CashBondETF: 6>
CashRepayMargin: Side  # value = <Side.CashRepayMargin: 14>
Close: Offset  # value = <Offset.Close: 1>
CloseOut: CloseOutFlag  # value = <CloseOutFlag.CloseOut: 1>
CloseToday: Offset  # value = <Offset.CloseToday: 2>
CloseYesterday: Offset  # value = <Offset.CloseYesterday: 3>
CommodityETF: ETFType  # value = <ETFType.CommodityETF: 5>
Connected: OperatorState  # value = <OperatorState.Connected: 3>
Continuous: ResumePolicy  # value = <ResumePolicy.Continuous: 3>
Covered: HedgeFlag  # value = <HedgeFlag.Covered: 3>
CrdBuyContract: ContractType  # value = <ContractType.CrdBuyContract: 0>
CrdBuyInterest: ContractType  # value = <ContractType.CrdBuyInterest: 2>
CrdSellContract: ContractType  # value = <ContractType.CrdSellContract: 1>
CrdSellFee: ContractType  # value = <ContractType.CrdSellFee: 3>
Credit: AccountType  # value = <AccountType.Credit: 1>
CrossCountryETF: ETFType  # value = <ETFType.CrossCountryETF: 1>
CrossMarketETF: ETFType  # value = <ETFType.CrossMarketETF: 2>
Crypto: InstrumentType  # value = <InstrumentType.Crypto: 9>
CryptoFuture: InstrumentType  # value = <InstrumentType.CryptoFuture: 10>
CryptoUFuture: InstrumentType  # value = <InstrumentType.CryptoUFuture: 11>
CurrencyETF: ETFType  # value = <ETFType.CurrencyETF: 3>
Custom: BasketType  # value = <BasketType.Custom: 0>
DATA: mode  # value = <mode.DATA: 1>
DCE: MarketType  # value = <MarketType.DCE: 4>
Default: AccountingMethodType  # value = <AccountingMethodType.Default: 0>
Depth: SubscribeDataType  # value = <SubscribeDataType.Depth: 50>
DisConnected: OperatorState  # value = <OperatorState.DisConnected: 2>
Drop: Side  # value = <Side.Drop: 5>
ETF: BasketType  # value = <BasketType.ETF: 1>
EUR: Currency  # value = <Currency.EUR: 6>
EnReplace: CashReplaceFlag  # value = <CashReplaceFlag.EnReplace: 1>
EnhancedLimit: PriceType  # value = <PriceType.EnhancedLimit: 7>
Entrust: SubscribeDataType  # value = <SubscribeDataType.Entrust: 2>
Error: StrategyState  # value = <StrategyState.Error: 2>
Exec: Side  # value = <Side.Exec: 4>
Fak: PriceType  # value = <PriceType.Fak: 5>
FakBest5: PriceType  # value = <PriceType.FakBest5: 2>
Filled: OrderStatus  # value = <OrderStatus.Filled: 5>
Fok: PriceType  # value = <PriceType.Fok: 6>
Forbid: ETFStatus  # value = <ETFStatus.Forbid: 0>
ForwardBest: PriceType  # value = <PriceType.ForwardBest: 3>
Fund: SubscribeInstrumentType  # value = <SubscribeInstrumentType.Fund: 32>
Future: SubscribeInstrumentType  # value = <SubscribeInstrumentType.Future: 2>
FutureOption: SubscribeInstrumentType  # value = <SubscribeInstrumentType.FutureOption: 16>
GBP: Currency  # value = <Currency.GBP: 5>
GFA: TimeCondition  # value = <TimeCondition.GFA: 5>
GFD: TimeCondition  # value = <TimeCondition.GFD: 1>
GFS: TimeCondition  # value = <TimeCondition.GFS: 3>
GTC: TimeCondition  # value = <TimeCondition.GTC: 2>
GTD: TimeCondition  # value = <TimeCondition.GTD: 4>
GuaranteeStockBuy: Side  # value = <Side.GuaranteeStockBuy: 19>
GuaranteeStockSell: Side  # value = <Side.GuaranteeStockSell: 20>
GuaranteeStockTransferIn: Side  # value = <Side.GuaranteeStockTransferIn: 17>
GuaranteeStockTransferOut: Side  # value = <Side.GuaranteeStockTransferOut: 18>
HKD: Currency  # value = <Currency.HKD: 2>
HKT: SubscribeInstrumentType  # value = <SubscribeInstrumentType.HKT: 128>
Hedge: HedgeFlag  # value = <HedgeFlag.Hedge: 2>
High: Priority  # value = <Priority.High: 2>
INE: MarketType  # value = <MarketType.INE: 6>
IOC: TimeCondition  # value = <TimeCondition.IOC: 0>
Idle: BrokerState  # value = <BrokerState.Idle: 1>
Immediately: OrderTriggerType  # value = <OrderTriggerType.Immediately: 0>
Index: SubscribeInstrumentType  # value = <SubscribeInstrumentType.Index: 64>
InitNotCloseOut: CloseOutFlag  # value = <CloseOutFlag.InitNotCloseOut: 2>
Intraday: ResumePolicy  # value = <ResumePolicy.Intraday: 1>
JOURNAL: layout  # value = <layout.JOURNAL: 0>
JPY: Currency  # value = <Currency.JPY: 4>
Json: FrameDataType  # value = <FrameDataType.Json: 1>
LIVE: mode  # value = <mode.LIVE: 0>
LOG: layout  # value = <layout.LOG: 3>
Last: PriceLevel  # value = <PriceLevel.Last: 0>
LastPriceGreaterEqualStopPrice: OrderTriggerType  # value = <OrderTriggerType.LastPriceGreaterEqualStopPrice: 5>
LastPriceGreaterThanStopPrice: OrderTriggerType  # value = <OrderTriggerType.LastPriceGreaterThanStopPrice: 4>
LastPriceLesserEqualStopPrice: OrderTriggerType  # value = <OrderTriggerType.LastPriceLesserEqualStopPrice: 7>
LastPriceLesserThanStopPrice: OrderTriggerType  # value = <OrderTriggerType.LastPriceLesserThanStopPrice: 6>
Limit: PriceType  # value = <PriceType.Limit: 0>
LocalETF: ETFType  # value = <ETFType.LocalETF: 0>
Lock: Side  # value = <Side.Lock: 2>
LoggedIn: BrokerState  # value = <BrokerState.LoggedIn: 4>
LoginFailed: BrokerState  # value = <BrokerState.LoginFailed: 5>
Long: Direction  # value = <Direction.Long: 0>
Lost: OrderStatus  # value = <OrderStatus.Lost: 8>
Low: Priority  # value = <Priority.Low: 0>
MD: category  # value = <category.MD: 0>
MYR: Currency  # value = <Currency.MYR: 9>
ManagementFee: ContractType  # value = <ContractType.ManagementFee: 9>
MarginTrade: Side  # value = <Side.MarginTrade: 10>
Medium: Priority  # value = <Priority.Medium: 1>
Merge: Side  # value = <Side.Merge: 9>
Min: VolumeCondition  # value = <VolumeCondition.Min: 1>
MustReplace: CashReplaceFlag  # value = <CashReplaceFlag.MustReplace: 2>
NANOMSG: layout  # value = <layout.NANOMSG: 2>
Normal: PageStatus  # value = <PageStatus.Normal: 0>
NotCloseOut: CloseOutFlag  # value = <CloseOutFlag.NotCloseOut: 0>
Now: ResumePolicy  # value = <ResumePolicy.Now: 0>
OPERATOR: category  # value = <category.OPERATOR: 4>
OTC: AccountingMethodType  # value = <AccountingMethodType.OTC: 1>
Open: Offset  # value = <Offset.Open: 0>
Opposing1: PriceLevel  # value = <PriceLevel.Opposing1: 5>
Opposing2: PriceLevel  # value = <PriceLevel.Opposing2: 4>
Opposing3: PriceLevel  # value = <PriceLevel.Opposing3: 3>
Opposing4: PriceLevel  # value = <PriceLevel.Opposing4: 2>
Opposing5: PriceLevel  # value = <PriceLevel.Opposing5: 1>
OverdueInterest: ContractType  # value = <ContractType.OverdueInterest: 6>
Own1: PriceLevel  # value = <PriceLevel.Own1: 6>
Own2: PriceLevel  # value = <PriceLevel.Own2: 7>
Own3: PriceLevel  # value = <PriceLevel.Own3: 8>
Own4: PriceLevel  # value = <PriceLevel.Own4: 9>
Own5: PriceLevel  # value = <PriceLevel.Own5: 10>
PageEnd: HistoryDataType  # value = <HistoryDataType.PageEnd: 1>
ParkedOrder: OrderTriggerType  # value = <OrderTriggerType.ParkedOrder: 3>
PartialFilledActive: OrderStatus  # value = <OrderStatus.PartialFilledActive: 7>
PartialFilledNotActive: OrderStatus  # value = <OrderStatus.PartialFilledNotActive: 6>
Pending: OperatorState  # value = <OperatorState.Pending: 0>
PendingSettlement: OrderStatus  # value = <OrderStatus.PendingSettlement: 11>
PhysicalBondETF: ETFType  # value = <ETFType.PhysicalBondETF: 4>
PreOpen: PageStatus  # value = <PageStatus.PreOpen: 1>
Proportion: BasketVolumeType  # value = <BasketVolumeType.Proportion: 2>
Purchase: Side  # value = <Side.Purchase: 6>
PurchaseOnly: ETFStatus  # value = <ETFStatus.PurchaseOnly: 2>
Quantity: BasketVolumeType  # value = <BasketVolumeType.Quantity: 1>
REPLAY: mode  # value = <mode.REPLAY: 2>
Raw: FrameDataType  # value = <FrameDataType.Raw: 0>
Ready: OperatorState  # value = <OperatorState.Ready: 100>
Redemption: Side  # value = <Side.Redemption: 7>
RedemptionOnly: ETFStatus  # value = <ETFStatus.RedemptionOnly: 3>
RepayMargin: Side  # value = <Side.RepayMargin: 12>
RepayStock: Side  # value = <Side.RepayStock: 13>
Repo: InstrumentType  # value = <InstrumentType.Repo: 8>
ReverseBest: PriceType  # value = <PriceType.ReverseBest: 4>
SGD: Currency  # value = <Currency.SGD: 8>
SHFE: MarketType  # value = <MarketType.SHFE: 2>
SQLITE: layout  # value = <layout.SQLITE: 1>
SSE: MarketType  # value = <MarketType.SSE: 7>
STRATEGY: category  # value = <category.STRATEGY: 2>
SYSTEM: category  # value = <category.SYSTEM: 3>
SZE: MarketType  # value = <MarketType.SZE: 8>
Sell: BsFlag  # value = <BsFlag.Sell: 2>
ShareRightsCompensation: ContractType  # value = <ContractType.ShareRightsCompensation: 5>
Short: Direction  # value = <Direction.Short: 1>
ShortSell: Side  # value = <Side.ShortSell: 11>
Snapshot: SubscribeDataType  # value = <SubscribeDataType.Snapshot: 1>
Speculation: HedgeFlag  # value = <HedgeFlag.Speculation: 0>
Split: Side  # value = <Side.Split: 8>
Start: AlgoOrderActionFlag  # value = <AlgoOrderActionFlag.Start: 1>
Stateless: ResumePolicy  # value = <ResumePolicy.Stateless: 2>
Stock: SubscribeInstrumentType  # value = <SubscribeInstrumentType.Stock: 1>
StockOption: SubscribeInstrumentType  # value = <SubscribeInstrumentType.StockOption: 8>
StockRepayStock: Side  # value = <Side.StockRepayStock: 15>
Stop: AlgoOrderActionFlag  # value = <AlgoOrderActionFlag.Stop: 2>
Strategy: LedgerCategory  # value = <LedgerCategory.Strategy: 1>
Submitted: OrderStatus  # value = <OrderStatus.Submitted: 1>
SurplusStockTransfer: Side  # value = <Side.SurplusStockTransfer: 16>
TD: category  # value = <category.TD: 1>
TechStock: InstrumentType  # value = <InstrumentType.TechStock: 3>
Tick: SubscribeDataType  # value = <SubscribeDataType.Tick: 22>
TotalEnd: HistoryDataType  # value = <HistoryDataType.TotalEnd: 2>
Touch: OrderTriggerType  # value = <OrderTriggerType.Touch: 1>
TouchProfit: OrderTriggerType  # value = <OrderTriggerType.TouchProfit: 2>
Trade: ExecType  # value = <ExecType.Trade: 2>
Transaction: SubscribeDataType  # value = <SubscribeDataType.Transaction: 4>
Tree: SubscribeDataType  # value = <SubscribeDataType.Tree: 8>
TriggerCancel: OrderTriggerFlag  # value = <OrderTriggerFlag.TriggerCancel: 1>
TriggerInsert: OrderTriggerFlag  # value = <OrderTriggerFlag.TriggerInsert: 0>
USD: Currency  # value = <Currency.USD: 3>
UnHKMustReplace: CashReplaceFlag  # value = <CashReplaceFlag.UnHKMustReplace: 8>
UnHKReplace: CashReplaceFlag  # value = <CashReplaceFlag.UnHKReplace: 7>
UnReplace: CashReplaceFlag  # value = <CashReplaceFlag.UnReplace: 0>
UnSSEMustReplace: CashReplaceFlag  # value = <CashReplaceFlag.UnSSEMustReplace: 4>
UnSSEReplace: CashReplaceFlag  # value = <CashReplaceFlag.UnSSEReplace: 3>
UnSSESZEMustReplace: CashReplaceFlag  # value = <CashReplaceFlag.UnSSESZEMustReplace: 6>
UnSSESZEReplace: CashReplaceFlag  # value = <CashReplaceFlag.UnSSESZEReplace: 5>
Unknown: Currency  # value = <Currency.Unknown: 0>
Unlock: Side  # value = <Side.Unlock: 3>
UpperLimitPrice: PriceLevel  # value = <PriceLevel.UpperLimitPrice: 11>
Warn: StrategyState  # value = <StrategyState.Warn: 1>
lowerLimitPrice: PriceLevel  # value = <PriceLevel.lowerLimitPrice: 12>
