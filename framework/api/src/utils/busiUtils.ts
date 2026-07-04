import dayjs from 'dayjs';

import { ARCHIVE_DIR, KF_HOME } from '../config/pathConfig';
import {
  EnterableSpecialWordsReg,
  SpecialWordsReg,
} from '../config/systemConfig';
import {
  InstrumentType,
  KfCategory,
  AppStateStatus,
  Side,
  Direction,
  HedgeFlag,
  PriceType,
  TimeCondition,
  VolumeCondition,
  ExchangeIds,
  FutureArbitrageCodes,
  CommissionMode,
  UnderweightType,
  PriceLevel,
  MarginSideConfig,
  Offset,
} from '../config/tradingConfig';
import {
  KfCategoryEnum,
  DirectionEnum,
  LedgerCategoryEnum,
  InstrumentTypeEnum,
  SideEnum,
  OffsetEnum,
  InstrumentTypes,
  KfCategoryTypes,
  LedgerCategoryTypes,
  ProcessStatusTypes,
  BrokerStateStatusTypes,
  PriceTypeEnum,
  BrokerStateStatusEnum,
  StrategyStateStatusTypes,
  StrategyStateStatusEnum,
  UnderweightEnum,
  HistoryDateEnum,
} from '../typings/enums';
import { kfLogger } from '../utils/logUtils';
import { formatNumberPrecision } from '../utils/decimalFormatter';
import {
  getProcessIdByKfLocation,
  deepClone,
  initFormTimePicker,
  dealMillionSencond2NanoSecond,
  dealDateDayOrMonth,
} from './commonUtils';
import {
  readRootPackageJsonSync,
  removeTargetFilesInFolder,
  removeTargetFoldersInFolder,
} from './fileUtils';
import minimist from 'minimist';
import { getGlobalStorage } from './globalStorage';
import { getKfGlobalSettingsValue } from '../config/globalSettings';

const globalStorage = getGlobalStorage();
interface SourceAccountId {
  source: string;
  id: string;
}

declare global {
  interface String {
    toAccountId(): string;
    parseSourceAccountId(): SourceAccountId;
    toSourceName(): string;
    toStrategyId(): string;
    toKfCategory(): string;
    toKfGroup(): string;
    toKfName(): string;
  }

  interface Number {
    kfRound(precision?: number): number;
    kfToFixed(precision?: number): string;
  }

  interface Array<T> {
    removeRepeat(): Array<T>;
    kfForEach(cb: <T>(t: T, index: number) => void): void;
    kfReverseForEach(cb: <T>(t: T, index: number) => void): void;
    kfForEachAsync(cb: <T>(t: T, index: number) => void): void;
  }
}

//for td processId
String.prototype.toAccountId = function (): string {
  if (this.indexOf('_') === -1) return this.toString();
  if (this.split('_').length !== 4) return this.toString();
  return this.split('_').slice(1).join('_');
};

//for md processId
String.prototype.toSourceName = function (): string {
  if (this.indexOf('_') === -1) return this.toString();
  if (this.split('_').length !== 4) return this.toString();
  return this.split('_')[1];
};

//for strategy processId
String.prototype.toStrategyId = function (): string {
  if (this.indexOf('_') === -1) return this.toString();
  if (this.split('_').length !== 3) return this.toString();
  return this.split('_')[1];
};

String.prototype.toKfCategory = function (): string {
  if (this.indexOf('_') === -1) return this.toString();
  if (this.split('_').length !== 4) return this.toString();
  return this.split('_')[0];
};

String.prototype.toKfGroup = function (): string {
  if (this.indexOf('_') === -1) return this.toString();
  if (this.split('_').length !== 4) return this.toString();
  return this.split('_')[1];
};

String.prototype.toKfName = function (): string {
  if (this.indexOf('_') === -1) return this.toString();
  if (this.split('_').length !== 4) return this.toString();
  return this.split('_')[2];
};

String.prototype.parseSourceAccountId = function (): SourceAccountId {
  const parseList = this.toString().split('_');
  //没有 "_"
  if (parseList.length !== 2 && parseList.length !== 3) {
    throw new Error(`${this} accountId format is wrong！`);
  } else {
    return {
      source: parseList[0],
      id: parseList[1],
    };
  }
};

