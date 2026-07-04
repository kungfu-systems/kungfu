import { kfLogger } from '../utils/logUtils';
import {
  UnfinishedOrderStatus,
  T0InstrumentTypes,
  T0ExchangeIds,
  ExchangeIds,
  AllFinishedOrderStatus,
  Direction,
  Currency,
  HedgeFlag,
  InstrumentType,
  Offset,
  OrderStatus,
  PriceType,
  Side,
  TimeCondition,
  VolumeCondition,
  ShotableInstrumentTypes,
  OrderTriggerStatus,
  TriggerFlag,
  PriceLevel,
  CommissionMode,
  InstrumentMinOrderVolume,
  ExportTradingDataColumnsToFilter,
  showVolumeSideTypes,
  CryptoInstrumentTypes,
  InstrumentPrecision,
} from '../config/tradingConfig';
import {
  DirectionEnum,
  HedgeFlagEnum,
  OffsetEnum,
  OrderStatusEnum,
  PriceTypeEnum,
  SideEnum,
  TimeConditionEnum,
  VolumeConditionEnum,
  OrderTriggerStatusEnum,
  OrderTriggerFlag,
  PriceLevelEnum,
  CommissionModeEnum,
} from '../typings/enums';
import VueI18n, { useLanguage } from '../language';
import {
  dealKfNumber,
  dealLocationUID,
  setTimerPromiseTask,
  getIdByKfLocation,
  getMdTdKfLocationByProcessId,
  getResultUntilValuable,
  dealKfDecimalPrecision,
  DEFAULT_PRECISION,
  countDecimalPlaces,
  doSomethingWithDataSliced,
} from '../utils/commonUtils';
import {
  HistoryDateEnum,
  InstrumentTypeEnum,
  CurrencyEnum,
  OrderActionFlagEnum,
  OrderTriggerTypeEnum,
} from '../typings/enums';
import dayjs, { Dayjs } from 'dayjs';
import {
  kf,
  history,
  longfist,
  hashInstrumentUKey,
  dealKfTime,
} from '@kungfu-tech/api/kungfu';
import { T0T1Config } from '../typings/global';

import { readRootPackageJsonSync } from '@kungfu-tech/api/utils/fileUtils';
import { buildMasterLocation } from '@kungfu-tech/api/utils/systemUtils';
import BTree from 'sorted-btree';

const { t } = VueI18n.global;

kfLogger.info('Load kungfu node');
type DayjsWithBusinessDays = Dayjs & { isBusinessDay: () => boolean };

export const getT0Config = (): {
  instrumentTypes: InstrumentTypeEnum[];
  exchangeIds: string[];
} => {
  const rootPackageJson = readRootPackageJsonSync();
  const T0Config =
    rootPackageJson?.appConfig?.T0T1?.T0 || ({} as T0T1Config['T0']);
  const instrumentTypes = (
    Array.isArray(T0Config.instrumentTypes) ? T0Config.instrumentTypes : []
  ).map((item) => InstrumentTypeEnum[item]);
  const exchangeIds = Array.isArray(T0Config.exchangeIds)
    ? T0Config.exchangeIds
    : [];
  return {
    instrumentTypes,
    exchangeIds,
  };
};

export const isT0 = (
  instrumentType: InstrumentTypeEnum,
  exchangeId?: string,
): boolean => {
  const { instrumentTypes, exchangeIds } = getT0Config();
  return (
    (instrumentType
      ? [...T0InstrumentTypes, ...instrumentTypes].includes(instrumentType)
      : false) ||
    (exchangeId
      ? [...T0ExchangeIds, ...exchangeIds].includes(exchangeId)
      : false)
  );
};

export const isStock = (instrumentType: InstrumentTypeEnum) => {
  switch (instrumentType) {
    case InstrumentTypeEnum.stock:
    case InstrumentTypeEnum.stockoption:
    case InstrumentTypeEnum.techstock:
    case InstrumentTypeEnum.bond:
    case InstrumentTypeEnum.fund:
    case InstrumentTypeEnum.index:
    case InstrumentTypeEnum.repo:
      return true;
    default:
      return false;
  }
};

export const isShotable = (instrumentType: InstrumentTypeEnum): boolean => {
  return instrumentType
    ? ShotableInstrumentTypes.includes(instrumentType)
    : false;
};

export const isShowPosition = (side: SideEnum): boolean => {
  return showVolumeSideTypes.includes(side);
};

export const kfFormatTime = (
  nano: bigint,
  format = '%m/%d %H:%M:%S.%N',
): string => {
  return kf.formatTime(nano, format);
};

export const getNanoDateString = (
  nano: bigint,
  i = 6,
  lastSplit = 0,
): string => {
  let formattedTime = kfFormatTime(nano);

  formattedTime = formattedTime.slice(i);

  if (lastSplit !== 0) {
    formattedTime = formattedTime.slice(0, -1 * lastSplit);
  }

  return formattedTime;
};

export const resolveAccountId = (
  watcher: KungfuApi.Watcher | null,
  source: number,
  dest: number,
): KungfuApi.KfTradeValueCommonData => {
  if (!watcher) return { color: 'default', name: '--' };

  const accountId = dealLocationUID(watcher, source);
  const destLocation: KungfuApi.KfLocation = watcher.getLocation(dest);

  if (destLocation && destLocation.group === 'node') {
    return {
      color: 'orange',
      name: `${accountId} ${t('手动')}`,
    };
  }

  return {
    color: 'text',
    name: accountId,
  };
};

export const getAccountIdStyle = (name: string): string => {
  if (name.includes(`${t('手动')}`)) {
    return '#D87A16';
  }
  return '#ffffffd9';
};

export const resolveClientId = (
  watcher: KungfuApi.Watcher | null,
  dest: number,
): KungfuApi.KfTradeValueCommonData => {
  if (!watcher) return { color: 'default', name: '--' };

  if (dest === 0) {
    return { color: 'default', name: t('系统外') };
  }

  const destLocation: KungfuApi.KfLocation = watcher.getLocation(dest);
  if (!destLocation) return { color: 'default', name: '--' };
  const destUname = getIdByKfLocation(destLocation);

  if (destLocation.group === 'node') {
    return { color: 'orange', name: t('手动') };
  } else {
    return { color: 'text', name: destUname };
  }
};

