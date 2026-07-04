import fse from 'fs-extra';
import {
  OrderInputKeyEnum,
  SpaceSizeSettingEnum,
  SpaceTabSettingEnum,
} from '../typings/enums';
import { KF_CONFIG_PATH, PY_WHL_DIR } from './pathConfig';
import {
  CodeSizeSetting,
  CodeTabSetting,
  OrderInputKeySetting,
} from './tradingConfig';
import { languageList, langDefault } from '@kungfu-tech/api/language';
import VueI18n from '@kungfu-tech/api/language';
import { readRootPackageJsonSync } from '@kungfu-tech/api/utils/fileUtils';
import { getDefaultHomeDir } from './homePathConfig';
import { booleanProcessEnv } from '@kungfu-tech/api/utils/commonUtils';
const { t } = VueI18n.global;
const ifCpusNumSafe = booleanProcessEnv(process.env.IF_CPUS_NUM_SAFE);

export interface KfSystemConfig {
  key: string;
  name: string;
  config: (KungfuApi.KfConfigItem & { for?: 'cli' | 'ui' | 'custom' })[]; //for配置项用于区分配置项是用于cli还是ui, 不配置默认适配cli和ui
}

const __python_version_resolved = __python_version
  ? [...__python_version.split('.').slice(0, 2), 'x'].join('.')
  : '3.9.x';

const packageJson = readRootPackageJsonSync();

const defaultHomeDir = getDefaultHomeDir();