Number.prototype.kfRound = function (precision = 0) {
  const temp = 10 ** (precision || 0);
  return Math.round(Number(this) * temp) / temp;
};

Number.prototype.kfToFixed = function (precision = 0) {
  return formatNumberPrecision(Number(this), precision);
};

Array.prototype.removeRepeat = function () {
  return Array.from(new Set(this));
};

Array.prototype.kfForEach = function (cb) {
  if (!cb) return;
  const self = this;
  const len = self.length;
  let i = 0;

  while (i < len) {
    cb.call(self, self[i], i);
    i++;
  }
};

Array.prototype.kfReverseForEach = function (cb) {
  if (!cb) return;
  const self = this;
  let i = self.length;
  while (i--) {
    cb.call(self, self[i], i);
  }
};

Array.prototype.kfForEachAsync = function (cb) {
  if (!cb) return;
  const self = this;
  const len = self.length;
  return new Promise((resolve) => {
    setImmediateIter(self, 0, len, cb, () => {
      resolve(true);
    });
  });
};

function setImmediateIter<T>(
  list: Array<T>,
  i: number,
  len: number,
  cb: (item: T, index: number) => void,
  fcb: AnyFunction,
) {
  if (i < len) {
    setImmediate(() => {
      cb(list[i], i);
      setImmediateIter(list, ++i, len, cb, fcb);
    });
  } else {
    fcb();
  }
}

export const getInstrumentTypeData = (
  instrumentType: InstrumentTypes,
): KungfuApi.KfTradeValueCommonData => {
  return InstrumentType[
    (InstrumentTypeEnum[instrumentType] as InstrumentTypeEnum) ||
      InstrumentTypeEnum.unknown
  ];
};

export const isTdMd = (category: KfCategoryTypes) => {
  if (category === 'td' || category === 'md') {
    return true;
  }

  return false;
};

export const isTd = (category: KfCategoryTypes) => {
  if (category === 'td') {
    return true;
  }

  return false;
};

export const isOperator = (category: KfCategoryTypes) => {
  if (category === 'operator') {
    return true;
  }

  return false;
};

export const isTdMdOperatorStrategy = (category: KfCategoryTypes) => {
  if (
    category === 'td' ||
    category === 'md' ||
    category === 'operator' ||
    category === 'strategy'
  ) {
    return true;
  }

  return false;
};

export const statTime = (name: string) => {
  if (process.env.NODE_ENV !== 'production') {
    console.time(name);
  }
};

export const statTimeEnd = (name: string) => {
  if (process.env.NODE_ENV !== 'production') {
    console.timeEnd(name);
  }
};

export const removeArchiveBeforeToday = (
  targetFolder: string,
): Promise<void> => {
  const today = dayjs();
  const year = today.year();
  const month = today.month() + 1;
  const day = today.date();
  const todayArchive = `KFA-${year}-${dealDateDayOrMonth(
    month,
  )}-${dealDateDayOrMonth(day)}.zip`;
  return removeTargetFilesInFolder(targetFolder, ['.zip'], [todayArchive]).then(
    (res) => {
      res.errors.forEach((err) => kfLogger.error(err));
    },
  );
};

export const removeTodayArchive = (targetFolder: string): Promise<void> => {
  const today = dayjs();
  const year = today.year();
  const month = today.month() + 1;
  const day = today.date();
  const todayArchive = `KFA-${year}-${dealDateDayOrMonth(
    month,
  )}-${dealDateDayOrMonth(day)}.zip`;
  return removeTargetFilesInFolder(targetFolder, [todayArchive]).then((res) => {
    res.errors.forEach((err) => kfLogger.error(err));
  });
};

export const removeJournal = (targetFolder: string): Promise<void> => {
  return removeTargetFilesInFolder(targetFolder, ['.journal']).then((res) => {
    res.errors.forEach((err) => kfLogger.error(err));
  });
};

export const removeDB = (targetFolder: string): Promise<void> => {
  return removeTargetFilesInFolder(targetFolder, ['.db'], ['config.db']).then(
    (res) => {
      res.errors.forEach((err) => kfLogger.error(err));
    },
  );
};

