import path from 'path';
import fse from 'fs-extra';
import os from 'os';
import fkill from 'fkill';
import { Proc, ProcessDescription, StartOptions } from 'pm2';
import pm2 from './pm2Custom';
import { getUserLocale } from 'get-user-locale';
import find from 'find-process';
import { ensureFileSync } from 'fs-extra';
import {
  getIfProcessRunning,
  getIfProcessDeleted,
  isTdMdOperatorStrategy,
  deleteNNFiles,
  removeDBIfNeed,
  removeJournalIfNeed,
} from '../utils/busiUtils';
import {
  flattenExtensionModuleDirs,
  getKfExtOriginConfigsByType,
} from '../utils/extUtils';
import {
  setTimerPromiseTask,
  getProcessIdByKfLocation,
  findSoAndPydFiles,
  dealSpaceInPath,
  delayMilliSeconds,
} from '../utils/commonUtils';
import { kfLogger } from '../utils/logUtils';
import {
  buildProcessLogPath,
  EXTENSION_DIRS,
  KUNGFU_DIR,
  KF_CONFIG_DIR,
  KF_HOME,
  KF_RUNTIME_DIR,
  buildRuntimeChildDirByType,
} from '../config/pathConfig';

import { getKfGlobalSettingsValue } from '../config/globalSettings';
import { KfModeTypes } from '../typings/enums';
import { Pm2ProcessStatusTypes } from '../typings/common';
import { Observable } from 'rxjs';
import {
  booleanProcessEnv,
  ifKfDev,
} from '@kungfu-tech/api/utils/commonUtils';
import {
  buildMasterLocation,
  buildLedgerLocation,
  buildMasterProcessId,
  buildLedgerProcessId,
  buildDzxyProcessId,
} from '@kungfu-tech/api/utils/systemUtils';
import VueI18n from '@kungfu-tech/api/language';
import { Pm2StartOptions } from '../typings/global';
import { KfHookKeeper } from '../hooks';
import { getAppRuntimeDirName } from './fileUtils';
import { getKfCommission } from '../kungfu/commission';
import { buildArchiveProcessId } from './systemUtils';
const { t } = VueI18n.global;

process.env.PM2_HOME = path.resolve(os.homedir(), '.pm2');
const isWin = os.platform() === 'win32';
const locale = getUserLocale().replace(/-/g, '_');

interface FindProcessResult {
  pid: number;
  ppid?: number;
  uid?: number;
  gid?: number;
  name: string;
  bin?: string;
  cmd?: string;
  username?: string;
}

export const findProcessByKeyword = (
  processName: string | RegExp,
  strict = true,
): Promise<FindProcessResult[]> => {
  const userid = os.userInfo().uid;
  return find('name', processName, strict).then((processList) => {
    return processList.filter((item) => {
      return item.uid ? item.uid == userid : true;
    });
  });
};

export const findProcessByKeywordsByFindProcess = (
  tasks: Array<string | RegExp>,
  strict = true,
): Promise<FindProcessResult[]> => {
  return Promise.all(
    tasks.map((key) => findProcessByKeyword(key, strict)),
  ).then((results) => {
    return results.reduce((pre, processList) => {
      const prePids = pre.map((p) => p.pid);
      processList.forEach((process) => {
        if (!prePids.includes(process.pid)) pre.push(process);
      });
      return pre;
    }, []);
  });
};

/***
 * tasklist is only used on windows, and working for find process by current user
 * but the performance of tasklist actually is a issue
 *  ***/

// export const findProcessByKeywordsByTaskList = (
//   tasks: Array<string | RegExp>,
// ): Promise<FindProcessResult[]> => {
//   const username = os.userInfo().username;
//   const tasklist = require('tasklist');
//   return tasklist({ verbose: true }).then((processList) => {
//     return processList
//       .filter((item) => tasks.indexOf(item.imageName) !== -1)
//       .filter((item) => (item.username || '').split('\\')[1] == username)
//       .map((item) => {
//         return {
//           pid: item.pid,
//           name: item.imageName,
//           username: item.username,
//         };
//       });
//   });
// };

export const findProcessByKeywords = (
  tasks: Array<string | RegExp>,
  strict = true,
): Promise<FindProcessResult[]> => {
  return findProcessByKeywordsByFindProcess(tasks, strict);
};

export const forceKill = (pids: number[]) => {
  return fkill(pids, {
    force: true,
    tree: isWin ? true : false,
    ignoreCase: true,
    silent: process.env.NODE_ENV === 'development' ? true : false,
  }).catch((err) => {
    kfLogger.warn((<Error>err).message);
  });
};
export const forceKillByKeyWords = (
  tasks: Array<string | RegExp>,
  strict = true,
): Promise<void> => {
  return findProcessByKeywords(tasks, strict).then((processList) => {
    const pids = processList.map((item) => item.pid);

    kfLogger.info(
      `Target to force kill processList about [${tasks.join(', ')}]: `,
      JSON.stringify(processList),
    );
    return forceKill(pids);
  });
};

const kungfuName = isWin ? 'kungfu.exe' : 'kungfu';
const appDirName = getAppRuntimeDirName();
const appDirNameRegExp = new RegExp(appDirName, 'i');

const isCurrentProcess = (pro: FindProcessResult) => {
  return pro.pid === process.pid;
};

const isAppProcess = (pro: FindProcessResult) => {
  if (process.env.APP_TYPE === 'main') {
    if (pro.ppid === process.pid) return false;

    return (
      pro.name.match(appDirNameRegExp) ||
      appDirName.match(new RegExp(pro.name, 'i'))
    );
  }

  return false;
};

const isProcessBelongsToCurrentApp = (pro: FindProcessResult) => {
  if (pro.bin && pro.bin.match(appDirNameRegExp)) return true;

  if (pro.cmd) {
    const cmds = pro.cmd.trim().split(' ');
    const bin = cmds[0];
    if (bin.match(appDirNameRegExp)) return true;
  }

  return false;
};

export const killKfc = (byCurrentApp = false): Promise<void> => {
  const isKfDev = ifKfDev();
  return new Promise((resolve) => {
    findProcessByKeywords([kungfuName], false)
      .then((processList) => {
        const processes = processList.filter((item) => {
          if (isCurrentProcess(item)) return false;
          if (isKfDev) return true;
          if (byCurrentApp) return isProcessBelongsToCurrentApp(item);
          return true;
        });
        const pids = processes.map((item) => item.pid);

        kfLogger.info(
          `Target to force kill processList about [${kungfuName}]: `,
          JSON.stringify(processes),
        );
        return forceKill(pids);
      })
      .catch((err) => {
        kfLogger.error(err);
      })
      .finally(() => {
        resolve();
      });
  });
};