export const dealTradingDataItem = (
  item: KungfuApi.TradingDataTypes,
  watcher: KungfuApi.Watcher | null,
  isShowOrigin = false,
): Record<string, string | number | bigint> => {
  const itemResolved = { ...item } as Record<string, string | number | bigint>;
  const instrument_type =
    'instrument_type' in item
      ? item.instrument_type
      : InstrumentTypeEnum.unknown;
  const isInstrumnetShotable = isShotable(instrument_type);

  if ('order_id' in item) {
    itemResolved.order_id = item.order_id.toString();
  }

  if ('trade_id' in item) {
    itemResolved.trade_id = item.trade_id.toString();
  }

  if ('instrument_id' in item) {
    itemResolved.instrument_id = item.instrument_id.toString();
  }

  if ('trade_time' in item && !isShowOrigin) {
    itemResolved.trade_time = dealKfTime(item.trade_time, true);
  }
  if ('insert_time' in item && !isShowOrigin) {
    itemResolved.insert_time = dealKfTime(item.insert_time, true);
  }
  if ('update_time' in item && !isShowOrigin) {
    itemResolved.update_time = dealKfTime(item.update_time, true);
  }
  if ('restore_time' in item && !isShowOrigin) {
    itemResolved.restore_time = dealKfTime(item.restore_time, true);
  }
  if ('direction' in item) {
    itemResolved.direction = dealDirection(item.direction).name;
  }
  if ('side' in item) {
    itemResolved.side = dealSide(item.side).name;
  }
  if ('offset' in item) {
    if (isInstrumnetShotable) {
      itemResolved.offset = dealOffset(item.offset).name;
    } else {
      delete itemResolved.offset;
    }
  }
  if ('status' in item) {
    itemResolved.status = dealOrderStatus(
      item.status,
      item.error_msg || '',
    ).name;
  }
  if ('price_type' in item) {
    itemResolved.price_type = dealPriceType(item.price_type).name;
  }

  if ('volume_condition' in item) {
    if (isInstrumnetShotable) {
      itemResolved.volume_condition = dealVolumeCondition(
        item.volume_condition,
      ).name;
    } else {
      delete itemResolved.volume_condition;
    }
  }

  if ('time_condition' in item) {
    if (isInstrumnetShotable) {
      itemResolved.time_condition = dealTimeCondition(item.time_condition).name;
    } else {
      delete itemResolved.time_condition;
    }
  }

  if ('instrument_type' in item) {
    itemResolved.instrument_type = dealInstrumentType(
      item.instrument_type,
    ).name;
  }
  if ('hedge_flag' in item) {
    if (isInstrumnetShotable) {
      itemResolved.hedge_flag = dealHedgeFlag(item.hedge_flag).name;
    } else {
      delete itemResolved.hedge_flag;
    }
  }
  if ('is_swap' in item) {
    if (isInstrumnetShotable) {
      itemResolved.is_swap = dealIsSwap(item.is_swap).name;
    } else {
      delete itemResolved.is_swap;
    }
  }
  if ('source' in item && 'dest' in item && watcher) {
    itemResolved.source = resolveAccountId(
      watcher,
      item.source,
      item.dest,
    ).name;
  }
  if ('dest' in item && watcher) {
    itemResolved.dest = resolveClientId(watcher, item.dest).name;
  }
  if ('holder_uid' in item && watcher) {
    itemResolved.holder_uid = dealLocationUID(watcher, item.holder_uid);
  }

  if ('currency' in item) {
    itemResolved.currency = dealCurrency(item.currency).name;
  }
  return itemResolved;
};

export const getKungfuDataByDateRange = (
  watcher: KungfuApi.Watcher,
  date: number | string,
  dateType = HistoryDateEnum.naturalDate, //0 natural date, 1 tradingDate
): Promise<KungfuApi.TradingData | Record<string, unknown>> => {
  const targetDate = dayjs(date).format('YYYY-MM-DD');
  const yesterdayDate = dayjs(date).add(-1, 'day').format('YYYY-MM-DD');
  const isYesterdayBusinessDay = (
    dayjs(date).add(-1, 'day') as DayjsWithBusinessDays
  ).isBusinessDay();
  const fridayDate = dayjs(date).add(-3, 'day').format('YYYY-MM-DD');
  let from =
    dateType == HistoryDateEnum.naturalDate
      ? dayjs(targetDate).format('YYYY-MM-DD HH:mm:ss')
      : isYesterdayBusinessDay
        ? dayjs(yesterdayDate).format('YYYY-MM-DD HH:mm:ss')
        : dayjs(fridayDate).format('YYYY-MM-DD HH:mm:ss');
  let to = dayjs(targetDate).add(1, 'day').format('YYYY-MM-DD HH:mm:ss');

  if (dateType == HistoryDateEnum.tradingDate) {
    from = dayjs(from).add(16, 'hour').format('YYYY-MM-DD HH:mm:ss');
    to = dayjs(to).add(-8, 'hour').format('YYYY-MM-DD HH:mm:ss');
  }

  kfLogger.info(
    'is yesterday bussiness day',
    yesterdayDate,
    isYesterdayBusinessDay,
  );
  kfLogger.info('Export data', from, to);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      //by trading date
      promiseWithCachedPause(watcher, () =>
        getResultUntilValuable(() => history.selectPeriod(from, to)),
      ).then((res) => {
        const kungfuDataToday = res;

        if (!kungfuDataToday) return reject(new Error('database_locked'));

        resolve(kungfuDataToday);
        clearTimeout(timer);
      });
    }, 160);
  });
};

export const getKungfuHistoryData = (
  watcher: KungfuApi.Watcher,
  date: string,
  dateType: HistoryDateEnum,
  tradingDataTypeName: KungfuApi.TradingDataTypeName | 'all',
  kfLocation?: KungfuApi.KfLocation,
): Promise<{
  tradingData: KungfuApi.TradingData;
}> => {
  return getKungfuDataByDateRange(watcher, date, dateType).then(
    (tradingData: KungfuApi.TradingData | Record<string, unknown>) => {
      if (tradingDataTypeName === 'all') {
        return {
          tradingData: tradingData as KungfuApi.TradingData,
        };
      }

      if (!kfLocation) {
        return {
          tradingData: tradingData as KungfuApi.TradingData,
        };
      }

      return {
        tradingData: tradingData as KungfuApi.TradingData,
      };
    },
  );
};

export const kfRequestMarketData = (
  watcher: KungfuApi.Watcher | null,
  exchangeId: string,
  instrumentId: string,
  mdLocation: KungfuApi.KfLocation,
): Promise<boolean> => {
  if (!watcher) {
    return Promise.reject(new Error('Watcher is NULL'));
  }

  if (!watcher.isLive()) {
    return Promise.reject(new Error(`Watcher is not live`));
  }

  if (!watcher.isReadyToInteract(mdLocation)) {
    const sourceId = getIdByKfLocation(mdLocation);
    return Promise.reject(new Error(`Md ${sourceId} not ready`));
  }

  return Promise.resolve(
    watcher.requestMarketData(mdLocation, exchangeId, instrumentId),
  );
};

export const kfCancelOrder = (
  watcher: KungfuApi.Watcher | null,
  order: KungfuApi.Order,
  orderActionFlag: OrderActionFlagEnum,
): Promise<bigint> => {
  if (!watcher) {
    return Promise.reject(new Error(`Watcher is NULL`));
  }

  if (!watcher.isLive()) {
    return Promise.reject(new Error(`Watcher is not live`));
  }

  const { order_id, dest, source } = order;
  const sourceLocation = watcher.getLocation(source);
  const destLocation = watcher.getLocation(dest);

  if (!watcher.isReadyToInteract(sourceLocation)) {
    const accountId = getIdByKfLocation(sourceLocation);
    return Promise.reject(new Error(`Td ${accountId} not ready`));
  }

  const orderAction: KungfuApi.OrderAction = {
    ...longfist.types.OrderAction(),
    action_flag: orderActionFlag,
    order_id,
  };

  if (!destLocation) {
    return Promise.resolve(watcher.cancelOrder(orderAction, sourceLocation));
  }

  return Promise.resolve(
    watcher.cancelOrder(orderAction, sourceLocation, destLocation),
  );
};