export const getKfGlobalSettings = (): KfSystemConfig[] => [
  {
    key: 'system',
    name: t('globalSettingConfig.system'),
    config: [
      {
        key: 'homeDir',
        name: t('globalSettingConfig.home_dir'),
        tip: t('globalSettingConfig.home_dir_desc'),
        default: defaultHomeDir,
        type: 'directory',
      },
      {
        key: 'logLevel',
        name: t('globalSettingConfig.log_level'),
        tip: t('globalSettingConfig.for_all_log'),
        type: 'select',
        options: [
          { value: '-l trace', label: 'TRACE' },
          { value: '-l debug', label: 'DEBUG' },
          { value: '-l info', label: 'INFO' },
          { value: '-l warning', label: 'WARN' },
          { value: '-l error', label: 'ERROR' },
          { value: '-l critical', label: 'CRITICAL' },
        ],
        default: '-l info',
      },
      {
        key: 'logFrame',
        name: t('globalSettingConfig.log_frame'),
        tip: t('globalSettingConfig.log_frame_desc'),
        type: 'bool',
        default: false,
      },
      {
        key: 'language',
        name: t('globalSettingConfig.language'),
        tip: t('globalSettingConfig.select_language_desc'),
        type: 'select',
        options: languageList,
        default: langDefault,
      },
      {
        key: 'bypassArchive',
        name: t('globalSettingConfig.bypass_archive'),
        tip: t('globalSettingConfig.bypass_archive_desc'),
        type: 'bool',
        default: false,
      },
      {
        key: 'bypassArchiveDev',
        name: t('globalSettingConfig.bypass_archive_dev'),
        tip: t('globalSettingConfig.bypass_archive_dev_desc'),
        type: 'bool',
        default: false,
      },
      {
        key: 'verifyLocation',
        name: t('globalSettingConfig.verify_location'),
        tip: '',
        type: 'bool',
        default: false,
      },
      {
        key: 'bypassCached',
        name: t('globalSettingConfig.bypass_cacheD'),
        tip: t('globalSettingConfig.bypass_cacheD_desc'),
        type: 'bool',
        default: false,
      },
    ],
  },
  {
    key: 'performance',
    name: t('globalSettingConfig.porformance'),
    config: [
      {
        key: 'rocket',
        name: t('globalSettingConfig.rocket_model'),
        tip: t('globalSettingConfig.rocket_model_desc'),
        default: false,
        disabled: !ifCpusNumSafe,
        type: 'bool',
      },
      {
        key: 'bypassAccounting',
        name: t('globalSettingConfig.bypass_accounting'),
        tip: t('globalSettingConfig.bypass_accounting_desc'),
        default: !ifCpusNumSafe,
        type: 'bool',
      },
      {
        key: 'bypassTradingData',
        name: t('globalSettingConfig.bypass_trading_data'),
        tip: t('globalSettingConfig.bypass_trading_data_desc'),
        default: false,
        type: 'bool',
      },
      {
        key: 'bypassRefreshBook',
        name: t('globalSettingConfig.bypass_subscribe_position'),
        tip: t('globalSettingConfig.bypass_subscribe_position_desc'),
        default: !ifCpusNumSafe,
        type: 'bool',
      },
      {
        key: 'lowMemory',
        name: t('globalSettingConfig.low_memory'),
        tip: t('globalSettingConfig.low_memory_desc'),
        default: false,
        type: 'bool',
      },
    ],
  },
  {
    key: 'strategy',
    name: t('globalSettingConfig.strategy'),
    config: [
      {
        key: 'python',
        name: t('globalSettingConfig.use_local_python'),
        tip: t('globalSettingConfig.local_python_desc', {
          py_version: __python_version_resolved,
          whl_dir_path: PY_WHL_DIR,
        }),
        default: false,
        type: 'bool',
      },
      {
        key: 'pythonPath',
        name: t('globalSettingConfig.python_path'),
        tip: t('globalSettingConfig.python_path_desc'),
        default: '',
        type: 'file',
      },
    ],
  },
  {
    key: 'currency',
    name: t('globalSettingConfig.currency'),
    config: [
      {
        key: 'instrumentCurrency',
        name: t('globalSettingConfig.instrument_currency'),
        tip: t('globalSettingConfig.instrument_currency_desc'),
        default: true,
        type: 'bool',
      },
    ],
  },
  {
    key: 'trade',
    name: t('globalSettingConfig.trade'),
    config: [
      {
        key: 'sound',
        name: t('globalSettingConfig.sound'),
        tip: t('globalSettingConfig.use_sound'),
        default: false,
        type: 'bool',
        for: 'ui',
      },
      {
        key: 'fatFinger',
        name: t('globalSettingConfig.fat_finger_threshold'),
        tip: t('globalSettingConfig.set_fat_finger'),
        default: 0,
        type: 'percent',
        min: 0,
        for: 'ui',
      },
      {
        key: 'close',
        name: t('globalSettingConfig.close_threshold'),
        tip: t('globalSettingConfig.set_close_threshold'),
        default: 0,
        type: 'percent',
        for: 'ui',
      },
      {
        key: 'skipConfirmMakeOrder',
        name: t('globalSettingConfig.skip_confirm_make_order'),
        tip: t('globalSettingConfig.set_skip_confirm_make_order'),
        default: false,
        type: 'bool',
        for: 'ui',
      },
      {
        key: 'limit',
        name: t('globalSettingConfig.trade_limit'),
        tip: t('globalSettingConfig.set_trade_limit'),
        default: [],
        type: 'table',
        columns: [
          {
            key: 'instrument',
            name: t('tradeConfig.instrument_id'),
            type: 'instrument',
          },
          {
            key: 'orderInputKey',
            name: t('globalSettingConfig.order_input_key'),
            type: 'select',
            options: [
              {
                value: OrderInputKeyEnum.VOLUME,
                label: OrderInputKeySetting[OrderInputKeyEnum.VOLUME].name,
              },
              {
                value: OrderInputKeyEnum.PRICE,
                label: OrderInputKeySetting[OrderInputKeyEnum.PRICE].name,
              },
            ],
          },
          {
            key: 'limitValue',
            name: t('globalSettingConfig.limit_value'),
            default: 0,
            type: 'float',
          },
        ],
        for: 'ui',
      },
      {
        key: 'posTableColumns',
        name: t('globalSettingConfig.pos_table_columns'),
        type: 'checkboxGroup',
        options: [
          {
            value: 'static_yesterday',
            label: t('posGlobalConfig.static_yesterday_volume_setting'),
          },
          {
            value: 'yesterday_volume',
            label: t('posGlobalConfig.yesterday_volume_setting'),
          },
          {
            value: 'open_volume',
            label: t('posGlobalConfig.open_volume'),
          },
          {
            value: 'close_volume',
            label: t('posGlobalConfig.close_volume'),
          },
          {
            value: 'today_volume',
            label: t('posGlobalConfig.today_volume'),
          },
        ],
        default: ['yesterday_volume', 'today_volume'],
        for: 'ui',
      },
      {
        key: 'bypassSyncPosition',
        name: t('globalSettingConfig.skip_sync_position'),
        tip: t('globalSettingConfig.set_skip_sync_position'),
        type: 'bool',
        default: false,
      },
      {
        key: 'notAutoRestartTd',
        name: t('globalSettingConfig.not_auto_restart_td'),
        tip: t('globalSettingConfig.not_auto_restart_td_desc'),
        type: 'bool',
        default: false,
      },
    ],
  },
  {
    key: 'code',
    name: t('globalSettingConfig.code_editor'),
    config: [
      {
        key: 'tabSpaceType',
        name: t('globalSettingConfig.tab_space_type'),
        tip: t('globalSettingConfig.set_tab_space'),
        default: CodeTabSetting[SpaceTabSettingEnum.SPACES].name,
        type: 'select',
        options: [
          {
            value: SpaceTabSettingEnum.SPACES,
            label: CodeTabSetting[SpaceTabSettingEnum.SPACES].name,
          },
          {
            value: SpaceTabSettingEnum.TABS,
            label: CodeTabSetting[SpaceTabSettingEnum.TABS].name,
          },
        ],
        for: 'ui',
      },
      {
        key: 'tabSpaceSize',
        name: t('globalSettingConfig.tab_space_size'),
        tip: t('globalSettingConfig.set_tab_space_size'),
        default: CodeSizeSetting[SpaceSizeSettingEnum.FOURINDENT].name,
        type: 'select',
        options: [
          {
            value: SpaceSizeSettingEnum.TWOINDENT,
            label: CodeSizeSetting[SpaceSizeSettingEnum.TWOINDENT].name,
          },
          {
            value: SpaceSizeSettingEnum.FOURINDENT,
            label: CodeSizeSetting[SpaceSizeSettingEnum.FOURINDENT].name,
          },
        ],
        for: 'ui',
      },
    ],
  },
  ...(packageJson?.kungfuCraft?.autoUpdate?.update
    ? [
        {
          key: 'update',
          name: t('autoUpdater.update_version'),
          config: [
            {
              key: 'isCheckVersion',
              name: t('autoUpdater.is_check_version'),
              tip: t('autoUpdater.is_check_version_desc'),
              default: true,
              type: 'bool' as KungfuApi.KfConfigItemSupportedTypes,
            },
          ],
        },
      ]
    : []),
];