export const removeJournalIfNeed = (): Promise<void> => {
  const needClearJournal = !!globalStorage.getItem('needClearJournal');

  kfLogger.info('needClearJournal: ', needClearJournal);

  if (needClearJournal) {
    globalStorage.setItem('needClearJournal', false);
    kfLogger.info('Clear Journal Done', needClearJournal);
    return removeTodayArchive(ARCHIVE_DIR).then(() => removeJournal(KF_HOME));
  } else {
    return Promise.resolve();
  }
};

export const removeDBIfNeed = (): Promise<void> => {
  const needClearDB = !!globalStorage.getItem('needClearDB');

  kfLogger.info('needClearDB: ', needClearDB);

  if (needClearDB) {
    globalStorage.setItem('needClearDB', false);
    kfLogger.info('Clear DB Done');
    return removeDB(KF_HOME);
  } else {
    return Promise.resolve();
  }
};

export const getStateStatusData = (
  name: ProcessStatusTypes | undefined,
): KungfuApi.KfTradeValueCommonData | undefined => {
  return name === undefined ? undefined : AppStateStatus[name];
};

export const buildIdByPrimaryKeysFromKfConfigSettings = (
  kfConfigState: Record<string, KungfuApi.KfConfigValue>,
  keys: string[],
) => {
  return keys
    .map((key) => replaceNonAlphaNumericWithSpace(kfConfigState[key]))
    .filter((value) => value !== undefined)
    .join('-');
};

export const getPriceTypeConfig = (): Record<
  PriceTypeEnum,
  KungfuApi.KfTradeValueCommonData
> => {
  const rootPackageJson = readRootPackageJsonSync();
  const priceTypeConfig =
    rootPackageJson?.appConfig?.makeOrder?.priceTypeFilter ||
    ({} as Record<string, boolean>);
  const unsupportedPriceTypes = Object.keys(priceTypeConfig).filter((key) => {
    if (priceTypeConfig[key] === false && PriceTypeEnum[key] !== undefined) {
      return true;
    }
    return false;
  });

  return Object.keys(PriceTypeEnum)
    .filter((key) => Number.isNaN(+key))
    .filter((priceType) => !unsupportedPriceTypes.includes(priceType))
    .map((priceType) => PriceTypeEnum[priceType])
    .reduce((pre, enumValue: PriceTypeEnum) => {
      return { ...pre, ...{ [enumValue]: PriceType[enumValue] } };
    }, {});
};

export const getOffsetByOffsetFilter = (
  offsetKey: keyof typeof OffsetEnum,
  defaultOffset: OffsetEnum,
): OffsetEnum => {
  const rootPackageJson = readRootPackageJsonSync();
  const offsetConfig =
    rootPackageJson?.appConfig?.makeOrder?.offsetFilter ||
    ({} as Record<string, boolean>);
  return offsetConfig[offsetKey] !== false
    ? OffsetEnum[offsetKey]
    : defaultOffset;
};

export const getAbleHedgeFlag = (): boolean => {
  const rootPackageJson = readRootPackageJsonSync();
  const ableHedgeFlag = rootPackageJson?.appConfig?.makeOrder?.ableHedgeFlag;
  const ableHedgeFlagResolved =
    ableHedgeFlag == undefined ? true : ableHedgeFlag;
  return ableHedgeFlagResolved;
};

export const dealDateToNanotimeRange = (
  date: string | number,
  dateType = HistoryDateEnum.naturalDate,
): {
  from: bigint;
  to: bigint;
} | null => {
  const day = dayjs(date);
  if (!day.isValid()) return null;

  const dayOfWeek = day.day();
  const isTradingDay = dateType === HistoryDateEnum.tradingDate;

  const startTime = (
    isTradingDay
      ? day.add(dayOfWeek === 1 ? -3 : -1, 'day').hour(15) // last trading day 15:00
      : day.hour(0)
  )
    .minute(0)
    .second(0);
  const from = dealMillionSencond2NanoSecond(startTime.valueOf());
  const endTime = (isTradingDay ? day.hour(15) : day.add(1, 'day').hour(0))
    .minute(0)
    .second(0);
  const to = dealMillionSencond2NanoSecond(endTime.valueOf());

  return {
    from,
    to,
  };
};