export const killKungfuApp = (): Promise<void> => {
  return new Promise((resolve) => {
    findProcessByKeywords([appDirNameRegExp], false)
      .then((processList) => {
        const processes = processList.filter((item) => {
          if (isCurrentProcess(item)) return false;
          return isAppProcess(item);
        });
        const pids = processes.map((item) => item.pid);

        kfLogger.info(
          `Target to force kill processList about [${appDirName}]: `,
          JSON.stringify(processes),
        );
        return forceKill(pids);
      })
      .catch((err) => {
        kfLogger.error(err);
      })
      .finally(() => {
        resolve();
      });
  });
};

export const killPm2 = (): Promise<void> => {
  return new Promise((resolve) => {
    findProcessByKeywords(['pm2'], false)
      .then((processList) => {
        const pids = processList
          // for win pm2 daemon
          // TODO: except every kungfu client has own pm2 daemon
          //
          // .filter((item) => {
          //   if (item.cmd) {
          //     const cmds = item.cmd.trim().split(' ');
          //     const opt = cmds.slice(1).join();
          //     if (opt.includes(appDirName) && opt.includes('pm2')) return true;
          //   }
          //
          //   return false;
          // })
          //
          // but now, have to kill the all global daemons
          .map((item) => item.pid);

        kfLogger.info(
          `Target to force kill processList about [pm2]: `,
          JSON.stringify(processList),
        );
        return forceKill(pids);
      })
      .catch((err) => {
        kfLogger.error(err);
      })
      .finally(() => {
        resolve();
      });
  });
};

export const killExtra = (withApp: boolean, withPm2 = true, withKfc = true) => {
  const promises: Array<Promise<void>> = [];
  if (withApp) promises.push(killKungfuApp());
  if (withPm2) promises.push(killPm2());
  if (withKfc) promises.push(killKfc());

  if (promises.length) {
    return Promise.all(promises);
  }

  return Promise.resolve();
};

//===================== pm2 start =======================

export type Pm2ProcessStatusData = Record<
  string,
  Pm2ProcessStatusTypes | undefined
>;

export interface Pm2ProcessStatusDetail {
  monit: ProcessDescription['monit'];
  pid: ProcessDescription['pid'];
  name: ProcessDescription['name'];
  pm_id: ProcessDescription['pm_id'];

  status: Pm2Env['status'];
  created_at: Pm2Env['created_at'];
  script: Pm2Env['script'];
  cwd: Pm2Env['pm_cwd'];
  config_settings: string;
  args: string[];
}

export interface Pm2ProcessStatusDetailResolved extends Pm2ProcessStatusDetail {
  name_resolved?: string;
}

export type Pm2ProcessStatusDetailData = Record<string, Pm2ProcessStatusDetail>;

export interface Pm2Env {
  pm_cwd?: string;
  pm_out_log_path?: string;
  pm_err_log_path?: string;
  exec_interpreter?: string;
  pm_uptime?: number;
  unstable_restarts?: number;
  restart_time?: number;
  status?: Pm2ProcessStatusTypes;
  instances?: number | 'max';
  pm_exec_path?: string;
  created_at?: number;
  script?: StartOptions['script'];
  args?: StartOptions['args'];
  env?: StartOptions['env'];
}

export interface Pm2Packet {
  process: {
    pm_id: number;
  };
  data: {
    type: string;
    body: Record<string, string | number | boolean>;
  };
}

export interface Pm2PacketMain {
  type: string;
  topic: string;
  data: object;
  id: number;
}

export interface Pm2Bus {
  on(type: string, cb: (packet: Pm2Packet) => void): void;
  // on(type: string, cb: (packet: Pm2Packet) => void): void;
}

export const pm2Connect = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    pm2.connect((err: Error) => {
      if (err) {
        kfLogger.error(err);
        reject(err);
        return;
      }

      resolve();
    });
  });
};

export const pm2List = (): Promise<ProcessDescription[]> => {
  return new Promise((resolve, reject) => {
    pm2.list((err: Error, pList: ProcessDescription[]) => {
      if (err) {
        kfLogger.error(err);
        reject(err);
        return;
      }

      resolve(pList);
    });
  });
};

export const pm2Describe = (
  processId: string,
): Promise<ProcessDescription[]> => {
  return new Promise((resolve, reject) => {
    //此处无需connect, 不然windows会卡死
    pm2.describe(processId, (err: Error, pList: ProcessDescription[]) => {
      if (err) {
        kfLogger.error(err);
        reject(err);
        return;
      }

      resolve(pList);
    });
  });
};

const pm2Start = (options: Pm2StartOptions): Promise<Proc> => {
  return new Promise((resolve, reject) => {
    pm2Connect()
      .then(() => {
        pm2.start(options, (err: Error, proc: Proc) => {
          if (err) {
            kfLogger.error(err);
            reject(err);
            return;
          }

          resolve(proc);
        });
      })
      .catch((err: Error) => {
        kfLogger.error(err);
        reject(err);
      });
  });
};

const pm2Stop = (processId: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    pm2Connect()
      .then(() => {
        pm2.stop(processId, (err: Error) => {
          if (err) {
            kfLogger.error(err);
            reject(err);
            return;
          }

          resolve();
        });
      })
      .catch((err: Error) => {
        kfLogger.error(err);
        reject(err);
      });
  });
};

const pm2Delete = (processId: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    pm2Connect()
      .then(() => {
        pm2.delete(processId, (err: Error) => {
          if (err) {
            kfLogger.error(err);
            reject(err);
            return;
          }

          resolve();
        });
      })
      .catch((err: Error) => {
        kfLogger.error(err);
        reject(err);
      });
  });
};

declare module 'pm2' {
  function kill(cb: (err: Error, res: { success: boolean }) => void): void;
}

export const pm2Kill = (): Promise<void> => {
  kfLogger.info('Pm2 Kill All');
  return new Promise((resolve, reject) => {
    pm2.kill(
      (
        err: Error,
        res: {
          success: boolean;
        },
      ) => {
        pm2.disconnect();
        if (err) {
          kfLogger.error(err);
          reject(err);
          return;
        }

        if (res.success) {
          resolve();
        } else {
          reject(new Error('pm2Kill res.success not true'));
        }
      },
    );
  });
};

