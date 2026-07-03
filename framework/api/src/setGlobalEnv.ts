import {
  CLI_DIR,
  KUNGFU_DIR,
  KF_CONFIG_DIR,
  KF_HOME,
  KF_RUNTIME_DIR,
} from '@kungfu-tech/api/config/pathConfig';
import { readRootPackageJsonSync } from '@kungfu-tech/api/utils/fileUtils';
import {
  booleanProcessEnv,
  dealSpaceInPath,
} from '@kungfu-tech/api/utils/commonUtils';
import { getGlobalStorage } from '@kungfu-tech/api/utils/globalStorage';
import {
  KUNGFU_SAFE_CPUS_NUM,
  getCpusNum,
} from '@kungfu-tech/api/utils/osUtils';
import { getKfGlobalSettingsValue } from '@kungfu-tech/api/config/globalSettings';

// 此文件为所有需要预置在进程时携带的环境变量
// 注意：由于前端 app 的渲染进程是由 main 进程启动，c++ 中通过 std::getenv 的方式只能获取进程启动时就带有的 env
// 所以需要在渲染进程启动前就挂载以下的环境变量，也就是在 main 进程中挂载

const packageJson = readRootPackageJsonSync();
const globalStorage = getGlobalStorage();
const globalSetting = getKfGlobalSettingsValue();

const versions = globalStorage.getItem('historicalUsedVersions') ?? [];
const externalEnv = packageJson.kungfuCraft?.env;

// 从项目配置的预置env
if (externalEnv && typeof externalEnv === 'object') {
  Object.keys(externalEnv).forEach((key) => {
    const curEnvValue = externalEnv[key];
    if (typeof curEnvValue === 'string') process.env[key] = curEnvValue;
  });
}

if (booleanProcessEnv(globalSetting?.system?.logFrame)) {
  process.env.KF_LOG_FRAME = true;
}

if (booleanProcessEnv(globalSetting?.system?.verifyLocation)) {
  process.env.KF_VERIFY_LOCATION = true;
}

process.env.KUNGFU_DIR = dealSpaceInPath(KUNGFU_DIR);
process.env.CLI_DIR = dealSpaceInPath(CLI_DIR);
process.env.KF_HOME = dealSpaceInPath(KF_HOME);
process.env.KF_RUNTIME_DIR = dealSpaceInPath(KF_RUNTIME_DIR);
process.env.KF_CONFIG_DIR = dealSpaceInPath(KF_CONFIG_DIR);
process.env.KF_APP_RUNTIME_DIR = process.env.KF_APP_RUNTIME_DIR || __dirname;
process.env.PYTHONUTF8 = '1';
process.env.PYTHONIOENCODING = 'utf8';

process.env.CPUS_NUM = await getCpusNum();
process.env.IF_CPUS_NUM_SAFE = process.env.CPUS_NUM > KUNGFU_SAFE_CPUS_NUM;

process.env.IF_CUR_VERSION_FIRST_RUNNING =
  (packageJson.version && !versions.includes(packageJson.version)) || false;