export const kfCancelOrderTrigger = (
  watcher: KungfuApi.Watcher | null,
  order: KungfuApi.OrderTriggerResolved,
  tdLocation: KungfuApi.KfLocation,
): Promise<bigint> => {
  if (!watcher) {
    return Promise.reject(new Error(`Watcher is NULL`));
  }

  if (!watcher.isLive()) {
    return Promise.reject(new Error(`Watcher is not live`));
  }

  const { source, trigger_id } = order;
  const sourceLocation = watcher.getLocation(source);

  if (!watcher.isReadyToInteract(tdLocation)) {
    const accountId = getIdByKfLocation(tdLocation);
    return Promise.reject(new Error(`Td ${accountId} not ready`));
  }

  const orderAction: KungfuApi.OrderTriggerAction = {
    ...longfist.types.OrderTriggerAction(),
    trigger_id,
  };

  return Promise.resolve(
    watcher.cancelOrderTrigger(orderAction, sourceLocation),
  );
};

export const kfCancelOrderUtilFinished = (
  watcher: KungfuApi.Watcher,
  order: KungfuApi.Order,
) => {
  return new Promise<KungfuApi.Order>((resolve, reject) => {
    if (!UnfinishedOrderStatus.includes(order.status)) return resolve(order);

    kfCancelOrder(watcher, order, OrderActionFlagEnum.Cancel)
      .then(() => {
        const { clearLoop } = setTimerPromiseTask(() => {
          const targetOrder = (watcher as KungfuApi.Watcher).ledger.Order[
            order.uid_key
          ];
          if (
            targetOrder &&
            AllFinishedOrderStatus.includes(targetOrder.status)
          ) {
            clearLoop();
            resolve(targetOrder);
          }
          return Promise.resolve();
        }, 160);
      })
      .catch((err) => reject(err));
  });
};

export const DEFAULT_SPLIT_CANCEL_ORDER = 5000;

export const kfCancelAllOrders = (
  watcher: KungfuApi.Watcher | null,
  orders: KungfuApi.Order[],
): Promise<bigint[]> => {
  if (!watcher) {
    return Promise.reject(new Error(`Watcher is NULL`));
  }

  if (!watcher.isLive()) {
    return Promise.reject(new Error(`Watcher is not live`));
  }

  return new Promise((resolve, reject) => {
    let completedBatches = 0;
    const expectedBatches = Math.ceil(
      orders.length / DEFAULT_SPLIT_CANCEL_ORDER,
    );
    const results: bigint[][] = new Array(expectedBatches);

    doSomethingWithDataSliced<KungfuApi.Order>(
      orders,
      (orderSlice, sliceIndex) => {
        Promise.all(
          orderSlice.map((order) =>
            kfCancelOrder(watcher, order, OrderActionFlagEnum.Cancel),
          ),
        )
          .then((batchResults) => {
            results[sliceIndex] = batchResults;
            completedBatches++;
            if (completedBatches >= expectedBatches) {
              resolve(results.flat());
            }
          })
          .catch((error) => {
            reject(error);
          });
      },
      DEFAULT_SPLIT_CANCEL_ORDER,
    );
  });
};

export const kfCancelAllOrdersTrigger = (
  watcher: KungfuApi.Watcher | null,
  orders: KungfuApi.OrderTriggerResolved[],
  tdLocation: KungfuApi.KfLocation,
): Promise<bigint[]> => {
  if (!watcher) {
    return Promise.reject(new Error(`Watcher is NULL`));
  }

  if (!watcher.isLive()) {
    return Promise.reject(new Error(`Watcher is not live`));
  }

  if (!watcher.isReadyToInteract(tdLocation)) {
    const accountId = getIdByKfLocation(tdLocation);
    return Promise.reject(new Error(`Td ${accountId} not ready`));
  }

  const cancelOrderTasks = orders.map(
    (item: KungfuApi.OrderTriggerResolved): Promise<bigint> => {
      return kfCancelOrderTrigger(watcher, item, tdLocation);
    },
  );

  return Promise.all(cancelOrderTasks);
};

export const kfMakeOrder = (
  watcher: KungfuApi.Watcher | null,
  makeOrderInput: KungfuApi.MakeOrderInput,
  tdLocation: KungfuApi.KfLocation,
  strategyLocation?: KungfuApi.KfLocation,
): Promise<bigint> => {
  if (!watcher) {
    return Promise.reject(new Error('Watcher is NULL'));
  }

  if (!watcher.isLive()) {
    return Promise.reject(new Error(`Watcher is not live`));
  }

  if (!watcher.isReadyToInteract(tdLocation)) {
    const accountId = getIdByKfLocation(tdLocation);
    return Promise.reject(new Error(`Td ${accountId} not ready`));
  }

  const now = watcher.now();
  const orderInput: KungfuApi.OrderInput = {
    ...longfist.types.OrderInput(),
    ...makeOrderInput,
    block_id: BigInt(0),
    limit_price: makeOrderInput.limit_price || 0,
    frozen_price: makeOrderInput.limit_price || 0,
    volume: makeOrderInput.volume,
    insert_time: now,
  };

  if (strategyLocation) {
    //设置orderInput的parentid, 来标记该order为策略手动下单
    return Promise.resolve(
      watcher.issueOrder(orderInput, tdLocation, strategyLocation),
    );
  } else {
    return Promise.resolve(watcher.issueOrder(orderInput, tdLocation));
  }
};

export const kfOrderTrigger = (
  watcher: KungfuApi.Watcher | null,
  makeOrderTriggerInput: KungfuApi.MakeOrderTriggerInput,
  tdLocation: KungfuApi.KfLocation,
): Promise<bigint> => {
  if (!watcher) {
    return Promise.reject(new Error('Watcher is NULL'));
  }

  if (!watcher.isLive()) {
    return Promise.reject(new Error(`Watcher is not live`));
  }

  if (!watcher.isReadyToInteract(tdLocation)) {
    const accountId = getIdByKfLocation(tdLocation);
    return Promise.reject(new Error(`Td ${accountId} not ready`));
  }

  const now = watcher.now();
  const orderTriggerInput: KungfuApi.OrderTriggerInput = {
    ...longfist.types.OrderTriggerInput(),
    ...makeOrderTriggerInput,
    limit_price: makeOrderTriggerInput.limit_price || 0,
    volume: makeOrderTriggerInput.volume,
    insert_time: now,
    trigger_type: OrderTriggerTypeEnum.ParkedOrder,
  };

  return Promise.resolve(
    watcher.issueOrderTrigger(orderTriggerInput, tdLocation),
  );
};