export const pm2KillGodDaemon = (): Promise<void> => {
  kfLogger.info('Kill Pm2 God Daemon');
  return new Promise((resolve, reject) => {
    pm2Connect().then(() => {
      // the doc said required disconnect, but if use the disconnect, the daemon won't quit
      pm2.killDaemon((err: Error) => {
        pm2.disconnect();
        if (err) {
          kfLogger.error(err);
          reject(err);
          return;
        }

        resolve();
      });
    });
  });
};

export const pm2Disconnect = pm2.disconnect;

export function pm2LaunchBus(cb: (err: Error, pm2_bus: Pm2Bus) => void) {
  pm2.launchBus(cb);
}

type KungfuEnvOptType<T> =
  | T
  | {
      value: T;
      prefix?: 'ENV' | 'ARG';
    };

export interface KungfuEnvs {
  logFrame?: KungfuEnvOptType<boolean>;
  bypassCached?: KungfuEnvOptType<boolean>;
  bypassAccounting?: KungfuEnvOptType<boolean>;
  bypassRefreshBook?: KungfuEnvOptType<boolean>;
  bypassSyncAsset?: KungfuEnvOptType<boolean>;
  bypassSyncPosition?: KungfuEnvOptType<boolean>;
  verifyLocation?: KungfuEnvOptType<boolean>;
  lowMemory?: KungfuEnvOptType<boolean>;
  keepPage?: KungfuEnvOptType<boolean>;
  preload?: KungfuEnvOptType<boolean>;
  maxPreCreateSize?: KungfuEnvOptType<number>;
}

export const startProcess = async (
  options: Pm2StartOptions,
  acceptEnvArgs = true,
): Promise<Proc | void> => {
  const extDirs = await flattenExtensionModuleDirs(EXTENSION_DIRS);
  options = await (globalThis.HookKeeper as KfHookKeeper)
    .getHooks()
    .resolveStartOptions.trigger(
      {
        category: '*',
        group: '*',
        name: '*',
        mode: '*',
      } as KungfuApi.DerivedKfLocation,
      options,
    );

  const filePath = buildProcessLogPath(options.name);
  ensureFileSync(filePath);

  let args = options.args;

  if (acceptEnvArgs) {
    const globalSetting = getKfGlobalSettingsValue();
    const bypassRefreshBook =
      booleanProcessEnv(process.env.BY_PASS_REFRESHBOOK) ??
      globalSetting?.performance?.bypassRefreshBook ??
      false;
    const bypassSyncPosition =
      globalSetting?.trade?.bypassSyncPosition ?? false;
    const bypassCached = globalSetting?.system?.bypassCached ?? false;
    const lowMemory = globalSetting?.performance?.lowMemory ?? false;
    const extraEnvArgs = buildKungfuEnv({
      bypassRefreshBook,
      bypassSyncPosition,
      bypassCached,
      lowMemory,
    });

    args = `${options.args} ${extraEnvArgs}`;
  }

  const optionsResolved: Pm2StartOptions = {
    name: options.name,
    args: args,
    cwd: options.cwd || path.join(KUNGFU_DIR),
    script: options.script || kungfuName,
    interpreter: options.interpreter || 'none',
    output: buildProcessLogPath(options.name),
    error: buildProcessLogPath(options.name),
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    autorestart: options.autorestart || false,
    max_restarts: options.max_restarts || (options.autorestart ? 1 : 0),
    min_uptime: 3600000, //该时间段内最大启动次数max_restarts, 如果超过则不重启, 如果没超过, 则一直重启
    restart_delay: 1000,
    watch: options.watch || false,
    force: options.force || false,
    exec_mode: 'fork',
    kill_timeout: options.kill_timeout || 16000,
    env: {
      RELOAD_AFTER_CRASHED: process.env.RELOAD_AFTER_CRASHED || 'false',
      EXTENSION_DIRS: extDirs
        .map((dir) => dealSpaceInPath(path.dirname(dir)))
        .join(path.delimiter),
      KUNGFU_DIR: process.env.KUNGFU_DIR || '',
      CLI_DIR: process.env.CLI_DIR || '',
      IS_KF_DEV: ifKfDev() ? 'true' : '',
      KF_HOME: dealSpaceInPath(KF_HOME),
      KF_RUNTIME_DIR: dealSpaceInPath(KF_RUNTIME_DIR),
      KF_CONFIG_DIR: dealSpaceInPath(KF_CONFIG_DIR),
      LANG: `${locale}.UTF-8`,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf8',

      KUNGFU_AS_VARIANT: '',
      ...options.env,

      // cover father process env
      APP_TYPE: '',
      APP_ID: '',
      UI_EXT_TYPE: '',
      BY_PASS_ACCOUNTING: '',
      BY_PASS_TRADINGDATA: '',
      BY_PASS_REFRESHBOOK: '',
      BY_PASS_RESTORE: '',
    },
  };
  return pm2Start(optionsResolved).catch((err) => {
    kfLogger.error(err);
  });
};

export const stopProcess = pm2Stop;

export const requestStop = (
  watcher: KungfuApi.Watcher,
  kfLocation: KungfuApi.KfLocation,
) => {
  return Promise.resolve(watcher.requestStop(kfLocation));
};

export const graceStopProcess = async (
  watcher: KungfuApi.Watcher | null,
  kfLocation: KungfuApi.KfConfig | KungfuApi.KfLocation,
  processStatusData?: Pm2ProcessStatusData,
): Promise<void> => {
  if (!processStatusData) {
    const { processStatus } = await listProcessStatus();
    processStatusData = processStatus;
  }

  const processId = getProcessIdByKfLocation(kfLocation);

  if (!watcher) {
    return Promise.reject(new Error('Watcher is NULL'));
  }

  if (getIfProcessRunning(processStatusData, processId)) {
    if (
      watcher &&
      !watcher.isReadyToInteract(kfLocation) &&
      isTdMdOperatorStrategy(kfLocation.category)
    ) {
      return Promise.reject(new Error(t('未就绪', { processId })));
    }

    return requestStop(watcher, kfLocation)
      .then(() => delayMilliSeconds(200))
      .then(() => stopProcess(processId));
  }

  return Promise.resolve();
};

export const deleteProcess = pm2Delete;

