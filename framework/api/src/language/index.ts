import '../config/homePathConfig';
import { createTranslator, Translator } from './translator';
import zh_CN from './zh-CN';
import en_US from './en-US';
import path from 'path';
import fse from 'fs-extra';
import { KF_CONFIG_PATH, KF_CONFIG_DEFAULT_PATH } from '../config/pathConfig';

export const getExtraLanguage = () => {
  const languagePath = path.join(
    globalThis.__publicResources,
    'language',
    'locale.json',
  );
  if (!fse.existsSync(languagePath)) {
    return null;
  } else {
    return fse.readJSONSync(languagePath, { throws: false });
  }
};

export const getMergeCNLanguage = () => {
  const languagePath = path.join(
    globalThis.__publicResources,
    'language',
    'zh-CN-merge.json',
  );
  if (!fse.existsSync(languagePath)) {
    return null;
  } else {
    return fse.readJSONSync(languagePath, { throws: false });
  }
};

export const getMergeENLanguage = () => {
  const languagePath = path.join(
    globalThis.__publicResources,
    'language',
    'en-US-merge.json',
  );
  if (!fse.existsSync(languagePath)) {
    return null;
  } else {
    return fse.readJSONSync(languagePath, { throws: false });
  }
};

const canLog =
  process.env.NODE_ENV === 'development' || process.env.APP_TYPE !== 'cli';

// 默认语言
export const langDefault = process.env.LANG_ENV ?? 'zh-CN';
const extraLanguage = getExtraLanguage();
const mergeCNLanguage = getMergeCNLanguage();
const mergeENLanguage = getMergeENLanguage();

export const getGlobalSettingLanguage = () => {
  let configPath = KF_CONFIG_DEFAULT_PATH;
  if (fse.existsSync(KF_CONFIG_PATH)) {
    configPath = KF_CONFIG_PATH;
  } else {
    configPath = KF_CONFIG_DEFAULT_PATH;
  }

  const globalSettingJson = fse.readJSONSync(configPath) as Record<
    string,
    Record<string, KungfuApi.KfConfigValue>
  >; // 不直接使用 getKfGlobalSettingsValue 是因为会形成循环引用，会报错
  return globalSettingJson?.system?.language ?? langDefault;
};

const settingLanguage = getGlobalSettingLanguage();

// 语言库
const messages = {
  'zh-CN': zh_CN,
  'en-US': en_US,
  extra: extraLanguage || {},
};

export const languageList = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English' },
  ...(extraLanguage
    ? [
        {
          value: 'extra',
          label: '自定义语言',
        },
      ]
    : []),
];

const locale = settingLanguage || (extraLanguage ? 'extra' : langDefault); //默认显示的语言

const i18n =
  (globalThis.i18n as Translator) ??
  createTranslator({
    locale,
    messages,
    fallbackLocale: langDefault,
  });

if (extraLanguage) {
  if (canLog) console.log('Found extra language');
}

if (mergeCNLanguage) {
  if (canLog) console.log('Found cn merge language');
  i18n.global.mergeLocaleMessage('zh-CN', mergeCNLanguage);
}

if (mergeENLanguage) {
  if (canLog) console.log('Found en merge language');
  i18n.global.mergeLocaleMessage('en-US', mergeENLanguage);
}

export const useLanguage = () => {
  const buildExtLangKey = (extKey: string, extraKeys?: string[] | string) => {
    if (!extraKeys) return extKey;

    return [
      extKey,
      ...(Array.isArray(extraKeys) ? extraKeys : [extraKeys]),
    ].join('.');
  };

  const isLanguageKeyAvailable = (keysStr: string) => {
    if (!keysStr) return false;

    const languageData = i18n.global.messages[i18n.global.locale];
    const result = keysStr.split('.').reduce<unknown>((res, key) => {
      if (res && typeof res === 'object') {
        return (res as Record<string, unknown>)[key];
      }
      return undefined;
    }, languageData);

    return typeof result === 'string';
  };

  const t = (key: string, ...args: unknown[]): string => {
    const result = i18n.global.t(key, [...args]);
    return `${result}`;
  };

  return {
    buildExtLangKey,
    isLanguageKeyAvailable,
    locale,
    t,
  };
};

export default i18n;
if (!globalThis.i18n) globalThis.i18n = i18n;