export const kfRefreshOrderTrigger = (
  watcher: KungfuApi.Watcher | null,
  msgType: number,
  tdLocation: KungfuApi.KfLocation,
): Promise<boolean> => {
  if (!watcher) {
    return Promise.reject(new Error('Watcher is NULL'));
  }

  if (!watcher.isLive()) {
    return Promise.reject(new Error(`Watcher is not live`));
  }

  return Promise.resolve(watcher.issueMark(msgType, tdLocation));
};
export const kfMakeBlockOrder = async (
  watcher: KungfuApi.Watcher | null,
  blockMessage: KungfuApi.BlockMessage,
  makeOrderInput: KungfuApi.MakeOrderInput,
  tdLocation: KungfuApi.KfLocation,
  strategyLocation?: KungfuApi.KfLocation,
): Promise<bigint> => {
  if (!watcher) {
    return Promise.reject(new Error('Watcher is NULL'));
  }

  if (!watcher.isLive()) {
    return Promise.reject(new Error(`Watcher is not live`));
  }

  if (!watcher.isReadyToInteract(tdLocation)) {
    const accountId = getIdByKfLocation(tdLocation);
    return Promise.reject(new Error(`Td ${accountId} not ready`));
  }

  let block_id;
  if (blockMessage) {
    blockMessage = {
      ...blockMessage,
      is_specific: !!blockMessage.is_specific,
      match_number: BigInt(blockMessage.match_number),
      insert_time: watcher.now(),
    };
    block_id = await watcher.issueBlockMessage(blockMessage, tdLocation);
  }
  if (!block_id) {
    return Promise.reject(new Error('Get block_id failed'));
  }

  const now = watcher.now();
  const orderInput: KungfuApi.OrderInput = {
    ...longfist.types.OrderInput(),
    ...makeOrderInput,
    block_id,
    limit_price: makeOrderInput.limit_price || 0,
    frozen_price: makeOrderInput.limit_price || 0,
    volume: makeOrderInput.volume,
    insert_time: now,
  };

  if (strategyLocation) {
    //设置orderInput的parentid, 来标记该order为策略手动下单
    return Promise.resolve(
      watcher.issueOrder(orderInput, tdLocation, strategyLocation),
    );
  } else {
    return Promise.resolve(watcher.issueOrder(orderInput, tdLocation));
  }
};

export const makeOrderByOrderTriggerInput = (
  watcher: KungfuApi.Watcher | null,
  orderInput: KungfuApi.MakeOrderTriggerInput,
  kfLocation: KungfuApi.KfLocation,
  accountId: string,
): Promise<bigint> => {
  return new Promise((resolve, reject) => {
    if (!watcher) {
      reject(new Error(`Watcher is NULL`));
      return;
    }

    if (kfLocation.category === 'td') {
      return kfOrderTrigger(watcher, orderInput, kfLocation)
        .then((order_id) => {
          resolve(order_id);
        })
        .catch((err) => {
          reject(err);
        });
    } else {
      const tdLocation = getMdTdKfLocationByProcessId(`td_${accountId || ''}`);
      if (!tdLocation) {
        reject(new Error('下单账户信息错误'));
        return;
      }
      return kfOrderTrigger(watcher, orderInput, tdLocation)
        .then((order_id) => {
          resolve(order_id);
        })
        .catch((err) => {
          reject(err);
        });
    }
  });
};

export const makeOrderByOrderInput = (
  watcher: KungfuApi.Watcher | null,
  orderInput: KungfuApi.MakeOrderInput,
  kfLocation: KungfuApi.KfLocation,
  accountId: string,
): Promise<bigint> => {
  return new Promise((resolve, reject) => {
    if (!watcher) {
      reject(new Error(`Watcher is NULL`));
      return;
    }

    if (kfLocation.category === 'td') {
      return kfMakeOrder(watcher, orderInput, kfLocation)
        .then((order_id) => {
          resolve(order_id);
        })
        .catch((err) => {
          reject(err);
        });
    } else if (kfLocation.category === 'strategy') {
      const tdLocation = getMdTdKfLocationByProcessId(`td_${accountId || ''}`);
      if (!tdLocation) {
        reject(new Error('下单账户信息错误'));
        return;
      }
      return kfMakeOrder(watcher, orderInput, tdLocation, kfLocation)
        .then((order_id) => {
          resolve(order_id);
        })
        .catch((err) => {
          reject(err);
        });
    } else {
      const tdLocation = getMdTdKfLocationByProcessId(`td_${accountId || ''}`);
      if (!tdLocation) {
        reject(new Error('下单账户信息错误'));
        return;
      }
      return kfMakeOrder(watcher, orderInput, tdLocation)
        .then((order_id) => {
          resolve(order_id);
        })
        .catch((err) => {
          reject(err);
        });
    }
  });
};

export const makeOrderByBlockMessage = (
  watcher: KungfuApi.Watcher | null,
  blockMessage: KungfuApi.BlockMessage,
  orderInput: KungfuApi.MakeOrderInput,
  kfLocation: KungfuApi.KfLocation,
  accountId: string,
): Promise<bigint> => {
  return new Promise((resolve, reject) => {
    if (!watcher) {
      reject(new Error(`Watcher is NULL`));
      return;
    }

    if (kfLocation.category === 'td') {
      return kfMakeBlockOrder(watcher, blockMessage, orderInput, kfLocation)
        .then((order_id) => {
          resolve(order_id);
        })
        .catch((err) => {
          reject(err);
        });
    } else if (kfLocation.category === 'strategy') {
      const tdLocation = getMdTdKfLocationByProcessId(`td_${accountId || ''}`);
      if (!tdLocation) {
        reject(new Error('下单账户信息错误'));
        return;
      }
      return kfMakeBlockOrder(
        watcher,
        blockMessage,
        orderInput,
        tdLocation,
        kfLocation,
      )
        .then((order_id) => {
          resolve(order_id);
        })
        .catch((err) => {
          reject(err);
        });
    } else {
      const tdLocation = getMdTdKfLocationByProcessId(`td_${accountId || ''}`);
      if (!tdLocation) {
        reject(new Error('下单账户信息错误'));
        return;
      }
      return kfMakeBlockOrder(watcher, blockMessage, orderInput, tdLocation)
        .then((order_id) => {
          resolve(order_id);
        })
        .catch((err) => {
          reject(err);
        });
    }
  });
};

export const makeOrderByBasketInstruments = (
  watcher: KungfuApi.Watcher | null,
  parentId: bigint,
  basketOrderInput: KungfuApi.BasketOrderInput,
  basketInstruments: KungfuApi.BasketInstrumentForOrder[],
  tdLocation: KungfuApi.KfLocation,
) => {
  if (!watcher) {
    return Promise.reject(new Error(`Watcher is NULL`));
  }

  if (!watcher.isLive()) {
    return Promise.reject(new Error(`Watcher is not live`));
  }

  if (!watcher.isReadyToInteract(tdLocation)) {
    const accountId = getIdByKfLocation(tdLocation);
    return Promise.reject(new Error(`Td ${accountId} not ready`));
  }

  const makeOrderTasks = basketInstruments.map((basketInstrument) => {
    const makeOrderInput: KungfuApi.MakeOrderInput = {
      ...longfist.types.OrderInput(),
      parent_id: parentId,
      instrument_id: `${basketInstrument.instrument_id}`,
      exchange_id: `${basketInstrument.exchange_id}`,
      instrument_type: +basketInstrument.instrument_type,
      side: +basketInstrument.sideResolved,
      offset: +basketInstrument.offsetResolved,
      price_type: +basketOrderInput.price_type,
      limit_price: +basketInstrument.priceResolved || 0,
      volume: basketInstrument.volumeResolved,
    };

    return kfMakeOrder(
      watcher,
      makeOrderInput,
      tdLocation,
      basketInstrument.strategyLocation,
    );
  });

  return Promise.all(makeOrderTasks);
};