export const resolveDirectionBySideAndOffset = (
  side: SideEnum,
  offset: OffsetEnum,
): DirectionEnum => {
  if (side === SideEnum.Buy) {
    return offset === OffsetEnum.Open
      ? DirectionEnum.Long
      : DirectionEnum.Short;
  } else if (side === SideEnum.Sell) {
    return offset === OffsetEnum.Open
      ? DirectionEnum.Short
      : DirectionEnum.Long;
  }

  return DirectionEnum.Long;
};

export const dealUnderweightType = (underweightType: UnderweightEnum) => {
  return UnderweightType[+underweightType as UnderweightEnum];
};

export const getKfCategoryData = (
  category: KfCategoryTypes,
): KungfuApi.KfTradeValueCommonData => {
  if (KfCategory[KfCategoryEnum[category]]) {
    return KfCategory[KfCategoryEnum[category]];
  }

  throw new Error(`Category ${category} is illegal`);
};

export const dealCategory = (
  category: KfCategoryTypes,
  extraCategory: Record<string, KungfuApi.KfTradeValueCommonData>,
): KungfuApi.KfTradeValueCommonData => {
  return KfCategory[KfCategoryEnum[category]] || extraCategory[category];
};

export const getOrderTradeFilterKey = (category: KfCategoryTypes): string => {
  if (category === 'td') {
    return 'source';
  } else if (category === 'strategy') {
    return 'dest';
  }

  return '';
};

export const getTradingDataSortKey = (
  typename: KungfuApi.TradingDataTypeName,
): string => {
  switch (typename) {
    case 'AlgoOrder':
      return 'insert_time';
    case 'Order':
      return 'insert_time';
    case 'Trade':
      return 'trade_time';
    case 'OrderInput':
      return 'insert_time';
    case 'AlgoOrderInput':
      return 'insert_time';
    case 'Position':
      return 'instrument_id';
    case 'Instrument':
      return 'instrument_id';
    default:
      return '';
  }
};

export const getLedgerCategory = (category: KfCategoryTypes): 0 | 1 => {
  if (category !== 'td' && category !== 'strategy') {
    return LedgerCategoryEnum.td;
  }

  return LedgerCategoryEnum[category as LedgerCategoryTypes];
};

export const dealAppStates = (
  watcher: KungfuApi.Watcher | null,
  appStates: Record<string, BrokerStateStatusEnum>,
): Record<string, BrokerStateStatusTypes> => {
  if (!watcher) {
    return {} as Record<string, BrokerStateStatusTypes>;
  }

  return Object.keys(appStates || {}).reduce((appStatesResolved, key) => {
    const kfLocation = watcher.getLocation(key);
    const processId = getProcessIdByKfLocation(kfLocation);
    const appStateValue = appStates[key];
    appStatesResolved[processId] = BrokerStateStatusEnum[
      appStateValue
    ] as BrokerStateStatusTypes;
    return appStatesResolved;
  }, {} as Record<string, BrokerStateStatusTypes>);
};

export const dealStrategyStates = (
  watcher: KungfuApi.Watcher | null,
  strategyStates: Record<string, KungfuApi.StrategyStateDataOrigin>,
): Record<string, KungfuApi.StrategyStateData> => {
  if (!watcher) {
    return {} as Record<string, KungfuApi.StrategyStateDataOrigin>;
  }

  return Object.keys(strategyStates || {}).reduce(
    (strategyStatesResolved, key) => {
      const kfLocation = watcher.getLocation(key);
      const processId = getProcessIdByKfLocation(kfLocation);
      const strategyStateValue = deepClone(strategyStates[key]);
      strategyStateValue.state = StrategyStateStatusEnum[
        strategyStateValue.state
      ] as StrategyStateStatusTypes;
      strategyStatesResolved[processId] =
        strategyStateValue as KungfuApi.StrategyStateData;
      return strategyStatesResolved;
    },
    {} as Record<string, KungfuApi.StrategyStateData>,
  );
};