export const graceDeleteProcess = async (
  watcher: KungfuApi.Watcher | null,
  kfLocation: KungfuApi.KfConfig | KungfuApi.KfLocation,
  processStatusData?: Pm2ProcessStatusData,
): Promise<void> => {
  if (!processStatusData) {
    const { processStatus } = await listProcessStatus();
    processStatusData = processStatus;
  }

  const processId = getProcessIdByKfLocation(kfLocation);

  if (!watcher) {
    return Promise.reject(new Error('Watcher is NULL'));
  }

  if (getIfProcessRunning(processStatusData, processId)) {
    if (
      watcher &&
      !watcher.isReadyToInteract(kfLocation) &&
      isTdMdOperatorStrategy(kfLocation.category)
    ) {
      return Promise.reject(new Error(t('未就绪', { processId })));
    }

    return requestStop(watcher, kfLocation)
      .then(() => delayMilliSeconds(1000))
      .then(() => deleteProcess(processId));
  } else if (!getIfProcessDeleted(processStatusData, processId)) {
    return deleteProcess(processId);
  } else {
    return Promise.resolve();
  }
};

export function startProcessGetStatusUntilStop(
  options: Pm2StartOptions,
  cb?: (processStatus: Pm2ProcessStatusTypes) => void,
  acceptEnvArgs = true,
) {
  return new Promise((resolve) => {
    startProcess({ ...options }, acceptEnvArgs).then(() => {
      const timer = startGetProcessStatusByName(
        options.name,
        (res: ProcessDescription[]) => {
          const status = res[0]?.pm2_env?.status as Pm2ProcessStatusTypes;
          cb && cb(status);
          if (status !== 'online') {
            timer && timer.clearLoop();
            resolve(status);
          }
        },
      );
    });
  });
}

export const startGetProcessStatus = (
  callback: (res: {
    processStatus: Pm2ProcessStatusData;
    processStatusWithDetail: Pm2ProcessStatusDetailData;
  }) => void,
) => {
  setTimerPromiseTask(() => {
    return listProcessStatus()
      .then((res) => {
        const { processStatus, processStatusWithDetail } = res;
        if (callback) {
          callback({
            processStatus: Object.freeze(processStatus || {}),
            processStatusWithDetail: Object.freeze(
              processStatusWithDetail || {},
            ),
          } as {
            processStatus: Pm2ProcessStatusData;
            processStatusWithDetail: Pm2ProcessStatusDetailData;
          });
        }
      })
      .catch((err) => console.error(err));
  }, 1000);
};

export const listProcessStatus = (): Promise<{
  processStatus: Pm2ProcessStatusData;
  processStatusWithDetail: Pm2ProcessStatusDetailData;
}> => {
  return pm2List().then((pList: ProcessDescription[]) => {
    const processStatus = buildProcessStatus(pList);
    const processStatusWithDetail = buildProcessStatusWidthDetail(pList);
    return { processStatus, processStatusWithDetail };
  });
};

export const listProcessStatusWithDetail =
  (): Promise<Pm2ProcessStatusDetailData> => {
    return pm2List().then((pList: ProcessDescription[]) =>
      buildProcessStatusWidthDetail(pList),
    );
  };

export function buildProcessStatusWidthDetail(
  pList: ProcessDescription[],
): Pm2ProcessStatusDetailData {
  return pList.reduce(
    (processStatus: Pm2ProcessStatusDetailData, p: ProcessDescription) => {
      const { monit, pid, name, pm2_env, pm_id } = p;
      const status = pm2_env?.status;
      const created_at = (pm2_env as Pm2Env)?.created_at;
      const cwd = pm2_env?.pm_cwd;
      const config_settings =
        (pm2_env as Pm2Env)?.env?.['CONFIG_SETTING'] || '[]';
      const pm_exec_path = (pm2_env?.pm_exec_path || '').split('/');
      const script =
        (pm2_env as Pm2Env).script || pm_exec_path[pm_exec_path.length - 1];
      const args = (pm2_env as Pm2Env).args || [];
      const argsResolved = typeof args === 'string' ? [args] : args;

      if (!name) return processStatus;
      processStatus[name] = {
        monit,
        pid,
        name,
        pm_id,
        status,
        created_at,
        script,
        cwd,
        args: argsResolved,
        config_settings,
      };
      return processStatus;
    },
    {} as Pm2ProcessStatusDetailData,
  );
}

//===================== pm2 end =========================

//===================== utils start =====================

function buildProcessStatus(pList: ProcessDescription[]): Pm2ProcessStatusData {
  return pList.reduce((pre, p: ProcessDescription) => {
    const name: string | undefined = p?.name;
    const status: Pm2ProcessStatusTypes | undefined = p?.pm2_env?.status;
    if (name) {
      pre[name] = status;
    }
    return pre;
  }, {} as Pm2ProcessStatusData);
}

async function getBacktestArgs(isEnableMatcher: boolean) {
  const extOriginConfigs = await getKfExtOriginConfigsByType();
  let matcherPath = '';
  let indexerPath = '';

  if (extOriginConfigs) {
    const { matcher, indexer } = extOriginConfigs;

    if (indexer) {
      for (const key of Object.keys(indexer)) {
        if (indexer[key]['useFor']?.includes('replay')) {
          const files = await findSoAndPydFiles(indexer[key].extPath);
          if (files.length > 0) {
            indexerPath = files[0];
            break;
          }
        }
      }
    }

    if (matcher) {
      for (const key of Object.keys(matcher)) {
        if (matcher[key].extPath) {
          const files = await findSoAndPydFiles(matcher[key].extPath);
          if (files.length > 0) {
            matcherPath = files[0];
            break;
          }
        }
      }
    }
  }
  if (!isEnableMatcher) {
    kfLogger.warn('matcher is not enable');
  }

  return isEnableMatcher
    ? `-M '${matcherPath}' --from_indexer '${indexerPath}'`
    : '';
}

async function getBackTestConfigPath(group: string, name: string) {
  const cwd = dealSpaceInPath(
    path.join(buildRuntimeChildDirByType('resources'), 'strategy', group, name),
  );

  await fse.ensureDir(cwd);

  if (globalThis.watcher) {
    const instruments = globalThis.watcher.ledger.Instrument.list();
    const commissions = await getKfCommission(globalThis.watcher);

    const backtestConfigJson = {
      Commission: {
        default: commissions || [],
      },
      Instrument: {
        default: instruments || [],
      },
    };

    const backtestConfigPath = path.join(cwd, 'backtest_config.json');
    await fse.writeJson(backtestConfigPath, backtestConfigJson);
    return backtestConfigPath;
  }
  return '';
}

