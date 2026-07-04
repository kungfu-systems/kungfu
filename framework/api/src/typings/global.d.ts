import { Translator } from '../language/translator';
import {
  GithubOptions,
  S3Options,
  GenericServerOptions,
} from 'builder-util-runtime';
import { KfHookKeeper } from '../hooks';
import { ExtendedGlobalStorage } from '../utils/globalStorage';
import { InstrumentTypeEnum, InstrumentTypes } from './enums';

declare global {
  interface Window {
    watcher: Watcher | null;
    kungfu: Kungfu;
    workers: Record<string, WebpackWorker>;
    basketStore: KungfuApi.BasketStore;
    basketInstrumentStore: KungfuApi.BasketInstrumentStore;
    configStore: KungfuApi.ConfigStore;
    sessionStore: KungfuApi.SessionStore;
    riskSettingStore: KungfuApi.RiskSettingStore;
    commissionStore: KungfuApi.CommissionStore;
    io: KungfuApi.IODevice;
    fileId: number;
    testCase: Record<string, any>;
    ukeyCacheMap?: Map<string, string>;
  }

  namespace NodeJS {
    interface ProcessEnv {
      LANG_ENV: 'zh-CN' | 'en-US' | 'zh-HK' | undefined;
      APP_TYPE: 'cli' | 'renderer' | 'main' | 'service';
      UI_EXT_TYPE: 'component' | 'script';
      APP_ID: string;
      EXTENSION_DIRS: string;
      KF_VERIFY_LOCATION: boolean;
      KUNGFU_DIR: string;
      KF_CONFIG_DIR: string;
      KF_APP_RUNTIME_DIR: string;
      KF_LOG_FRAME: boolean;
      IS_KF_DEV: boolean; // 判断当前是否通过 yarn dev 启动的开发模式
      CPUS_NUM: number;
      IF_CPUS_NUM_SAFE: boolean;
      IF_CUR_VERSION_FIRST_RUNNING: boolean;
      ELECTRON_RUN_AS_NODE: boolean;
      ELECTRON_ENABLE_STACK_DUMPING: boolean;
      RELOAD_AFTER_CRASHED: 'true' | 'false' | undefined; // 需要作为pm2 env参数传递，为了统一识别，用string
      REFRESH_LEDGER_BEFORE_SYNC: boolean;
      BY_PASS_RESTORE: boolean;
      BY_PASS_ACCOUNTING: boolean;
      BY_PASS_TRADINGDATA: boolean;
      BY_PASS_REFRESHBOOK: boolean;
      REFRESH_LEDGER_BEFORE_SYNC: boolean;
      MILLISECONDS_SLEEP_AFTER_STEP: number;
    }

    interface Process {
      resourcesPath: string;
    }
  }
}

declare module 'tail' {
  export class Tail {
    constructor(
      filePath: string,
      options: {
        follow?: boolean;
        fromBeginning?: boolean;
        nLines?: number;
        useWatchFile?: boolean;
      },
    );
    watch(): void;
    unwatch(): void;
    on(type: 'line', callback: (data: string) => void);
    on(type: 'error', callback: (err: Error) => void);
  }
}

declare module 'dayjs-business-days' {}

declare module globalThis {
  const __publicResources: string;
  const __kfResourcesPath: string;
  const HookKeeper: KfHookKeeper;
  const i18n: Translator;
  const globalStorage: ExtendedGlobalStorage;
  const rootPackageJson: RootConfigJSON;
}

export interface T0T1Config {
  T0: {
    instrumentTypes: InstrumentTypes[];
    exchangeIds: string[];
  };
}

export type AllPublishOptions =
  | GithubOptions
  | S3Options
  | GenericServerOptions;

export type Writeable<T> = { -readonly [P in keyof T]: T[P] };

export interface RootConfigJSON {
  name?: string;
  version?: string;
  kungfuCraft?: {
    appTitle?: string;
    productName?: string;
    env?: Record<string, string>;
    autoUpdate?: {
      update?: Writeable<AllPublishOptions>;
      checkVersion?: {
        alphaToRelease?: boolean;
        releaseToAlpha?: boolean;
      };
    };
  };
  appConfig?: {
    showHelp?: boolean;

    customSidebar?: Record<
      string,
      {
        sidebarIndex?: number;
        name?: string;
      }
    >;

    boardFilter?: Record<string, boolean>;

    orderTrigger?: boolean;

    kfConfigInitValue?: Record<string, KungfuApi.KfConfigValue>;

    T0T1?: T0T1Config;

    defaultExtension?: {
      td?: string;
      md?: string;
    };

    makeOrder?: {
      priceTypeFilter?: Record<string, boolean>;
      offsetFilter?: Record<string, boolean>;
      ableHedgeFlag?: boolean;
    };

    clearLocalStorageWithNewVersion?: boolean;
  };
}

export interface GlobalStorageData {
  isKungfuFirstRunning?: boolean;
  lastStartDateTime?: string;
  skippedVersions?: string[];
  needClearJournal?: boolean;
  needClearDB?: boolean;
  historicalUsedVersions?: string[];
}