export const dealAssetsByHolderUID = <T extends KungfuApi.Asset>(
  watcher: KungfuApi.Watcher | null,
  assets: KungfuApi.DataTable<T>,
): Record<string, T> => {
  if (!watcher) {
    return {} as Record<string, T>;
  }

  return Object.values(assets).reduce((assetsResolved, asset) => {
    const { holder_uid } = asset;
    const kfLocation = watcher.getLocation(holder_uid);

    if (kfLocation) {
      const processId = getProcessIdByKfLocation(kfLocation);
      assetsResolved[processId] = asset;
    }

    return assetsResolved;
  }, {} as Record<string, T>);
};

export const dealOrderTradingData = <T>(
  watcher: KungfuApi.Watcher,
  tradingData: KungfuApi.DataTable<T>,
  tradingDataTypeName: KungfuApi.TradingDataTypeName,
  kfLocation: KungfuApi.KfLocation,
): T[] => {
  const currentUID = watcher.getLocationUID(kfLocation);
  const orderTradeFilterKey = getOrderTradeFilterKey(kfLocation.category);
  const sortKey = getTradingDataSortKey(tradingDataTypeName);

  const afterFilterDatas = tradingData.filter(orderTradeFilterKey, currentUID);

  if (sortKey) {
    return afterFilterDatas.sort(sortKey);
  } else {
    return afterFilterDatas.list();
  }
};

export const dealLedgerTradingData = <T>(
  watcher: KungfuApi.Watcher,
  tradingData: KungfuApi.DataTable<T>,
  tradingDataTypeName: KungfuApi.TradingDataTypeName,
  kfLocation: KungfuApi.KfLocation,
): T[] => {
  const sortKey = getTradingDataSortKey(tradingDataTypeName);

  const { category } = kfLocation;
  const ledgerCategory = getLedgerCategory(category);
  const locationUID = watcher.getLocationUID(kfLocation);
  let dataTableResolved = tradingData;

  if (tradingDataTypeName === 'Position') {
    dataTableResolved = dataTableResolved.nofilter('volume', 0);
  }

  dataTableResolved = dataTableResolved
    .filter('ledger_category', ledgerCategory)
    .filter('holder_uid', locationUID);

  if (sortKey) {
    return dataTableResolved.sort(sortKey);
  }

  return dataTableResolved.list();
};

export const dealDefaultTradingData = <T>(
  ...args: [
    KungfuApi.Watcher,
    KungfuApi.DataTable<T>,
    KungfuApi.TradingDataTypeName,
    KungfuApi.KfLocation,
  ]
): T[] => {
  return args[1].list();
};

export const dealTradingDataMethodsMap: Record<
  KungfuApi.TradingDataTypeName,
  <T>(
    watcher: KungfuApi.Watcher,
    tradingData: KungfuApi.DataTable<T>,
    tradingDataTypeName: KungfuApi.TradingDataTypeName,
    kfLocation: KungfuApi.KfLocation,
  ) => T[]
> = {
  Asset: dealLedgerTradingData,
  Instrument: dealDefaultTradingData,
  InstrumentFactor: dealDefaultTradingData,
  AlgoOrder: dealDefaultTradingData,
  Order: dealOrderTradingData,
  AlgoOrderInput: dealDefaultTradingData,
  OrderInput: dealOrderTradingData,
  OrderStat: dealDefaultTradingData,
  Position: dealLedgerTradingData,
  Quote: dealDefaultTradingData,
  Trade: dealOrderTradingData,
  Basket: dealDefaultTradingData,
  BasketInstrument: dealDefaultTradingData,
  BasketOrder: dealDefaultTradingData,
  OrderTrigger: dealOrderTradingData,
  SyntheticData: dealDefaultTradingData,
};

export const dealTradingData = <T>(
  watcher: KungfuApi.Watcher | null,
  tradingData: KungfuApi.DataTable<T>,
  tradingDataTypeName: KungfuApi.TradingDataTypeName,
  kfLocation: KungfuApi.KfLocation,
): T[] => {
  if (!watcher) {
    throw new Error('Watcher is NULL');
  }

  return dealTradingDataMethodsMap[tradingDataTypeName]<T>(
    watcher,
    tradingData,
    tradingDataTypeName,
    kfLocation,
  );
};