function buildRocketParams(args: string, ifRocket: boolean) {
  let rocket = ifRocket ? '-x' : '';

  if (!booleanProcessEnv(process.env.IF_CPUS_NUM_SAFE)) {
    rocket = '';
  }

  if (args.includes('archive')) {
    rocket = '';
  }

  if (args.includes('dzxy')) {
    rocket = '';
  }

  return rocket;
}

function buildKungfuEnv(env: KungfuEnvs) {
  return Object.keys(env)
    .map((key) => {
      const opt = env[key as keyof KungfuEnvs];
      if (!opt) return null;

      const isOptObj = typeof opt === 'object';
      const value = isOptObj ? opt.value : opt;
      const isValueBool = typeof value === 'boolean';
      const defaultPrefix = isValueBool ? 'ENV' : 'ARG';
      const prefix = isOptObj ? opt.prefix || defaultPrefix : defaultPrefix;

      const valueResolved = isValueBool ? '' : ` ${value}`;
      const keyResolved = key.replaceAll(
        /(?<!^)[A-Z]/g,
        (s) => '-' + s.toLowerCase(),
      );
      return `-${prefix}-${keyResolved}${valueResolved}`;
    })
    .filter((i) => !!i)
    .join(' ');
}

function buildKungfuArgs(options: {
  prefix?: string;
  logLevel?: string;
  extensionDirs?: string;
  location?: KungfuApi.KfLocation;
  extraArgs?: string;
  args?: string;
  suffix?: string;
  env?: KungfuEnvs;
  canLogFrame?: boolean;
}): string {
  const globalSetting = getKfGlobalSettingsValue();
  const logLevel: string =
    options.logLevel || (globalSetting?.system?.logLevel ?? '');
  const ifRocket = globalSetting?.performance?.rocket ?? false;
  const verifyLocation = globalSetting?.system?.verifyLocation ?? false;
  const logFrame = globalSetting?.system?.logFrame ?? false;
  const {
    canLogFrame = true,
    prefix,
    extensionDirs,
    location,
    extraArgs,
    args,
    suffix,
    env,
  } = options;

  const fullArgsArray: string[] = [
    buildKungfuEnv({
      verifyLocation,
    }),
  ];

  if (prefix) {
    fullArgsArray.push(prefix);
  }

  if (logLevel) {
    fullArgsArray.push(logLevel);
  }
  if (extensionDirs) {
    fullArgsArray.push(`-X ${extensionDirs}`);
  }

  if (location) {
    const locationArgs = `run -c ${location.category} -g ${location.group} -n ${location.name} -m ${location.mode}`;
    fullArgsArray.push(locationArgs);
  }
  if (extraArgs) {
    fullArgsArray.push(extraArgs);
  }

  if (args) {
    fullArgsArray.push(`-a '${args}'`);
  }

  if (suffix) {
    fullArgsArray.push(suffix);
  }

  if (canLogFrame) {
    fullArgsArray.push(buildKungfuEnv({ logFrame }));
  }

  if (env) {
    fullArgsArray.push(buildKungfuEnv(env));
  }

  const fullArgs = fullArgsArray.join(' ');
  const rocket = buildRocketParams(fullArgs, ifRocket);
  return [fullArgs, rocket].join(' ');
}

//循环获取processStatus
function startGetProcessStatusByName(
  name: string,
  callback: (pList: ProcessDescription[]) => void,
) {
  const timer = setTimerPromiseTask(() => {
    return pm2Describe(name)
      .then((pList: ProcessDescription[]) => {
        callback(pList);
      })
      .catch((err) => kfLogger.error(err));
  }, 1000);

  return timer;
}

//===================== utils end =======================

//================ business related start ===============

export async function isAllMainProcessRunning(onlyMaster = false) {
  const { processStatus } = await listProcessStatus();
  kfLogger.info('isAllMainProcessRunning', processStatus);

  const masterProcessId = buildMasterProcessId();
  const ledgerProcessId = buildLedgerProcessId();

  if (onlyMaster) {
    return getIfProcessRunning(processStatus, masterProcessId);
  }

  return (
    getIfProcessRunning(processStatus, masterProcessId) &&
    getIfProcessRunning(processStatus, ledgerProcessId)
  );
}

export function startArchiveMakeTask(
  cb?: (processStatus: Pm2ProcessStatusTypes) => void,
) {
  const globalSetting = getKfGlobalSettingsValue();
  const ProcessId = buildArchiveProcessId();
  const bypassArchive = globalSetting?.system?.bypassArchive ?? false;
  const bypassArchiveDev = globalSetting?.system?.bypassArchiveDev ?? false;

  if (bypassArchiveDev) {
    cb?.('online');
    return delayMilliSeconds(2000).then(() => {
      cb?.('stopped');
      kfLogger.info('Completely pass the archive for dev');
    });
  }

  return startProcessGetStatusUntilStop(
    {
      name: ProcessId,
      args: buildKungfuArgs({
        extraArgs: `journal archive ${bypassArchive ? '-m delete' : ''}`,
        canLogFrame: false,
      }),
    },
    cb,
    false,
  );
}

export const startMaster = async (force = false): Promise<void> => {
  const location = buildMasterLocation();
  const ProcessId = getProcessIdByKfLocation(location);

  try {
    await preStartProcess(ProcessId, force);
    if (force) await killKfc();
    const args = buildKungfuArgs({
      location,
    });
    await startProcess({
      name: ProcessId,
      args,
      force,
      env: {
        KF_NO_EXT: 'on',
      },
    });
  } catch (err: unknown) {
    kfLogger.error((<Error>err).message);
  }
};

//启动ledger
export const startLedger = async (
  force = false,
  mode: KfModeTypes = 'live',
  replayConfig?: KungfuApi.ReplayConfigOrigin,
): Promise<void> => {
  const isReplay = mode === 'replay';
  let args = '';
  const location = buildLedgerLocation(mode);
  const ProcessId = getProcessIdByKfLocation(location);
  try {
    !isReplay ? await preStartProcess(ProcessId, force) : '';

    if (isReplay && replayConfig) {
      args = buildKungfuArgs({
        logLevel: replayConfig.log_level,
        location,
        suffix: `-b '${replayConfig.begin_time}' -e '${replayConfig.end_time}'`,
      });
    } else {
      args = buildKungfuArgs({
        location,
      });
    }

    await startProcess({
      name: ProcessId,
      args,
      force,
    });
  } catch (err: unknown) {
    kfLogger.error((<Error>err).message);
  }
};