export const makeOrderByBasketTrade = (
  watcher: KungfuApi.Watcher | null,
  basket: KungfuApi.Basket,
  basketOrderInput: KungfuApi.BasketOrderInput,
  basketInstruments: KungfuApi.BasketInstrumentForOrder[],
  kfLocation: KungfuApi.KfLocation,
) => {
  if (!watcher) {
    return Promise.reject(new Error(`Watcher is NULL`));
  }

  if (!watcher.isLive()) {
    return Promise.reject(new Error(`Watcher is not live`));
  }

  if (!watcher.isReadyToInteract(kfLocation)) {
    const accountId = getIdByKfLocation(kfLocation);
    return Promise.reject(new Error(`Td ${accountId} not ready`));
  }

  if (!basketInstruments.length) return Promise.resolve();

  const now = watcher.now();
  const basketOrder: KungfuApi.BasketOrder = {
    ...longfist.types.BasketOrder(),
    parent_id: BigInt(basket.id),
    insert_time: now,
    side: +basketOrderInput.side,
    price_type: +basketOrderInput.price_type,
    price_level: +basketOrderInput.price_level,
    price_offset: +basketOrderInput.price_offset,
  };

  const parent_id = watcher.issueBasketOrder(basketOrder, kfLocation);

  return makeOrderByBasketInstruments(
    watcher,
    parent_id,
    basketOrderInput,
    basketInstruments,
    kfLocation,
  );
};

export const promiseWithCachedPause = <T>(
  watcher: KungfuApi.Watcher,
  promiseFunc: () => Promise<T>,
  delay = 200,
): Promise<T> => {
  return new Promise((resolve, reject) => {
    const masterLocation = buildMasterLocation();

    let keyCachedPause = 10253;
    let keyCachedResume = 10254;
    for (const key in longfist.msgTypes) {
      const item = longfist.msgTypes[key];
      if (item === 'CachedPause') {
        keyCachedPause = Number(key);
      } else if (item === 'CachedResume') {
        keyCachedResume = Number(key);
      }
    }

    watcher.issueMark(keyCachedPause, masterLocation);
    setTimeout(() => {
      promiseFunc()
        .then((res) => {
          resolve(res);
        })
        .catch((err) => {
          reject(err);
        })
        .finally(() => {
          watcher.issueMark(keyCachedResume, masterLocation);
        });
    }, delay);
  });
};

export const getOrderLatencyDataByOrderStat = (
  order: KungfuApi.Order,
  orderStats: KungfuApi.DataTable<KungfuApi.OrderStat>,
) => {
  const precision = getPrecisionByInstrumentType(order.instrument_type);
  const latencyData = dealOrderStat(orderStats, order.uid_key) || {
    latencySystem: '--',
    latencyNetwork: '--',
    avg_price: 0,
  };
  return {
    latency_system: latencyData.latencySystem,
    latency_network: latencyData.latencyNetwork,
    avg_price: dealKfDecimalPrecision(latencyData.avg_price, precision),
    avg_price_resolved: dealKfNumber(latencyData.avg_price, precision),
  };
};

export const getOrderStatResolved = (
  orderStat: KungfuApi.OrderStat | null,
  precision = DEFAULT_PRECISION,
): {
  latency_system: string | number;
  latency_network: string | number;
  latency_trade: string | number;
  trade_time: bigint;
  avg_price: number;
} | null => {
  if (!orderStat) {
    return null;
  }

  const { insert_time, ack_time, md_time, trade_time } = orderStat;
  const latency_trade =
    trade_time && ack_time
      ? Number(Number(trade_time - ack_time) / 1000).kfToFixed(0)
      : '--';
  const latency_network =
    ack_time && insert_time
      ? Number(Number(ack_time - insert_time) / 1000).kfToFixed(0)
      : '--';
  const latency_system =
    insert_time && md_time
      ? Number(Number(insert_time - md_time) / 1000).kfToFixed(0)
      : '--';

  return {
    latency_system,
    latency_network,
    latency_trade,
    trade_time: orderStat.trade_time,
    avg_price: dealKfDecimalPrecision(orderStat.avg_price, precision),
  };
};

export const DEFAULT_LIST_LENGTH = 10000;

export const getOrderOrTradeListFromTradingDataKeeper = ({
  watcher,
  tradingDataKeeper,
  currentGlobalKfLocation,
  isGetUnfinishedOrder = false,
  type = 'order',
}: {
  watcher: KungfuApi.Watcher | null;
  tradingDataKeeper: KungfuApi.TradingDataKeeper;
  currentGlobalKfLocation:
    | KungfuApi.KfLocation
    | KungfuApi.KfLocationGroup
    | KungfuApi.KfConfig
    | null;
  isGetUnfinishedOrder?: boolean;
  type?: 'order' | 'trade';
}) => {
  let list: (KungfuApi.OrderResolved | KungfuApi.TradeResolved)[] = [];
  let locationId = '';
  let tdChildrenLocationIdList: number[] = [];

  if (!currentGlobalKfLocation) return [];

  switch (currentGlobalKfLocation?.category) {
    case 'globalPos':
      locationId = getIdByKfLocation(currentGlobalKfLocation);
      if (isGetUnfinishedOrder && type === 'order') {
        list = tradingDataKeeper[type].filter((item) => {
          const instrumentId = `${item.exchange_id}_${item.instrument_id}`;
          return instrumentId === locationId;
        }, 'unfinished');
      } else {
        list = tradingDataKeeper[type].filter((item) => {
          const instrumentId = `${item.exchange_id}_${item.instrument_id}`;
          return instrumentId === locationId;
        }, 'common');
      }
      break;
    case 'td':
    case 'strategy':
      locationId = window.watcher.getLocationUID(currentGlobalKfLocation);
      const indexMap =
        tradingDataKeeper[type][currentGlobalKfLocation.category][locationId];
      if (indexMap) {
        if (isGetUnfinishedOrder && type === 'order') {
          list = indexMap.getUnfinishedList();
        } else {
          list = indexMap.getCommonList();
        }
      }
      break;
    case 'tdGroup':
      tdChildrenLocationIdList = [];
      const locationList = (
        currentGlobalKfLocation as KungfuApi.KfLocationGroup
      ).children;
      if (locationList) {
        locationList.forEach((location) => {
          const locationId =
            location.location_uid ||
            (watcher ? watcher.getLocationUID(location) : '');
          if (locationId && tradingDataKeeper[type].td[locationId]) {
            tdChildrenLocationIdList.push(locationId);
          }
        });
      }

      if (!tdChildrenLocationIdList.length) return [];

      const tree = tdChildrenLocationIdList.reduce(
        (prev, locationId, index) => {
          const indexMap = tradingDataKeeper[type].td[locationId];
          if (indexMap) {
            if (isGetUnfinishedOrder && type === 'order') {
              const curTree = indexMap.getUnfinishedTree();
              const entries = [...curTree.entries()];
              return index === 0 ? curTree : prev.withPairs(entries, true);
            } else {
              const curTree = indexMap.getCommonTree();
              const entries = [...curTree.entries()];
              return index === 0 ? curTree : prev.withPairs(entries, true);
            }
          }
          return prev;
        },
        new BTree<unknown, KungfuApi.OrderResolved | KungfuApi.TradeResolved>(),
      );
      list =
        isGetUnfinishedOrder && type === 'order'
          ? tree.valuesArray() || []
          : tree.valuesArray()?.slice(0, DEFAULT_LIST_LENGTH) || [];

      break;
  }

  return list;
};