export const getOffsetConfig = (): Record<
  PriceTypeEnum,
  KungfuApi.KfTradeValueCommonData
> => {
  const rootPackageJson = readRootPackageJsonSync();
  const offsetConfig =
    rootPackageJson?.appConfig?.makeOrder?.offsetFilter ||
    ({} as Record<string, boolean>);
  const unsupportedOffset = Object.keys(offsetConfig).filter((key) => {
    if (offsetConfig[key] === false && OffsetEnum[key] !== undefined) {
      return true;
    }
    return false;
  });

  return Object.keys(OffsetEnum)
    .filter((key) => Number.isNaN(+key))
    .filter((key) => key !== 'Unknown')
    .filter((offset) => !unsupportedOffset.includes(offset))
    .map((offset) => OffsetEnum[offset])
    .reduce((pre, enumValue: OffsetEnum) => {
      return { ...pre, ...{ [enumValue]: Offset[enumValue] } };
    }, {});
};

export const replaceNonAlphaNumericWithSpace = (
  value: KungfuApi.KfConfigValue,
) => {
  if (typeof value === 'string') {
    return value
      .replace(SpecialWordsReg, '')
      .replace(EnterableSpecialWordsReg, '');
  } else {
    return value;
  }
};

export const getCombineValueByPrimaryKeys = (
  primaryKeys: string[],
  formState: Record<string, KungfuApi.KfConfigValue>,
  extraValue = '',
) => {
  return [
    extraValue || '',
    ...primaryKeys.map((key) =>
      replaceNonAlphaNumericWithSpace(formState[key]),
    ),
  ]
    .filter((item) => item !== '')
    .join('-');
};

export const numberEnumRadioType: Record<
  string,
  Record<number, KungfuApi.KfTradeValueCommonData>
> = {
  hedgeFlag: HedgeFlag,
  direction: Direction,
  volumeCondition: VolumeCondition,
  timeCondition: TimeCondition,
  commissionMode: CommissionMode,
};

export const numberEnumSelectType: Record<
  string,
  Record<number, KungfuApi.KfTradeValueCommonData>
> = {
  priceType: PriceType,
  priceLevel: PriceLevel,
  instrumentType: InstrumentType,
  underweightType: UnderweightType,
};

export const enableCustomRadioType: Record<
  string,
  Record<string, KungfuApi.KfTradeValueCommonData>
> = {
  side: Side,
  marginSide: MarginSideConfig,
  offset: getOffsetConfig(),
};

export const stringEnumSelectType: Record<
  string,
  Record<string, KungfuApi.KfTradeValueCommonData>
> = {
  exchange: ExchangeIds,
  futureArbitrageCode: FutureArbitrageCodes,
};

export const KfConfigValueNumberType = [
  'int',
  'float',
  'percent',
  ...Object.keys(numberEnumSelectType || {}),
  ...Object.keys(numberEnumRadioType || {}),
  ...Object.keys(enableCustomRadioType || {}),
];

export const FormItemNeedIcon = [
  'str',
  'password',
  'int',
  'float',
  'percent',
  'side',
  'priceType',
  'priceLevel',
  'radio',
  'checkbox',
  'checkboxGroup',
  'select',
  'multiSelect',
  'instrument',
  'instruments',
  'contract',
  'td',
  'tds',
  'md',
  'md&operator',
  'operator',
  'strategy',
  'basket',
  'bool',
  ...Object.keys(numberEnumSelectType || {}),
  ...Object.keys(stringEnumSelectType || {}),
  ...Object.keys(numberEnumRadioType || {}),
  ...Object.keys(enableCustomRadioType || {}),
];

export const KfConfigValueBooleanType = ['bool', 'checkbox'];

export const KfConfigValueAnyType = ['select'];

export const KfConfigValueArrayType = [
  'tds',
  'files',
  'instruments',
  'instrumentsCsv',
  'table',
  'csvTable',
  'rangePicker',
  'multiSelect',
];