async function preStartProcess(
  processId: string,
  force = false,
): Promise<void> {
  const processOrError = await pm2Describe(processId);
  if (processOrError instanceof Error) {
    kfLogger.error(processOrError.message);
    throw processOrError;
  }

  const isProcessAlive = !!processOrError.filter(
    (item) => item?.pm2_env?.status === 'online',
  ).length;

  if (!force && isProcessAlive) {
    const err = new Error(`kungfu ${processId} is alive`);
    kfLogger.error(err);
    return Promise.reject(err);
  }

  return Promise.resolve();
}

//启动md
export const startMd = async (
  kfConfig: KungfuApi.DerivedKfLocation,
): Promise<Proc | void> => {
  const processId = getProcessIdByKfLocation(kfConfig);
  const extDirs = await flattenExtensionModuleDirs(EXTENSION_DIRS);
  const args = buildKungfuArgs({
    extensionDirs: `"${extDirs
      .map((dir) => dealSpaceInPath(path.dirname(dir)))
      .join(path.delimiter)}"`,
    location: {
      category: 'md',
      group: `"${kfConfig.group}"`,
      name: `"${kfConfig.name}"`,
      mode: 'live',
    },
  });
  const cwd = dealSpaceInPath(
    path.join(
      buildRuntimeChildDirByType('resources'),
      'md',
      kfConfig.group,
      kfConfig.name,
    ),
  );
  await fse.ensureDir(cwd);
  const options =
    await globalThis.HookKeeper.getHooks().resolveStartOptions.trigger(
      kfConfig,
      {
        name: processId,
        cwd,
        script: `${dealSpaceInPath(path.join(KUNGFU_DIR, kungfuName))}`,
        args,
        max_restarts: 3,
        autorestart: true,
        force: true,
      },
    );

  return startProcess(options).catch((err) => {
    kfLogger.error(err);
  });
};

//启动td
export const startTd = async (
  accountId: string,
  kfConfig: KungfuApi.DerivedKfLocation,
  replayConfig?: KungfuApi.ReplayConfigOrigin,
): Promise<Proc | void> => {
  const mode = kfConfig.mode || 'live';
  const globalSetting = getKfGlobalSettingsValue();
  const notAutorestart =
    mode != 'live' ? true : globalSetting?.trade?.notAutoRestartTd ?? false;
  const extDirs = await flattenExtensionModuleDirs(EXTENSION_DIRS);
  const { source, id } = (accountId || '').parseSourceAccountId();
  let args = '';
  let fullProcessId = '';

  const cwd = dealSpaceInPath(
    path.join(buildRuntimeChildDirByType('resources'), 'td', source, id),
  );
  await fse.ensureDir(cwd);

  if (mode === 'replay' && replayConfig) {
    const location = {
      category: replayConfig.category,
      group: replayConfig.group,
      name: replayConfig.session_name,
      mode: mode,
    };
    args = buildKungfuArgs({
      logLevel: replayConfig.log_level,
      extensionDirs: `"${extDirs
        .map((dir) => dealSpaceInPath(path.dirname(dir)))
        .join(path.delimiter)}"`,
      location,
      suffix: `-b '${replayConfig.begin_time}' -e '${replayConfig.end_time}'`,
    });
    fullProcessId = getProcessIdByKfLocation(location);
  } else {
    args = buildKungfuArgs({
      extensionDirs: `"${extDirs
        .map((dir) => dealSpaceInPath(path.dirname(dir)))
        .join(path.delimiter)}"`,
      location: {
        category: 'td',
        group: `"${kfConfig.group}"`,
        name: `"${kfConfig.name}"`,
        mode: mode,
      },
    });
    fullProcessId = getProcessIdByKfLocation(kfConfig);
  }
  const options =
    await globalThis.HookKeeper.getHooks().resolveStartOptions.trigger(
      kfConfig,
      {
        name: fullProcessId,
        cwd,
        script: `${dealSpaceInPath(path.join(KUNGFU_DIR, kungfuName))}`,
        args,
        ...(notAutorestart
          ? {}
          : {
              max_restarts: 4, // pm2 在进程退出时对重启次数进行 +1，所有第一次退出也被计算在内，重启 3 次的话这里就应该填 4
              autorestart: true,
            }),
        force: true,
      },
    );

  return startProcess(options).catch((err) => {
    kfLogger.error(err);
  });
};

export const startTask = async (
  taskLocation: KungfuApi.KfLocation,
  soPath: string,
  args: string,
  configSettings: KungfuApi.KfConfigItem[],
  replayConfig?: KungfuApi.ReplayConfigOrigin,
): Promise<Proc | void> => {
  const mode = taskLocation.mode || 'live';
  const isReplay = mode === 'replay' || mode === 'backtest';
  const extDirs = await flattenExtensionModuleDirs(EXTENSION_DIRS);
  let argsResolved = '';
  const processId = getProcessIdByKfLocation({
    category: taskLocation.category,
    group: taskLocation.group,
    name: taskLocation.name,
    mode,
  });

  if (isReplay && replayConfig) {
    let backtestArgs = '';
    let backtestConfigPath = '';
    if (mode === 'backtest') {
      backtestArgs = await getBacktestArgs(replayConfig.enable_matcher);
      if (backtestArgs) {
        backtestConfigPath = await getBackTestConfigPath(
          replayConfig.group,
          replayConfig.session_name,
        );
      }
    }

    argsResolved = buildKungfuArgs({
      logLevel: replayConfig.log_level,
      extensionDirs: `"${extDirs
        .map((dir) => dealSpaceInPath(path.dirname(dir)))
        .join(path.delimiter)}"`,
      location: {
        category: 'strategy',
        group: `"${taskLocation.group}"`,
        name: `"${taskLocation.name}"`,
        mode: mode,
      },
      args: `${args}`,
      extraArgs: `${
        backtestConfigPath ? `-B '${backtestConfigPath}'` : ''
      } '${soPath}'`,
      suffix: `${backtestArgs} -b '${replayConfig.begin_time}' -e '${replayConfig.end_time}'`,
    });
  } else {
    argsResolved = buildKungfuArgs({
      extensionDirs: `"${extDirs
        .map((dir) => dealSpaceInPath(path.dirname(dir)))
        .join(path.delimiter)}"`,
      location: {
        category: 'strategy',
        group: `"${taskLocation.group}"`,
        name: `"${taskLocation.name}"`,
        mode: 'live',
      },
      args: `${args}`,
      extraArgs: `'${soPath}'`,
    });
  }

  return startProcess({
    name: processId,
    args: argsResolved,
    env: {
      CONFIG_SETTING: JSON.stringify(configSettings),
    },
    force: !isReplay,
  }).catch((err) => {
    kfLogger.error(err);
  });
};

