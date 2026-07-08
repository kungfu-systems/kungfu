from __future__ import annotations
import pykungfu.longfist.enums
import typing
__all__: list[str] = ['AlgoOrder', 'AlgoOrderAction', 'AlgoOrderActionError', 'AlgoOrderInput', 'Asset', 'Band', 'Basket', 'BasketInstrument', 'BlockMessage', 'BrokerStateUpdate', 'CacheReset', 'Channel', 'ChannelRequest', 'Commission', 'Config', 'Contract', 'CustomSubscribe', 'Deregister', 'Entrust', 'HistoryOrder', 'HistoryTrade', 'Instrument', 'InstrumentFactor', 'InstrumentKey', 'Location', 'OperatorStateUpdate', 'Order', 'OrderAction', 'OrderActionError', 'OrderInput', 'OrderStat', 'OrderTrigger', 'OrderTriggerAction', 'OrderTriggerActionError', 'OrderTriggerInput', 'OutputKey', 'Position', 'PositionEnd', 'Quote', 'Register', 'RequestCachedDone', 'RequestHistoryOrder', 'RequestHistoryOrderError', 'RequestHistoryTrade', 'RequestHistoryTradeError', 'RequestReadFrom', 'RequestReadFromOthers', 'RequestReadFromPublic', 'RequestReadFromSync', 'RequestWriteTo', 'RequestWriteToBand', 'RiskSetting', 'Session', 'StrategyStateUpdate', 'SyntheticData', 'TimeKeyValue', 'TimeRequest', 'TimeReset', 'TimeValue', 'Trade', 'TradingDay', 'Transaction', 'Tree', 'frame_header', 'page_header']
class AlgoOrder:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 214
    algo_id: String[str[128]]
    algo_type_id: String[str[128]]
    basket_uid: int
    begin_time: int
    end_time: int
    error_msg: String[str[256]]
    exchange_id: String[str[16]]
    external_order_id: String[str[32]]
    insert_time: int
    instrument_id: String[str[32]]
    instrument_type: pykungfu.longfist.enums.InstrumentType
    is_local: bool
    offset: pykungfu.longfist.enums.Offset
    order_id: int
    price_level: pykungfu.longfist.enums.PriceLevel
    price_offset: float
    price_type: pykungfu.longfist.enums.PriceType
    restore_time: int
    side: pykungfu.longfist.enums.Side
    status: pykungfu.longfist.enums.OrderStatus
    update_time: int
    volume: float
    volume_left: float
    def __eq__(self, arg0: AlgoOrder) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class AlgoOrderAction:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 215
    action_flag: pykungfu.longfist.enums.AlgoOrderActionFlag
    insert_time: int
    order_action_id: int
    order_id: int
    def __eq__(self, arg0: AlgoOrderAction) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class AlgoOrderActionError:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 216
    error_id: int
    error_msg: String[str[256]]
    external_order_id: String[str[32]]
    insert_time: int
    order_action_id: int
    order_id: int
    def __eq__(self, arg0: AlgoOrderActionError) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class AlgoOrderInput:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 213
    algo_id: String[str[128]]
    algo_type_id: String[str[128]]
    args: str
    basket_uid: int
    begin_time: int
    end_time: int
    exchange_id: String[str[16]]
    insert_time: int
    instrument_id: String[str[32]]
    instrument_type: pykungfu.longfist.enums.InstrumentType
    is_local: bool
    offset: pykungfu.longfist.enums.Offset
    order_id: int
    origin_order_id: int
    price_level: pykungfu.longfist.enums.PriceLevel
    price_offset: float
    price_type: pykungfu.longfist.enums.PriceType
    side: pykungfu.longfist.enums.Side
    volume: float
    def __eq__(self, arg0: AlgoOrderInput) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Asset:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 101
    accumulated_fee: float
    avail: float
    avail_margin: float
    buyredeliver_fund_available: float
    close_pnl: float
    collateral_ratio: float
    credit: float
    credit_buy_fund_available: float
    directrepay_fund_available: float
    dynamic_equity: float
    frozen_cash: float
    frozen_fee: float
    frozen_margin: float
    gage_buy_fund_available: float
    holder_uid: int
    initial_equity: float
    intraday_fee: float
    ledger_category: pykungfu.longfist.enums.LedgerCategory
    long_avail: float
    long_debt: float
    long_margin: float
    long_market_value: float
    long_total_debt: float
    margin: float
    margin_interest: float
    market_value: float
    net_assets: float
    position_pnl: float
    realized_pnl: float
    settlement: float
    short_avail: float
    short_cash: float
    short_margin: float
    short_market_value: float
    short_total_debt: float
    static_equity: float
    total_asset: float
    total_debt: float
    unrealized_pnl: float
    update_time: int
    def __eq__(self, arg0: Asset) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Band:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10308
    dest_id: int
    source_id: int
    def __eq__(self, arg0: Band) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Basket:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10206
    basket_type: pykungfu.longfist.enums.BasketType
    cash_difference: float
    etf_status: pykungfu.longfist.enums.ETFStatus
    etf_type: pykungfu.longfist.enums.ETFType
    etf_value: float
    exchange_id: String[str[16]]
    id: int
    instrument_id: String[str[32]]
    max_cash_ratio: float
    max_purchase_volume: float
    max_redemption_volume: float
    min_volume: float
    name: str
    net_unit_value: float
    total_amount: float
    volume_type: pykungfu.longfist.enums.BasketVolumeType
    def __eq__(self, arg0: Basket) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class BasketInstrument:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10207
    basket_uid: int
    cash_premium_ratio: float
    close_today_first: bool
    direction: pykungfu.longfist.enums.Direction
    exchange_id: String[str[16]]
    instrument_id: String[str[32]]
    instrument_type: pykungfu.longfist.enums.InstrumentType
    keep_single_side: bool
    rate: float
    replace_balance: float
    replace_flag: pykungfu.longfist.enums.CashReplaceFlag
    volume: float
    def __eq__(self, arg0: BasketInstrument) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class BlockMessage:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 206
    block_id: int
    insert_time: int
    is_specific: bool
    match_number: int
    opponent_seat: String[str[16]]
    def __eq__(self, arg0: BlockMessage) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class BrokerStateUpdate:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10106
    location_uid: int
    state: pykungfu.longfist.enums.BrokerState
    def __eq__(self, arg0: BrokerStateUpdate) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class CacheReset:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10208
    carrier_type: int
    def __eq__(self, arg0: CacheReset) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Channel:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10305
    dest_id: int
    source_id: int
    def __eq__(self, arg0: Channel) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class ChannelRequest:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10306
    dest_id: int
    source_id: int
    def __eq__(self, arg0: ChannelRequest) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Commission:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10203
    close_ratio: float
    close_today_ratio: float
    exchange_id: String[str[16]]
    instrument_type: pykungfu.longfist.enums.InstrumentType
    min_commission: float
    mode: pykungfu.longfist.enums.CommissionRateMode
    open_ratio: float
    product_id: String[str[128]]
    def __eq__(self, arg0: Commission) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Config:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10201
    group: str
    location_uid: int
    mode: pykungfu.longfist.enums.mode
    name: str
    role: pykungfu.longfist.enums.location_role
    seed: int
    uid64: int
    value: str
    def __eq__(self, arg0: Config) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Contract:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 102
    close_out_flag: pykungfu.longfist.enums.CloseOutFlag
    contract_id: String[str[64]]
    contract_type: pykungfu.longfist.enums.ContractType
    exchange_id: String[str[16]]
    expiration_date: String[str[16]]
    holder_uid: int
    instrument_id: String[str[32]]
    instrument_type: pykungfu.longfist.enums.InstrumentType
    opening_date: String[str[16]]
    repayment_amt: float
    repayment_qty: float
    total_liability_amt: float
    total_liability_qty: float
    unsettled_interest: float
    update_time: int
    def __eq__(self, arg0: Contract) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class CustomSubscribe:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 502
    data_type: pykungfu.longfist.enums.SubscribeDataType
    instrument_type: pykungfu.longfist.enums.SubscribeInstrumentType
    market_type: pykungfu.longfist.enums.MarketType
    update_time: int
    def __eq__(self, arg0: CustomSubscribe) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Deregister:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10102
    group: str
    location_uid: int
    mode: pykungfu.longfist.enums.mode
    name: str
    role: pykungfu.longfist.enums.location_role
    seed: int
    uid64: int
    def __eq__(self, arg0: Deregister) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Entrust:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 402
    biz_index: int
    data_time: int
    exchange_id: String[str[16]]
    instrument_id: String[str[32]]
    instrument_type: pykungfu.longfist.enums.InstrumentType
    main_seq: int
    orig_order_no: int
    price: float
    price_type: pykungfu.longfist.enums.PriceType
    seq: int
    side: pykungfu.longfist.enums.Side
    volume: float
    def __eq__(self, arg0: Entrust) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class HistoryOrder:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 303
    commission: float
    contract_id: String[str[64]]
    data_type: pykungfu.longfist.enums.HistoryDataType
    error_id: int
    error_msg: String[str[256]]
    exchange_id: String[str[16]]
    external_order_id: String[str[32]]
    frozen_price: float
    hedge_flag: pykungfu.longfist.enums.HedgeFlag
    insert_time: int
    instrument_id: String[str[32]]
    instrument_type: pykungfu.longfist.enums.InstrumentType
    is_last: bool
    is_swap: bool
    limit_price: float
    offset: pykungfu.longfist.enums.Offset
    order_id: int
    price_type: pykungfu.longfist.enums.PriceType
    side: pykungfu.longfist.enums.Side
    status: pykungfu.longfist.enums.OrderStatus
    tax: float
    time_condition: pykungfu.longfist.enums.TimeCondition
    trading_day: String[str[16]]
    update_time: int
    volume: float
    volume_condition: pykungfu.longfist.enums.VolumeCondition
    volume_left: float
    def __eq__(self, arg0: HistoryOrder) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class HistoryTrade:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 304
    close_today_volume: float
    commission: float
    contract_id: String[str[64]]
    data_type: pykungfu.longfist.enums.HistoryDataType
    error_id: int
    error_msg: String[str[256]]
    exchange_id: String[str[16]]
    external_order_id: String[str[32]]
    external_trade_id: String[str[32]]
    hedge_flag: pykungfu.longfist.enums.HedgeFlag
    instrument_id: String[str[32]]
    instrument_type: pykungfu.longfist.enums.InstrumentType
    is_last: bool
    is_withdraw: bool
    offset: pykungfu.longfist.enums.Offset
    order_id: int
    price: float
    side: pykungfu.longfist.enums.Side
    tax: float
    trade_id: int
    trade_time: int
    trading_day: String[str[16]]
    volume: float
    def __eq__(self, arg0: HistoryTrade) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Instrument:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10204
    contract_multiplier: int
    create_date: String[str[16]]
    currency: pykungfu.longfist.enums.Currency
    delivery_month: int
    delivery_year: int
    exchange_id: String[str[16]]
    expire_date: String[str[16]]
    instrument_id: String[str[32]]
    instrument_type: pykungfu.longfist.enums.InstrumentType
    open_date: String[str[16]]
    price_tick: float
    product_id: list[int[128]]
    quantity_unit: float
    def __eq__(self, arg0: Instrument) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class InstrumentFactor:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 105
    conversion_rate: float
    exchange_id: String[str[16]]
    exchange_rate: float
    instrument_id: String[str[32]]
    instrument_type: pykungfu.longfist.enums.InstrumentType
    is_trading: bool
    long_margin_ratio: float
    product_id: list[int[128]]
    short_margin_ratio: float
    source_id: int
    def __eq__(self, arg0: InstrumentFactor) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class InstrumentKey:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 501
    exchange_id: String[str[16]]
    instrument_id: String[str[32]]
    instrument_type: pykungfu.longfist.enums.InstrumentType
    key: int
    def __eq__(self, arg0: InstrumentKey) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Location:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10205
    group: str
    location_uid: int
    mode: pykungfu.longfist.enums.mode
    name: str
    role: pykungfu.longfist.enums.location_role
    seed: int
    uid64: int
    def __eq__(self, arg0: Location) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class OperatorStateUpdate:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10105
    info_a: str
    info_b: str
    location_uid: int
    state: pykungfu.longfist.enums.OperatorState
    update_time: int
    value: str
    def __eq__(self, arg0: OperatorStateUpdate) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Order:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 202
    commission: float
    contract_id: String[str[64]]
    error_id: int
    error_msg: String[str[256]]
    exchange_id: String[str[16]]
    external_order_id: String[str[32]]
    frozen_price: float
    hedge_flag: pykungfu.longfist.enums.HedgeFlag
    insert_time: int
    instrument_id: String[str[32]]
    instrument_type: pykungfu.longfist.enums.InstrumentType
    is_swap: bool
    limit_price: float
    offset: pykungfu.longfist.enums.Offset
    order_id: int
    parent_id: int
    price_type: pykungfu.longfist.enums.PriceType
    restore_time: int
    side: pykungfu.longfist.enums.Side
    status: pykungfu.longfist.enums.OrderStatus
    tax: float
    time_condition: pykungfu.longfist.enums.TimeCondition
    trading_day: String[str[16]]
    update_time: int
    volume: float
    volume_condition: pykungfu.longfist.enums.VolumeCondition
    volume_left: float
    def __eq__(self, arg0: Order) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class OrderAction:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 204
    action_flag: pykungfu.longfist.enums.OrderActionFlag
    insert_time: int
    order_action_id: int
    order_id: int
    def __eq__(self, arg0: OrderAction) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class OrderActionError:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 205
    error_id: int
    error_msg: String[str[256]]
    external_order_id: String[str[32]]
    insert_time: int
    order_action_id: int
    order_id: int
    def __eq__(self, arg0: OrderActionError) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class OrderInput:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 201
    block_id: int
    contract_id: String[str[64]]
    exchange_id: String[str[16]]
    frozen_price: float
    hedge_flag: pykungfu.longfist.enums.HedgeFlag
    insert_time: int
    instrument_id: String[str[32]]
    instrument_type: pykungfu.longfist.enums.InstrumentType
    is_swap: bool
    limit_price: float
    offset: pykungfu.longfist.enums.Offset
    order_id: int
    parent_id: int
    price_type: pykungfu.longfist.enums.PriceType
    side: pykungfu.longfist.enums.Side
    time_condition: pykungfu.longfist.enums.TimeCondition
    volume: float
    volume_condition: pykungfu.longfist.enums.VolumeCondition
    def __eq__(self, arg0: OrderInput) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class OrderStat:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 207
    ack_time: int
    avg_price: float
    input_time: int
    insert_time: int
    md_time: int
    order_id: int
    total_price: float
    total_volume: float
    trade_time: int
    def __eq__(self, arg0: OrderStat) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class OrderTrigger:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 210
    action_flag: pykungfu.longfist.enums.OrderTriggerFlag
    error_id: int
    error_msg: String[str[256]]
    exchange_id: String[str[16]]
    external_order_id: String[str[32]]
    external_trigger_id: String[str[32]]
    frozen_price: float
    hedge_flag: pykungfu.longfist.enums.HedgeFlag
    insert_time: int
    instrument_id: String[str[32]]
    instrument_type: pykungfu.longfist.enums.InstrumentType
    is_swap: bool
    limit_price: float
    offset: pykungfu.longfist.enums.Offset
    order_id: int
    price_type: pykungfu.longfist.enums.PriceType
    restore_time: int
    side: pykungfu.longfist.enums.Side
    status: pykungfu.longfist.enums.OrderStatus
    stop_price: float
    time_condition: pykungfu.longfist.enums.TimeCondition
    trading_day: String[str[16]]
    trigger_id: int
    trigger_type: pykungfu.longfist.enums.OrderTriggerType
    update_time: int
    volume: float
    volume_condition: pykungfu.longfist.enums.VolumeCondition
    def __eq__(self, arg0: OrderTrigger) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class OrderTriggerAction:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 211
    action_flag: pykungfu.longfist.enums.OrderActionFlag
    insert_time: int
    order_trigger_action_id: int
    trigger_id: int
    def __eq__(self, arg0: OrderTriggerAction) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class OrderTriggerActionError:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 212
    error_id: int
    error_msg: String[str[256]]
    external_trigger_id: String[str[32]]
    insert_time: int
    order_trigger_action_id: int
    trigger_id: int
    def __eq__(self, arg0: OrderTriggerActionError) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class OrderTriggerInput:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 209
    exchange_id: String[str[16]]
    frozen_price: float
    hedge_flag: pykungfu.longfist.enums.HedgeFlag
    insert_time: int
    instrument_id: String[str[32]]
    instrument_type: pykungfu.longfist.enums.InstrumentType
    is_swap: bool
    limit_price: float
    offset: pykungfu.longfist.enums.Offset
    price_type: pykungfu.longfist.enums.PriceType
    side: pykungfu.longfist.enums.Side
    stop_price: float
    time_condition: pykungfu.longfist.enums.TimeCondition
    trigger_id: int
    trigger_type: pykungfu.longfist.enums.OrderTriggerType
    volume: float
    volume_condition: pykungfu.longfist.enums.VolumeCondition
    def __eq__(self, arg0: OrderTriggerInput) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class OutputKey:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 701
    group: str
    location_uid: int
    mode: pykungfu.longfist.enums.mode
    name: str
    role: pykungfu.longfist.enums.location_role
    seed: int
    uid64: int
    def __eq__(self, arg0: OutputKey) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Position:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 103
    avg_open_price: float
    avg_open_price_today: float
    close_pnl: float
    close_price: float
    direction: pykungfu.longfist.enums.Direction
    exchange_id: String[str[16]]
    frozen_total: float
    frozen_yesterday: float
    holder_uid: int
    instrument_id: String[str[32]]
    instrument_type: pykungfu.longfist.enums.InstrumentType
    last_price: float
    ledger_category: pykungfu.longfist.enums.LedgerCategory
    margin: float
    open_volume: float
    position_cost_price: float
    position_pnl: float
    pre_close_price: float
    pre_settlement_price: float
    realized_pnl: float
    settlement_price: float
    source_id: int
    source_op_id: int
    static_yesterday: float
    unrealized_pnl: float
    update_time: int
    volume: float
    yesterday_volume: float
    def __eq__(self, arg0: Position) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class PositionEnd:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 104
    holder_uid: int
    def __eq__(self, arg0: PositionEnd) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Quote:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 401
    ask_price: list[float[10]]
    ask_volume: list[float[10]]
    bid_price: list[float[10]]
    bid_volume: list[float[10]]
    close_price: float
    data_time: int
    exchange_id: String[str[16]]
    high_price: float
    instrument_id: String[str[32]]
    instrument_type: pykungfu.longfist.enums.InstrumentType
    iopv: float
    last_price: float
    low_price: float
    lower_limit_price: float
    open_interest: float
    open_price: float
    pre_close_price: float
    pre_open_interest: float
    pre_settlement_price: float
    settlement_price: float
    total_ask_volume: float
    total_bid_volume: float
    total_trade_num: int
    trading_phase_code: String[str[8]]
    turnover: float
    upper_limit_price: float
    volume: float
    def __eq__(self, arg0: Quote) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Register:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10101
    checkin_time: int
    group: str
    last_active_time: int
    location_uid: int
    mode: pykungfu.longfist.enums.mode
    name: str
    pid: int
    role: pykungfu.longfist.enums.location_role
    seed: int
    uid64: int
    def __eq__(self, arg0: Register) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class RequestCachedDone:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10209
    dest_id: int
    def __eq__(self, arg0: RequestCachedDone) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class RequestHistoryOrder:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 301
    query_num: int
    trigger_time: int
    def __eq__(self, arg0: RequestHistoryOrder) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class RequestHistoryOrderError:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 305
    error_id: int
    error_msg: String[str[256]]
    trigger_time: int
    def __eq__(self, arg0: RequestHistoryOrderError) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class RequestHistoryTrade:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 302
    query_num: int
    trigger_time: int
    def __eq__(self, arg0: RequestHistoryTrade) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class RequestHistoryTradeError:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 306
    error_id: int
    error_msg: String[str[256]]
    trigger_time: int
    def __eq__(self, arg0: RequestHistoryTradeError) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class RequestReadFrom:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10301
    from_time: int
    page_size: int
    source_id: int
    def __eq__(self, arg0: RequestReadFrom) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class RequestReadFromOthers:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10309
    dest_id: int
    from_time: int
    page_size: int
    source_id: int
    def __eq__(self, arg0: RequestReadFromOthers) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class RequestReadFromPublic:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10302
    from_time: int
    page_size: int
    source_id: int
    def __eq__(self, arg0: RequestReadFromPublic) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class RequestReadFromSync:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10303
    from_time: int
    page_size: int
    source_id: int
    def __eq__(self, arg0: RequestReadFromSync) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class RequestWriteTo:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10304
    dest_id: int
    page_size: int
    def __eq__(self, arg0: RequestWriteTo) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class RequestWriteToBand:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10307
    group: str
    location_uid: int
    mode: pykungfu.longfist.enums.mode
    name: str
    page_size: int
    role: pykungfu.longfist.enums.location_role
    seed: int
    uid64: int
    def __eq__(self, arg0: RequestWriteToBand) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class RiskSetting:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10202
    group: str
    location_uid: int
    mode: pykungfu.longfist.enums.mode
    name: str
    risk_check: bool
    risk_name: str
    role: pykungfu.longfist.enums.location_role
    seed: int
    self_deal_check_type: ...
    uid64: int
    value: str
    def __eq__(self, arg0: RiskSetting) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Session:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10103
    begin_time: int
    data_size: int
    end_time: int
    frame_count: int
    group: str
    location_uid: int
    mode: pykungfu.longfist.enums.mode
    name: str
    role: pykungfu.longfist.enums.location_role
    seed: int
    uid64: int
    update_time: int
    def __eq__(self, arg0: Session) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class StrategyStateUpdate:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10104
    info_a: str
    info_b: str
    info_c: str
    state: pykungfu.longfist.enums.StrategyState
    update_time: int
    value: str
    def __eq__(self, arg0: StrategyStateUpdate) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class SyntheticData:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 601
    key: str
    tag_a: str
    tag_b: str
    tag_c: str
    update_time: int
    value: str
    def __eq__(self, arg0: SyntheticData) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class TimeKeyValue:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10602
    key: str
    tag_a: str
    tag_b: str
    tag_c: str
    update_time: int
    value: str
    def __eq__(self, arg0: TimeKeyValue) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class TimeRequest:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10501
    base_time: int
    duration: int
    id: int
    location_uid: int
    repeat: int
    def __eq__(self, arg0: TimeRequest) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class TimeReset:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10502
    steady_clock_count: int
    system_clock_count: int
    def __eq__(self, arg0: TimeReset) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class TimeValue:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10601
    tag_a: str
    tag_b: str
    tag_c: str
    update_time: int
    value: str
    def __eq__(self, arg0: TimeValue) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Trade:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 203
    commission: float
    contract_id: String[str[64]]
    exchange_id: String[str[16]]
    external_order_id: String[str[32]]
    external_trade_id: String[str[32]]
    hedge_flag: pykungfu.longfist.enums.HedgeFlag
    instrument_id: String[str[32]]
    instrument_type: pykungfu.longfist.enums.InstrumentType
    offset: pykungfu.longfist.enums.Offset
    order_id: int
    parent_order_id: int
    price: float
    restore_time: int
    side: pykungfu.longfist.enums.Side
    tax: float
    trade_id: int
    trade_time: int
    trading_day: String[str[16]]
    volume: float
    def __eq__(self, arg0: Trade) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class TradingDay:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 10503
    timestamp: int
    def __eq__(self, arg0: TradingDay) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Transaction:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 403
    ask_no: int
    bid_no: int
    biz_index: int
    data_time: int
    exchange_id: String[str[16]]
    exec_type: pykungfu.longfist.enums.ExecType
    instrument_id: String[str[32]]
    instrument_type: pykungfu.longfist.enums.InstrumentType
    main_seq: int
    price: float
    seq: int
    side: pykungfu.longfist.enums.Side
    volume: float
    def __eq__(self, arg0: Transaction) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class Tree:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 404
    ask_depth: int
    ask_price: list[float[10]]
    ask_volume: list[float[10]]
    ask_weighted_avg_price: float
    bid_depth: int
    bid_price: list[float[10]]
    bid_volume: list[float[10]]
    bid_weighted_avg_price: float
    close_price: float
    data_time: int
    exchange_id: String[str[16]]
    high_price: float
    instrument_id: String[str[32]]
    instrument_type: pykungfu.longfist.enums.InstrumentType
    last_price: float
    low_price: float
    lower_limit_price: float
    open_price: float
    pre_close_price: float
    total_ask_volume: float
    total_bid_volume: float
    trade_num: int
    trading_phase_code: String[str[8]]
    turnover: float
    upper_limit_price: float
    volume: float
    def __eq__(self, arg0: Tree) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class frame_header:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 0
    carrier_type: int
    data_type: pykungfu.longfist.enums.FrameDataType
    dest: int
    frame_uid: int
    gen_time: int
    header_length: int
    initial_source: int
    length: int
    source: int
    stream_id: int
    trigger_frame_uid: int
    trigger_time: int
    def __eq__(self, arg0: frame_header) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
class page_header:
    __has_data__: typing.ClassVar[bool] = True
    __tag__: typing.ClassVar[int] = 1
    frame_header_length: int
    last_frame_position: int
    page_header_length: int
    page_size: int
    status: pykungfu.longfist.enums.PageStatus
    version: int
    def __eq__(self, arg0: page_header) -> bool:
        ...
    def __hash__(self) -> int:
        ...
    @typing.overload
    def __init__(self) -> None:
        ...
    @typing.overload
    def __init__(self, arg0: str) -> None:
        ...
    def __parse__(self, arg0: str) -> None:
        ...
    def __repr__(self) -> str:
        ...
    @property
    def __uid__(self) -> int:
        ...