export const KfConfigValueTimeType = [
  'rangePicker',
  'dateTimePicker',
  'datePicker',
  'timePicker',
];

export const initFormStateByConfig = (
  configSettings: KungfuApi.KfConfigItem[],
  initValue?: Record<string, KungfuApi.KfConfigValue>,
): Record<string, KungfuApi.KfConfigValue> => {
  if (!configSettings) return {};
  const formState: Record<string, KungfuApi.KfConfigValue> = {};
  configSettings.forEach((item) => {
    const type = item.type;
    const isBoolean = KfConfigValueBooleanType.includes(type);
    const isNumber = KfConfigValueNumberType.includes(type);
    const isArray = KfConfigValueArrayType.includes(type);
    const isTime = KfConfigValueTimeType.includes(type);

    let defaultValue;

    const getDefaultValueByType = () => {
      return isBoolean
        ? false
        : isNumber
        ? 0
        : isTime
        ? null
        : isArray
        ? []
        : '';
    };

    if (typeof item?.default === 'object') {
      defaultValue = JSON.parse(JSON.stringify(item?.default));
    } else {
      defaultValue = item?.default;
    }

    const initItemValue = (initValue || {})[item.key];
    const ifCanCoverDefault =
      item?.default === undefined || item.default === null
        ? true
        : typeof initItemValue === typeof item?.default;
    if (
      initItemValue !== undefined &&
      initItemValue !== item?.default &&
      ifCanCoverDefault
    ) {
      defaultValue = initItemValue;
    }

    if (defaultValue === undefined) {
      defaultValue = getDefaultValueByType();
    }

    if (KfConfigValueBooleanType.includes(type)) {
      defaultValue =
        defaultValue === 'true'
          ? true
          : defaultValue === 'false'
          ? false
          : !!defaultValue;
    } else if (KfConfigValueNumberType.includes(type)) {
      defaultValue = +defaultValue;
    } else if (KfConfigValueArrayType.includes(type)) {
      if (typeof defaultValue === 'string') {
        try {
          defaultValue = JSON.parse(defaultValue);
        } catch (err) {
          defaultValue = [];
        }
      }
    } else if (KfConfigValueTimeType.includes(type)) {
      defaultValue = initFormTimePicker(defaultValue);
    }

    formState[item.key] = defaultValue;
  });

  return formState;
};

export const fromProcessArgsToKfConfigItems = (
  args: string[],
): Record<string, KungfuApi.KfConfigValue> => {
  const taskArgs = minimist(args)['a'] || '{}';
  const data = JSON.parse(taskArgs);
  return data;
};

export const isBrokerStateReady = (state: BrokerStateStatusTypes) => {
  return state === 'Ready' || state === 'Idle';
};

export function deleteNNFiles(rootPathName = KF_HOME) {
  kfLogger.info('Deleting nn folder');
  return removeTargetFoldersInFolder(rootPathName, ['nn']).then((res) => {
    if (res.successes.length) {
      kfLogger.info(`Succeed delete 'nn' folders: ${res.successes.join(', ')}`);
    }
    res.errors.forEach((err) => kfLogger.error(err));
    kfLogger.info('Deleting nn folder finished');
  });
}

export const isUpdateVersionLogicEnable = () => {
  const packageJson = readRootPackageJsonSync();
  return !!packageJson?.kungfuCraft?.autoUpdate?.update;
};

export const isCheckVersionLogicEnable = () => {
  const updateVersionLogicEnable = isUpdateVersionLogicEnable();
  const globalSetting = getKfGlobalSettingsValue();
  return updateVersionLogicEnable && !!globalSetting?.update?.isCheckVersion;
};

export const ifTodayFirstStart = () => {
  const lastStartDateTime = globalStorage.getItem('lastStartDateTime');
  if (lastStartDateTime) {
    const dateDayjs = dayjs(lastStartDateTime);
    if (dateDayjs.isValid()) {
      const todayDayjs = dayjs();
      return (
        dateDayjs.isSame(todayDayjs, 'year') &&
        dateDayjs.isSame(todayDayjs, 'month') &&
        !dateDayjs.isSame(todayDayjs, 'day')
      );
    }
  }
  return true;
};