export const getKfGlobalSettingsValue = (): Record<
  string,
  Record<string, KungfuApi.KfConfigValue>
> => {
  if (!fse.existsSync(KF_CONFIG_PATH)) return {};

  return fse.readJSONSync(KF_CONFIG_PATH) as Record<
    string,
    Record<string, KungfuApi.KfConfigValue>
  >;
};

export const setKfGlobalSettingsValue = (
  value: Record<string, Record<string, KungfuApi.KfConfigValue>>,
) => {
  return Promise.resolve(fse.writeJSONSync(KF_CONFIG_PATH, value));
};

export const riskSettingConfig: KfSystemConfig = {
  key: 'riskSetting',
  name: '风控',
  config: [
    {
      key: 'riskSetting',
      name: t('风控'),
      tip: t('风控描述'),
      default: [],
      type: 'table',
      columns: [
        {
          key: 'account_id',
          name: t('账户'),
          type: 'td',
        },
        {
          key: 'max_order_volume',
          name: t('单比最大量'),
          type: 'int',
        },
        {
          key: 'max_daily_volume',
          name: t('每日最大成交量'),
          type: 'int',
        },
        {
          key: 'self_filled_check',
          name: t('防止自成交'),
          type: 'bool',
          default: false,
        },
        {
          key: 'max_cancel_ratio',
          name: t('最大回撤率'),
          type: 'int',
        },
        {
          key: 'white_list',
          name: t('标的白名单'),
          type: 'instruments',
        },
      ],
    },
  ],
};