export const getOrderResolved = (
  watcher: KungfuApi.Watcher,
  order: KungfuApi.Order,
  orderStats: KungfuApi.OrderStat | null,
  orderStatResolved?: {
    latency_system: string | number;
    latency_network: string | number;
    avg_price: number;
  } | null,
): KungfuApi.OrderResolved => {
  const ukey = hashInstrumentUKey(order.instrument_id, order.exchange_id);
  const instrument = watcher.ledger.Instrument[ukey];
  const tickPrecision = countDecimalPlaces(instrument?.price_tick || 0);
  const precision = getPrecisionByInstrumentType(order.instrument_type);
  const latencyData = getOrderStatResolved(orderStats, precision);
  const destResolvedData = resolveClientId(watcher, order.dest);
  const sourceResolvedData = resolveAccountId(
    watcher,
    order.source,
    order.dest,
  );
  const statusData = dealOrderStatus(order.status, order.error_msg);

  return {
    ...order,
    ...latencyData,
    volume: dealKfDecimalPrecision(order.volume, precision),
    volume_left: dealKfDecimalPrecision(order.volume_left, precision),
    source: order.source,
    dest: order.dest,
    uid_key: order.uid_key,
    source_uname: sourceResolvedData.name,
    dest_uname: destResolvedData.name,
    status_uname: statusData.name,
    limit_price_resolved: dealKfNumber(order.limit_price, precision),
    limit_price: dealKfDecimalPrecision(order.limit_price, precision),
    frozen_price: dealKfDecimalPrecision(order.frozen_price, precision),
    avg_price_resolved: latencyData
      ? dealKfNumber(latencyData.avg_price, tickPrecision || precision)
      : (orderStatResolved?.avg_price ?? '--'),
    status_resolved: {
      name: statusData.name,
      color: statusData.color || 'default',
    },
    latency_system: latencyData
      ? latencyData.latency_system
      : orderStatResolved?.latency_system || '--',
    latency_network: latencyData
      ? latencyData.latency_network
      : orderStatResolved?.latency_network || '--',
  } as unknown as KungfuApi.OrderResolved;
};

export const getTradeResolved = (
  watcher: KungfuApi.Watcher,
  trade: KungfuApi.Trade,
): KungfuApi.TradeResolved => {
  const destResolvedData = resolveClientId(watcher, trade.dest);
  const sourceResolvedData = resolveAccountId(
    watcher,
    trade.source,
    trade.dest,
  );
  const precision = getPrecisionByInstrumentType(trade.instrument_type);
  return {
    ...trade,
    volume: dealKfDecimalPrecision(trade.volume, precision),
    source: trade.source,
    dest: trade.dest,
    uid_key: trade.uid_key,
    source_resolved_data: sourceResolvedData,
    dest_resolved_data: destResolvedData,
    source_uname: sourceResolvedData.name,
    dest_uname: destResolvedData.name,
    price_resolved: dealKfNumber(trade.price, precision),
  } as unknown as KungfuApi.TradeResolved;
};

export const dealOrder = (
  watcher: KungfuApi.Watcher,
  order: KungfuApi.Order,
): KungfuApi.OrderResolvedWithoutStat => {
  const sourceResolvedData = resolveAccountId(
    watcher,
    order.source,
    order.dest,
  );
  const precision = getPrecisionByInstrumentType(order.instrument_type);
  const destResolvedData = resolveClientId(watcher, order.dest);
  const statusData = dealOrderStatus(order.status, order.error_msg);
  return {
    ...order,
    volume: dealKfDecimalPrecision(order.volume, precision),
    volume_left: dealKfDecimalPrecision(order.volume_left, precision),
    source: order.source,
    dest: order.dest,
    uid_key: order.uid_key,
    source_resolved_data: sourceResolvedData,
    dest_resolved_data: destResolvedData,
    source_uname: sourceResolvedData.name,
    dest_uname: destResolvedData.name,
    status_uname: statusData.name,
    status_color: statusData.color || 'default',
    status_resolved: statusData,
    update_time_resolved: dealKfTime(order.update_time, true),
    limit_price_resolved: dealKfNumber(order.limit_price, precision) + '',
    limit_price: dealKfDecimalPrecision(order.limit_price, precision),
    frozen_price: dealKfDecimalPrecision(order.frozen_price, precision),
  };
};

export const dealOrderTrigger = (
  watcher: KungfuApi.Watcher,
  order: KungfuApi.OrderTrigger,
  index: number,
): KungfuApi.OrderTriggerResolved => {
  const precision = getPrecisionByInstrumentType(order.instrument_type);
  const sourceResolvedData = resolveAccountId(
    watcher,
    order.source,
    order.dest,
  );
  const destResolvedData = resolveClientId(watcher, order.dest);
  const statusData = dealOrderTriggerStatus(order.status);
  return {
    ...order,
    volume: dealKfDecimalPrecision(order.volume, precision),
    source: order.source,
    dest: order.dest,
    uid_key: order.uid_key,
    source_resolved_data: sourceResolvedData,
    dest_resolved_data: destResolvedData,
    source_uname: sourceResolvedData.name,
    dest_uname: destResolvedData.name,
    status_uname: statusData.name || '--',
    status_color: statusData.color || 'default',
    update_time_resolved: dealKfTime(order.update_time, true),
    insert_time_resolved:
      order.dest === 0 ? '--' : dealKfTime(order.insert_time, true),
    limit_price_resolved: dealKfNumber(order.limit_price, precision) + '',
    time_condition_resolved: dealTimeCondition(order.time_condition)
      ? dealTimeCondition(order.time_condition).name
      : '--',
    key: index + 1,
    action_flag_uname: dealTOrderTriggerFlag(order.action_flag).name,
  };
};

export const dealTrade = (
  watcher: KungfuApi.Watcher,
  trade: KungfuApi.Trade,
  orderStats: KungfuApi.DataTable<KungfuApi.OrderStat>,
): KungfuApi.TradeResolved => {
  const sourceResolvedData = resolveAccountId(
    watcher,
    trade.source,
    trade.dest,
  );
  const precision = getPrecisionByInstrumentType(trade.instrument_type);
  const destResolvedData = resolveClientId(watcher, trade.dest);
  const orderUKey = trade.order_id.toString(16).padStart(16, '0');
  const latencyData = dealOrderStat(orderStats, orderUKey) || {
    latencyTrade: '--',
    trade_time: BigInt(0),
  };
  return {
    ...trade,
    volume: dealKfDecimalPrecision(trade.volume, precision),
    source: trade.source,
    dest: trade.dest,
    uid_key: trade.uid_key,
    source_resolved_data: sourceResolvedData,
    dest_resolved_data: destResolvedData,
    source_uname: sourceResolvedData.name,
    dest_uname: destResolvedData.name,
    trade_time_resolved: dealKfTime(trade.trade_time, true),
    kf_time: latencyData.trade_time,
    kf_time_resovlved: dealKfTime(latencyData.trade_time, true),
    latency_trade: latencyData.latencyTrade,
    price_resolved: dealKfNumber(trade.price, precision),
  };
};