export const startOperatorByExt = async (
  kfConfig: KungfuApi.DerivedKfLocation,
  replayConfig?: KungfuApi.ReplayConfigOrigin,
) => {
  const mode = kfConfig.mode || 'live';
  const isReplay = mode === 'replay';
  let args = '';
  let fullProcessId = '';
  const extDirs = await flattenExtensionModuleDirs(EXTENSION_DIRS);
  const { group, name } = kfConfig;

  const cwd = dealSpaceInPath(
    path.join(buildRuntimeChildDirByType('resources'), 'operator', group, name),
  );
  await fse.ensureDir(cwd);
  if (isReplay && replayConfig) {
    args = buildKungfuArgs({
      logLevel: replayConfig.log_level,
      location: {
        category: 'operator',
        group: `"${group}"`,
        name: `"${name}"`,
        mode: mode,
      },
      extensionDirs: `"${extDirs
        .map((dir) => dealSpaceInPath(path.dirname(dir)))
        .join(path.delimiter)}"`,
      suffix: `-b '${replayConfig.begin_time}' -e '${replayConfig.end_time}'`,
    });

    fullProcessId = getProcessIdByKfLocation({
      category: replayConfig.category,
      group: replayConfig.group,
      name: replayConfig.session_name,
      mode: mode,
    });
  } else {
    args = buildKungfuArgs({
      location: {
        category: 'operator',
        group: `"${group}"`,
        name: `"${name}"`,
        mode: mode,
      },
      extensionDirs: `"${extDirs
        .map((dir) => dealSpaceInPath(path.dirname(dir)))
        .join(path.delimiter)}"`,
    });
    fullProcessId = getProcessIdByKfLocation(kfConfig);
  }
  const options =
    await globalThis.HookKeeper.getHooks().resolveStartOptions.trigger(
      kfConfig,
      {
        name: fullProcessId,
        cwd,
        script: `${dealSpaceInPath(path.join(KUNGFU_DIR, kungfuName))}`,
        args,
        force: true,
      },
    );

  return startProcess(options).catch((err) => {
    kfLogger.error(err);
  });
};

export const startStrategyOperatorByLocalPython = async (
  KfLocation: KungfuApi.KfLocation,
  filePath: string,
  pythonPath: string,
  replayConfig?: KungfuApi.ReplayConfigOrigin,
): Promise<Proc | void> => {
  const mode = KfLocation.mode || 'live';
  const isReplay = mode === 'replay' || mode === 'backtest';
  let args = '';
  let fullProcessId = '';

  if (!pythonPath.trim()) {
    return Promise.reject(new Error('No local python path!'));
  }

  const fullPythonPathList = pythonPath.replace(/\\/g, '/').split('/');
  const pythonFolder = fullPythonPathList
    .slice(0, fullPythonPathList.length - 1)
    .join('/');
  const pythonFile = fullPythonPathList
    .slice(fullPythonPathList.length - 1)
    .join('/');

  if (isReplay && replayConfig) {
    let backtestArgs = '';
    let backtestConfigPath = '';
    if (mode === 'backtest') {
      backtestArgs = await getBacktestArgs(replayConfig.enable_matcher);
      if (backtestArgs) {
        backtestConfigPath = await getBackTestConfigPath(
          replayConfig.group,
          replayConfig.session_name,
        );
      }
    }

    args = buildKungfuArgs({
      prefix: '-m kungfu',
      logLevel: replayConfig.log_level,
      location: {
        category: replayConfig.category,
        group: replayConfig.group,
        name: replayConfig.session_name,
        mode: mode,
      },
      suffix: `${backtestConfigPath ? `-B '${backtestConfigPath}'` : ''} '${
        replayConfig.file_path
      }' ${backtestArgs} -b '${replayConfig.begin_time}' -e '${
        replayConfig.end_time
      }'`,
    });
    fullProcessId = getProcessIdByKfLocation({
      category: replayConfig.category,
      group: replayConfig.group,
      name: replayConfig.session_name,
      mode: mode,
    });
  } else {
    args = buildKungfuArgs({
      prefix: '-m kungfu',
      location: KfLocation,
      suffix: `'${filePath}'`,
    });
    fullProcessId = getProcessIdByKfLocation(KfLocation);
  }

  return startProcess({
    name: fullProcessId,
    args,
    cwd: `${dealSpaceInPath(pythonFolder)}`,
    script: `${pythonFile}`,
    force: true,
  }).catch((err) => {
    kfLogger.error(err);
  });
};