export const getPosClosableVolume = (position: KungfuApi.Position): number => {
  const precision = getPrecisionByInstrumentType(position.instrument_type);
  return isShotable(position.instrument_type) ||
    isT0(position.instrument_type, position.exchange_id)
    ? Math.max(
        dealKfDecimalPrecision(
          position.volume - position.frozen_total,
          precision,
        ),
        0,
      )
    : Math.max(
        dealKfDecimalPrecision(
          position.yesterday_volume - position.frozen_total,
          precision,
        ),
        0,
      );
};

export const dealPosition = (
  watcher: KungfuApi.Watcher,
  pos: KungfuApi.Position,
  instrumentName = '',
): KungfuApi.PositionResolved => {
  const precision = getPrecisionByInstrumentType(pos.instrument_type);
  const account_id_resolved = getIdByKfLocation(
    watcher.getLocation(pos.source_id),
  );
  const closable_volume = getPosClosableVolume(pos);
  const ukey = hashInstrumentUKey(pos.instrument_id, pos.exchange_id);
  const instrument = watcher.ledger.Instrument[ukey];
  const tickPrecision = countDecimalPlaces(instrument?.price_tick || 0);
  const currency =
    ((watcher.ledger.Instrument[ukey] as KungfuApi.Instrument) || null)
      ?.currency || CurrencyEnum.Unknown;
  return {
    ...pos,
    currency,
    closable_volume,
    uid_key: pos.uid_key, // 隐式属性，...pos 并不能结构
    account_id_resolved,
    instrument_id_resolved: `${pos.instrument_id} ${instrumentName} ${
      ExchangeIds[pos.exchange_id]?.name ?? ''
    }`,
    last_price_resolved: dealKfNumber(pos.last_price, precision),
    unrealized_pnl_resolved: pos.avg_open_price
      ? dealKfNumber(pos.unrealized_pnl, tickPrecision || precision)
      : '--',
    avg_open_price_resolved: dealKfDecimalPrecision(
      pos.avg_open_price,
      tickPrecision || precision,
    ),
    close_pnl: dealKfDecimalPrecision(pos.close_pnl, precision),
    position_cost_price: dealKfDecimalPrecision(
      pos.position_cost_price,
      precision,
    ),
    position_pnl: dealKfDecimalPrecision(pos.position_pnl, precision),
    pre_close_price: dealKfDecimalPrecision(pos.pre_close_price, precision),
    pre_settlement_price: dealKfDecimalPrecision(
      pos.pre_settlement_price,
      precision,
    ),
    realized_pnl: dealKfDecimalPrecision(pos.realized_pnl, precision),
    settlement_price: dealKfDecimalPrecision(pos.settlement_price, precision),
    unrealized_pnl: dealKfDecimalPrecision(pos.unrealized_pnl, precision),
    volume: dealKfDecimalPrecision(pos.volume, precision), // 数量
    yesterday_volume: dealKfDecimalPrecision(pos.yesterday_volume, precision), // 昨仓数量
    today_volume:
      dealKfDecimalPrecision(pos.volume, precision) -
      dealKfDecimalPrecision(pos.yesterday_volume, precision), // 今仓数量
    frozen_total: dealKfDecimalPrecision(pos.frozen_total, precision), // 冻结数量
    frozen_yesterday: dealKfDecimalPrecision(pos.frozen_yesterday, precision), // 冻结昨仓
    static_yesterday: dealKfDecimalPrecision(pos.static_yesterday, precision), // 固定昨仓数量
    open_volume: dealKfDecimalPrecision(pos.open_volume, precision), // 今开数量
    close_volume: dealKfDecimalPrecision(
      pos.open_volume + pos.static_yesterday - pos.volume,
      precision,
    ),
  };
};

export const dealDirection = (
  direction: DirectionEnum | number,
): KungfuApi.KfTradeValueCommonData => {
  return Direction[+direction as DirectionEnum];
};

export const dealCurrency = (currency: CurrencyEnum | number) => {
  return Currency[+currency as CurrencyEnum];
};

export const dealHedgeFlag = (
  hedgeFlag: HedgeFlagEnum | number,
): KungfuApi.KfTradeValueCommonData => {
  return HedgeFlag[+hedgeFlag as HedgeFlagEnum];
};

export const dealInstrumentType = (
  instrumentType: InstrumentTypeEnum | number,
): KungfuApi.KfTradeValueCommonData => {
  return InstrumentType[+instrumentType as InstrumentTypeEnum];
};

export const dealIsSwap = (isSwap: boolean) => {
  return { name: isSwap ? t('yes') : t('no') };
};

export const dealOffset = (
  offset: OffsetEnum | number,
): KungfuApi.KfTradeValueCommonData => {
  return Offset[+offset as OffsetEnum];
};

export const dealOrderStat = (
  orderStats: KungfuApi.DataTable<KungfuApi.OrderStat>,
  orderUKey: string,
): {
  latencySystem: string;
  latencyNetwork: string;
  latencyTrade: string;
  trade_time: bigint;
  avg_price: number;
} | null => {
  const orderStat = orderStats[orderUKey];
  if (!orderStat) {
    return null;
  }

  const { insert_time, ack_time, md_time, trade_time } = orderStat;
  const latencyTrade =
    trade_time && ack_time
      ? Number(Number(trade_time - ack_time) / 1000).kfToFixed(0)
      : '--';
  const latencyNetwork =
    ack_time && insert_time
      ? Number(Number(ack_time - insert_time) / 1000).kfToFixed(0)
      : '--';
  const latencySystem =
    insert_time && md_time
      ? Number(Number(insert_time - md_time) / 1000).kfToFixed(0)
      : '--';

  return {
    latencySystem,
    latencyNetwork,
    latencyTrade,
    trade_time: orderStat.trade_time,
    avg_price: orderStat.avg_price,
  };
};

export const dealOrderStatus = (
  status: OrderStatusEnum | number,
  errorMsg?: string,
): KungfuApi.KfTradeValueCommonData => {
  const data = { ...OrderStatus[+status as OrderStatusEnum] };

  if (!data.color) data.color = 'default';
  if (+status === OrderStatusEnum.Error && errorMsg) data.name = errorMsg;

  return data;
};

export const dealPriceType = (
  priceType: PriceTypeEnum | number,
): KungfuApi.KfTradeValueCommonData => {
  return PriceType[+priceType as PriceTypeEnum];
};

export const dealSide = (
  side: SideEnum | number,
): KungfuApi.KfTradeValueCommonData => {
  return Side[+side as SideEnum];
};

export const dealTimeCondition = (
  timeCondition: TimeConditionEnum | number,
): KungfuApi.KfTradeValueCommonData => {
  return TimeCondition[+timeCondition as TimeConditionEnum];
};

export const dealVolumeCondition = (
  volumeCondition: VolumeConditionEnum | number,
): KungfuApi.KfTradeValueCommonData => {
  return VolumeCondition[+volumeCondition as VolumeConditionEnum];
};

export const dealOrderTriggerStatus = (
  orderTriggerStatus: OrderTriggerStatusEnum | number,
): KungfuApi.KfTradeValueCommonData => {
  return OrderTriggerStatus[+orderTriggerStatus as OrderTriggerStatusEnum];
};

export const dealTOrderTriggerFlag = (
  orderTriggerFlag: OrderTriggerFlag | number,
): KungfuApi.KfTradeValueCommonData => {
  return TriggerFlag[+orderTriggerFlag as OrderTriggerFlag];
};

export const dealPriceLevel = (
  priceLevel: PriceLevelEnum | number,
): KungfuApi.KfTradeValueCommonData => {
  return PriceLevel[+priceLevel as PriceLevelEnum];
};

export const dealCommissionMode = (
  commissionMode: CommissionModeEnum | number,
): KungfuApi.KfTradeValueCommonData => {
  return CommissionMode[+commissionMode as CommissionModeEnum];
};
export const transformSearchInstrumentResultToInstrument = (
  instrumentStr: string,
): KungfuApi.InstrumentResolved | null => {
  const pair = instrumentStr.split('_');
  if (pair.length !== 5) return null;
  const [exchangeId, instrumentId, instrumentType, ukey, instrumentName] = pair;
  return {
    exchangeId,
    instrumentId,
    instrumentType: +instrumentType as InstrumentTypeEnum,
    instrumentName,
    id: `${instrumentId}_${instrumentName}_${exchangeId}`.toLowerCase(),
    ukey,
  };
};

export const dealByConfigItemType = (
  type: string,
  value: KungfuApi.KfConfigValue,
  options?: KungfuApi.KfSelectOption[],
): string => {
  switch (type) {
    case 'side':
      return dealSide(+value as SideEnum).name;
    case 'offset':
      return dealOffset(+value as OffsetEnum).name;
    case 'direction':
      return dealDirection(+value as DirectionEnum).name;
    case 'priceType':
      return dealPriceType(+value as PriceTypeEnum).name;
    case 'priceLevel':
      return dealPriceLevel(+value as PriceLevelEnum).name;
    case 'hedgeFlag':
      return dealHedgeFlag(+value as HedgeFlagEnum).name;
    case 'volumeCondition':
      return dealVolumeCondition(+value as VolumeConditionEnum).name;
    case 'timeCondition':
      return dealTimeCondition(+value as TimeConditionEnum).name;
    case 'commissionMode':
      return dealCommissionMode(+value as CommissionModeEnum).name;
    case 'instrumentType':
      return dealInstrumentType(+value as InstrumentTypeEnum).name;
    case 'instrument':
      const instrumentData = transformSearchInstrumentResultToInstrument(value);
      return instrumentData
        ? `${instrumentData.exchangeId} ${instrumentData.instrumentId} ${
            instrumentData.instrumentName || ''
          }`
        : value;
    case 'instruments':
      const instrumentDataList = (value as string[])
        .map((item) => transformSearchInstrumentResultToInstrument(item))
        .filter((item) => !!item) as KungfuApi.InstrumentResolved[];
      return instrumentDataList
        .map(
          (item) =>
            `${item.exchangeId} ${item.instrumentId} ${
              item.instrumentName || ''
            }`,
        )
        .join(' ');
    case 'select':
    case 'radio':
      if (!options?.length) return value;
      const { isLanguageKeyAvailable } = useLanguage();
      const label = options.filter((option) => option.value === value)[0]
        .label as string;
      return isLanguageKeyAvailable(label) ? t(label) : label;
    case 'bool':
      return value ? t('yes') : t('no');
    case 'percent':
      return `${value}%`;
    default:
      return value;
  }
};

export const kfConfigItemsToArgsByShowArgForShow = (
  settings: KungfuApi.KfConfigItem[],
  formState: Record<string, KungfuApi.KfConfigValue>,
): string => {
  const { isLanguageKeyAvailable } = useLanguage();
  return settings
    .filter((item) => item.showArg)
    .map((item) => ({
      label: isLanguageKeyAvailable(item.name) ? t(item.name) : item.name,
      value: dealByConfigItemType(item.type, formState[item.key], item.options),
    }))
    .map((item) => `${item.label} ${item.value}`)
    .join('; ');
};

// 处理下单时输入数据
export const dealOrderInputItem = (
  inputData: KungfuApi.MakeOrderInput,
  precision?: number,
): Record<string, KungfuApi.KfTradeValueCommonData> => {
  const orderInputResolved: Record<string, KungfuApi.KfTradeValueCommonData> =
    {};
  const isInstrumnetShotable = isShotable(inputData.instrument_type);
  for (const key in inputData) {
    if (key === 'instrument_type') {
      orderInputResolved[key] = dealInstrumentType(inputData.instrument_type);
    } else if (key === 'price_type') {
      orderInputResolved[key] = dealPriceType(inputData.price_type);
    } else if (key === 'side') {
      orderInputResolved[key] = dealSide(inputData.side);
    } else if (key === 'offset') {
      isInstrumnetShotable &&
        (orderInputResolved[key] = dealOffset(inputData.offset));
    } else if (key === 'hedge_flag') {
      isInstrumnetShotable &&
        (orderInputResolved[key] = dealHedgeFlag(inputData.hedge_flag));
    } else if (key === 'is_swap') {
      isInstrumnetShotable &&
        (orderInputResolved[key] = dealIsSwap(inputData.is_swap));
    } else if (key === 'limit_price') {
      orderInputResolved[key] = {
        name: dealKfNumber(inputData[key], precision || DEFAULT_PRECISION) + '',
        color: 'default',
      };
    } else {
      orderInputResolved[key] = {
        name: inputData[key],
        color: 'default',
      };
    }
  }
  return orderInputResolved;
};

export const dealVolumeByInstrumentType = (
  volume: number,
  instrumentType: InstrumentTypeEnum,
  quantityUnit = 0,
) => {
  const precision = getPrecisionByInstrumentType(instrumentType);
  const minOrderVolume =
    quantityUnit || InstrumentMinOrderVolume[instrumentType] || 1;
  const orderVolume = Math.max(volume, minOrderVolume);

  if (instrumentType === InstrumentTypeEnum.techstock) return orderVolume;

  if (!minOrderVolume) return dealKfDecimalPrecision(orderVolume, precision);

  const multiplier = Math.floor(orderVolume / minOrderVolume);
  const maxMultipleValue = minOrderVolume * multiplier;
  return dealKfDecimalPrecision(maxMultipleValue, precision);
};

export const buildTradingDataHeaders = (
  tradingDataType: KungfuApi.TradingDataTypeName,
  tradingData: KungfuApi.TradingDataTypes[],
) => {
  if (!tradingData[0]) return true;
  return [...Object.keys(tradingData[0]), 'source', 'dest'].filter(
    (key) => !ExportTradingDataColumnsToFilter[tradingDataType].includes(key),
  );
};

export const isCryptoInstrument = (
  instrumentType: InstrumentTypeEnum,
): boolean => {
  return CryptoInstrumentTypes.includes(instrumentType);
};

export const getPrecisionByInstrumentType = (
  instrumentType: InstrumentTypeEnum,
): number => {
  return InstrumentPrecision[instrumentType] || DEFAULT_PRECISION;
};