//启动strategy
export const startStrategyOperator = async (
  kfLocation: KungfuApi.KfLocation,
  filePath: string,
  replayConfig?: KungfuApi.ReplayConfigOrigin,
): Promise<Proc | void> => {
  const { category, mode } = kfLocation;
  const processId = getProcessIdByKfLocation(kfLocation);
  const isReplay = mode === 'replay' || mode === 'backtest';
  filePath = dealSpaceInPath(filePath);
  const globalSetting = getKfGlobalSettingsValue();
  const ifLocalPython = globalSetting?.strategy?.python ?? false;
  const pythonPath = globalSetting?.strategy?.pythonPath ?? '';

  //因为pm2环境残留，在反复切换本地python跟内置python时，会出现本地python启动失败，所以需要先pm2 kill
  try {
    const { processStatus } = await listProcessStatus();
    if (!getIfProcessDeleted(processStatus, processId)) {
      kfLogger.info(`Clear existed ${category} ${processId}`);
      await deleteProcess(processId);
    }
  } catch (err) {
    kfLogger.warn(err);
  }

  if (isReplay && replayConfig) {
    if (
      replayConfig.category === 'operator' &&
      replayConfig.group !== 'default'
    ) {
      return startOperatorByExt(
        {
          category: replayConfig.category,
          group: replayConfig.group,
          name: replayConfig.session_name,
          mode: mode,
        },
        replayConfig,
      );
    }
    const processId = getProcessIdByKfLocation({
      category: replayConfig.category,
      group: replayConfig.group,
      name: replayConfig.session_name,
      mode: mode,
    });
    if (ifLocalPython && replayConfig.file_path.endsWith('.py')) {
      return startStrategyOperatorByLocalPython(
        kfLocation,
        filePath,
        pythonPath,
        replayConfig,
      );
    } else {
      let backtestArgs = '';
      let backtestConfigPath = '';
      if (mode === 'backtest') {
        backtestArgs = await getBacktestArgs(replayConfig.enable_matcher);
        if (backtestArgs) {
          backtestConfigPath = await getBackTestConfigPath(
            replayConfig.group,
            replayConfig.session_name,
          );
        }
      }
      const args = buildKungfuArgs({
        logLevel: replayConfig.log_level,
        location: {
          category: replayConfig.category,
          group: replayConfig.group,
          name: replayConfig.session_name,
          mode: mode,
        },
        suffix: `${backtestConfigPath ? `-B '${backtestConfigPath}'` : ''} '${
          replayConfig.file_path
        }' ${backtestArgs} -b '${replayConfig.begin_time}' -e '${
          replayConfig.end_time
        }'`,
      });
      return startProcess({
        name: processId,
        args,
        force: true,
      }).catch((err) => {
        kfLogger.error(err);
      });
    }
  }

  if (ifLocalPython && filePath.endsWith('.py')) {
    return startStrategyOperatorByLocalPython(kfLocation, filePath, pythonPath);
  } else {
    const args = buildKungfuArgs({
      location: kfLocation,
      suffix: `'${filePath}'`,
    });
    return startProcess({
      name: processId,
      args,
      force: true,
    }).catch((err) => {
      kfLogger.error(err);
    });
  }
};

export const startDzxy = () => {
  const ProcessId = buildDzxyProcessId();

  return startProcess({
    name: ProcessId,
    args: '',
    cwd: process.env.CLI_DIR,
    script: 'dzxy.js',
    interpreter: path.join(KUNGFU_DIR, kungfuName),
    force: true,
    watch: process.env.NODE_ENV === 'production' ? false : true,
    env: {
      KUNGFU_AS_VARIANT: 'node',
    },
    kill_timeout: 500,
  }).catch((err) => {
    kfLogger.error(err);
  });
};

export const startExtService = async (
  location: KungfuApi.KfExtServiceLocation,
) => {
  const { name, cwd, script } = location;
  const processId = getProcessIdByKfLocation(location);

  const getExtServicePm2Options = async (): Promise<Pm2StartOptions> => {
    if (script.endsWith('.js')) {
      return {
        name: processId,
        args: '',
        cwd,
        script,
        interpreter: path.join(KUNGFU_DIR, kungfuName),
        force: true,
        watch: process.env.NODE_ENV === 'production' ? false : true,
        env: {
          KUNGFU_AS_VARIANT: 'node',
        },
        kill_timeout: 500,
      };
    } else {
      const extDirs = await flattenExtensionModuleDirs(EXTENSION_DIRS);
      const args = buildKungfuArgs({
        extensionDirs: `"${
          cwd ||
          extDirs
            .map((dir) => dealSpaceInPath(path.dirname(dir)))
            .join(path.delimiter)
        }"`,
        location: {
          category: 'system',
          group: 'service',
          name: `"${name}"`,
          mode: 'live',
        },
      });
      return {
        name: processId,
        cwd,
        script: `${dealSpaceInPath(path.join(KUNGFU_DIR, kungfuName))}`,
        args,
        force: true,
      };
    }
  };

  let options = await getExtServicePm2Options();
  options = await globalThis.HookKeeper.getHooks().resolveStartOptions.trigger(
    location,
    options,
  );

  return startProcess(options).catch((err) => {
    kfLogger.error(err);
  });
};

export const startCustomProcess = (
  targetName: string,
  params: string,
): Promise<Proc | void> => {
  const args = buildKungfuArgs({
    extraArgs: `${targetName} ${params}`,
  });
  return startProcess({
    name: targetName,
    args,
  }).catch((err) => {
    kfLogger.error(err);
  });
};

export const sendDataToProcessIdByPm2 = (
  topic: string,
  pm2Id: number,
  data: Record<string, KungfuApi.KfConfigValue>,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    pm2.sendDataToProcessId(
      pm2Id,
      {
        type: 'process:msg',
        topic,
        data,
      },
      (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      },
    );
  });
};

export const processStatusDataObservable = () => {
  return new Observable<{
    processStatus: Pm2ProcessStatusData;
    processStatusWithDetail: Pm2ProcessStatusDetailData;
  }>((observer) => {
    startGetProcessStatus(
      (res: {
        processStatus: Pm2ProcessStatusData;
        processStatusWithDetail: Pm2ProcessStatusDetailData;
      }) => {
        observer.next(res);
      },
    );
  });
};

export const initClean = async (withApp: boolean, withPm2: boolean) => {
  try {
    // have to be killExtra, otherwise main process starting takes too long
    await killExtra(withApp, withPm2);
    await deleteNNFiles();
    await removeDBIfNeed();
    await removeJournalIfNeed();
  } catch (err) {
    kfLogger.error('initClean error: ', err);
  }
};

function promiseWithTimeout<T>(
  promise: Promise<T | T[]>,
  ms = 15000,
): Promise<T | T[]> {
  return Promise.race([
    promise,
    new Promise<T | T[]>((_, reject) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        reject(`${promise} Timed out in ${ms}ms.`);
      }, ms);
    }),
  ]);
}

export function quitClean(): Promise<void> {
  //不需要加kill daemon
  return new Promise((resolve) => {
    //防止pm2 kill失败, 导致kungfu无法退出
    promiseWithTimeout(pm2Kill())
      .catch((err) => kfLogger.error('quitClean pm2Kill error: ', err))
      .finally(() => {
        killExtra(false)
          .catch((err) => kfLogger.error('quitClean killExtra error: ', err))
          .finally(() => {
            delayMilliSeconds(1000).then(() => {
              deleteNNFiles()
                .catch((err) => kfLogger.error(err))
                .finally(() => {
                  resolve();
                });
            });
          });
      });
  });
}

//================ business related end =================
