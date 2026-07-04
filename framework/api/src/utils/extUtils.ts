import path from 'path';
import dayjs from 'dayjs';
import fse from 'fs-extra';
import { useLanguage } from '../language';
import {
  StrategyExtTypes,
  KfExtTypeEnum,
  KfCategoryTypes,
  OrderTriggerConfigTypeEnum,
  ExtRunForEnvTypesEnum,
  InstrumentTypes,
  InstrumentTypeEnum,
} from '../typings/enums';
import { InstrumentType, StrategyExtType } from '../config/tradingConfig';
import { getChildFileStat } from './fileUtils';
import { ifKfDev, resolveTypesInExtConfig } from './commonUtils';
import { EXTENSION_DIRS } from '../config/pathConfig';
import { isTdMd } from './busiUtils';
import VueI18n from '../language';

const { t } = VueI18n.global;

export const getStrategyExtTypeData = (
  strategyExtType: StrategyExtTypes,
): KungfuApi.KfTradeValueCommonData => {
  return StrategyExtType[strategyExtType || 'unknown'];
};

export const flattenExtensionModuleDirs = async (
  extensionDirs: string[],
): Promise<string[]> => {
  let extensionModuleDirs: string[] = [];
  const statsList = await Promise.all(
    extensionDirs.map((dirname: string) => {
      return getChildFileStat(dirname);
    }),
  );

  let i = 0;
  const len = statsList.length;
  for (i = 0; i < len; i++) {
    const statsDatas = statsList[i];
    for (let r = 0; r < statsDatas.length; r++) {
      const statsData = statsDatas[r];
      const { childFilePath, stat } = statsData;
      if (stat.isDirectory()) {
        if (
          process.env.NODE_ENV === 'production' ||
          childFilePath.includes('dist')
        ) {
          if (fse.pathExistsSync(path.join(childFilePath, 'package.json'))) {
            extensionModuleDirs.push(childFilePath);
          } else {
            const extModules = await flattenExtensionModuleDirs([
              childFilePath,
            ]);
            extensionModuleDirs = extensionModuleDirs.concat(extModules);
          }
        } else {
          const extModules = await flattenExtensionModuleDirs([
            path.join(childFilePath, 'dist'),
          ]);
          extensionModuleDirs = extensionModuleDirs.concat(extModules);
        }
      }
    }
  }

  return extensionModuleDirs;
};

export const getMainRepoVersionInDependencies = (
  dependencies: Record<string, string>,
) => {
  const dependenciesKeys = Object.keys(dependencies);
  if (!dependenciesKeys.length) return '';
  const mainRepoDependencies = [
    '@kungfu-tech/api',
    '@kungfu-tech/gui',
    '@kungfu-tech/tui',
    '@kungfu-tech/core',
    '@kungfu-tech/toolchain',
    '@kungfu-tech/sdk',
  ];
  const targetMainRepoDepKey = dependenciesKeys.find((item) =>
    mainRepoDependencies.includes(item),
  );
  if (!targetMainRepoDepKey) return '';
  const version = dependencies[targetMainRepoDepKey];
  return version;
};

export const dealKfExtType = (jsonConfig: {
  name: string;
  kungfuConfig: KungfuApi.KfExtOriginConfig;
}) => {
  const { name, kungfuConfig } = jsonConfig;
  const allExtTypes = Object.values(KfExtTypeEnum);
  if (kungfuConfig.type && allExtTypes.includes(kungfuConfig.type)) {
    return kungfuConfig.type as KfExtTypeEnum;
  }

  if (name) {
    if (name.startsWith?.('@kungfu-tech/kfx')) {
      const nameStrArr = name.split('/')[1].split('-');
      if (nameStrArr.length >= 3) {
        const extType = nameStrArr[1] as KfExtTypeEnum;
        if (allExtTypes.includes(extType)) return extType;
      }
    }

    if (name.startsWith?.('@kungfu-tech/examples')) {
      return KfExtTypeEnum.Example;
    }
  }

  return KfExtTypeEnum.Unknown;
};

export const buildExtAssets = (kungfuConfig) => {
  return (kungfuConfig.assets || []).reduce(
    (assetsMap, asset: KungfuApi.KfExtOriginConfigAsset) => {
      if (typeof asset === 'object' && asset.name)
        assetsMap[asset.name] = asset;

      return assetsMap;
    },
    {} as Record<string, KungfuApi.KfExtOriginConfigAsset>,
  );
};

export const getKfExtConfigList = async (): Promise<
  KungfuApi.KfExtOriginConfig[]
> => {
  const extModuleDirs = await flattenExtensionModuleDirs(EXTENSION_DIRS);
  const packageJSONPaths = extModuleDirs.map((item) =>
    path.join(item, 'package.json'),
  );
  const isKfDev = ifKfDev();
  return await Promise.all(
    packageJSONPaths.map((item) => {
      return fse.readJSON(item).then((jsonConfig) => {
        const curConfigList: KungfuApi.KfExtOriginConfig[] = [];
        const extPath = path.dirname(item);

        if (jsonConfig.kungfuConfig) {
          curConfigList.push({
            ...(jsonConfig.kungfuConfig || {}),
            type: dealKfExtType(jsonConfig),
            version: jsonConfig.version || '',
            assets: buildExtAssets(jsonConfig.kungfuConfig),
            dependencies: jsonConfig.dependencies || {},
            description: jsonConfig.description || '',
            extPath,
            readmePath: path.join(extPath, 'README.md'),
            releaseNotePath: path.join(extPath, 'RELEASENOTE.md'),
            binary: jsonConfig.binary,
          });
        }

        if (isKfDev && jsonConfig.kungfuConfigDev) {
          curConfigList.push({
            ...(jsonConfig.kungfuConfigDev || {}),
            type: dealKfExtType(jsonConfig),
            version: jsonConfig.version || '',
            assets: buildExtAssets(jsonConfig.kungfuConfigDev),
            dependencies: jsonConfig.dependencies || {},
            description: jsonConfig.description || '',
            extPath,
            readmePath: path.join(extPath, 'README.md'),
            releaseNotePath: path.join(extPath, 'RELEASENOTE.md'),
            binary: jsonConfig.binary,
          });
        }
        return curConfigList;
      });
    }),
  ).then((configList: KungfuApi.KfExtOriginConfig[][]) => {
    return configList
      .flat()
      .filter(
        (
          config: KungfuApi.KfExtOriginConfig,
        ): config is KungfuApi.KfExtOriginConfig => !!config,
      );
  });
};

export const getKfExtOriginConfigsByType = () => {
  return getKfExtConfigList().then((extList) => {
    return extList.reduce(
      (configsByType, extConfig) => {
        if (!configsByType[extConfig.type]) configsByType[extConfig.type] = {};

        configsByType[extConfig.type][extConfig.key] = extConfig;
        return configsByType;
      },
      {} as Partial<KungfuApi.KfExtOriginConfigs>,
    );
  });
};

const resolveOrderTriggerConfig = (
  originConfig: KungfuApi.KfExtOriginConfig['config'],
) => {
  if (originConfig) {
    const orderTriggerOriginConfig = originConfig.td?.order_trigger || {};
    const orderTriggerTypesKeys = Object.keys(OrderTriggerConfigTypeEnum);
    return Object.keys(orderTriggerOriginConfig).reduce(
      (config, key) => {
        if (orderTriggerTypesKeys.includes(key)) {
          config[OrderTriggerConfigTypeEnum[key]] =
            !!orderTriggerOriginConfig[key];
        }
        return config;
      },
      {} as KungfuApi.KfTdExtConfig['orderTrigger'],
    );
  }

  return {} as KungfuApi.KfTdExtConfig['orderTrigger'];
};

export const getKfExtensionConfigByCategory = (
  extConfigs: KungfuApi.KfExtOriginConfig[],
): KungfuApi.KfExtConfigs => {
  return extConfigs
    .filter((item) => !!item.config)
    .reduce(
      (configByCategory, extConfig) => {
        if (!extConfig.config) return configByCategory;

        const {
          key: extKey,
          name: extName,
          extPath,
          readmePath,
          releaseNotePath,
          assets,
          version,
          description,
          dependencies,
        } = extConfig;
        (Object.keys(extConfig['config'] || {}) as KfCategoryTypes[]).forEach(
          (category: KfCategoryTypes) => {
            const buildExtConfig = <T extends KfCategoryTypes>(
              extOriginConfig: KungfuApi.KfExtOriginConfig['config'],
              category: T,
            ) => {
              return {
                ...(configByCategory[category] || {}),
                [extKey]: {
                  name: extName,
                  extPath,
                  readmePath,
                  releaseNotePath,
                  assets,
                  version,
                  description,
                  dependencies,
                  category,
                  key: extKey,
                  silent: extOriginConfig[category]?.silent ?? false,
                  access: extOriginConfig[category]?.access || {},
                  type: resolveTypesInExtConfig(
                    extOriginConfig[category]?.type || [],
                  ),
                  settings: extOriginConfig[category]?.settings || [],
                },
              } as KungfuApi.KfExtConfigs[T];
            };

            if (category === 'td') {
              const extOriginConfig =
                (extConfig as KungfuApi.KfExtOriginBrokerConfig).config || {};
              configByCategory[category] = {
                ...(configByCategory[category] || {}),
                [extKey]: {
                  name: extName,
                  extPath,
                  readmePath,
                  releaseNotePath,
                  assets,
                  version,
                  description,
                  dependencies,
                  category,
                  key: extKey,
                  silent: extOriginConfig[category]?.silent ?? false,
                  access: extOriginConfig[category]?.access || {},
                  type: resolveTypesInExtConfig(
                    extOriginConfig[category]?.type || [],
                  ),
                  orderTrigger: resolveOrderTriggerConfig(extOriginConfig),
                  settings: extOriginConfig[category]?.settings || [],
                  fundTrans: extOriginConfig[category]?.fund_trans || {},
                  supportEtf: extOriginConfig[category]?.supportEtf || false,
                  showAssetMargin:
                    extOriginConfig[category]?.show_asset_margin || false,
                  margin: extOriginConfig[category]?.margin || {},
                },
              };
            } else if (category === 'md') {
              const extOriginConfig =
                (extConfig as KungfuApi.KfExtOriginBrokerConfig).config || {};
              configByCategory[category] = buildExtConfig(
                extOriginConfig,
                'md',
              );
            } else if (category === 'strategy') {
              const extOriginConfig =
                (extConfig as KungfuApi.KfExtOriginBrokerConfig).config || {};
              configByCategory[category] = buildExtConfig(
                extOriginConfig,
                'strategy',
              );
            } else if (category === 'operator') {
              const extOriginConfig =
                (extConfig as KungfuApi.KfExtOriginBrokerConfig).config || {};
              configByCategory[category] = buildExtConfig(
                extOriginConfig,
                'operator',
              );
            } else if (category === 'system') {
              const extOriginConfig =
                (extConfig as KungfuApi.KfExtOriginServiceConfig).config || {};
              configByCategory[category] = {
                ...(configByCategory[category] || {}),
                [extKey]:
                  Object.entries(extOriginConfig[category] || {}).reduce(
                    (resolved, [name, item]) => ({
                      ...resolved,
                      [name]: {
                        name: name || extName,
                        extPath,
                        readmePath,
                        releaseNotePath,
                        assets,
                        version,
                        description,
                        dependencies,
                        category,
                        key: extKey,
                        silent: item?.silent ?? false,
                        access: extOriginConfig[category]?.access || {},
                        type: resolveTypesInExtConfig(item?.type || []),
                        for: [item.for].flat(),
                        script: item?.script || '',
                        settings: item?.settings || [],
                      },
                    }),
                    {} as KungfuApi.KfSystemExtConfigs,
                  ) || {},
              };
            }
          },
        );
        return configByCategory;
      },
      {
        td: {},
        md: {},
        strategy: {},
        operator: {},
        system: {},
      } as KungfuApi.KfExtConfigs,
    );
};

const getKfUIExtensionConfigByExtKey = (
  extConfigs: KungfuApi.KfExtOriginConfig[],
): KungfuApi.KfUIExtConfigs => {
  return extConfigs
    .filter((item) => 'ui_config' in item && !!item.ui_config)
    .reduce((configByExtraKey, extConfig) => {
      const extUIConfig = extConfig as KungfuApi.KfExtOriginUIConfig;
      const {
        key: extKey,
        name: extName,
        extPath,
        ui_config: uiConfig,
        readmePath,
        releaseNotePath,
        assets,
        version,
        description,
        dependencies,
      } = extUIConfig;
      const silent = uiConfig?.silent ?? false;
      const access = uiConfig?.access ?? {};
      const position = uiConfig?.position || '';
      const sidebarIndex = uiConfig?.sidebarIndex || -1;
      const keepAlive = extConfig.keepAlive ?? false;
      const exhibit = uiConfig?.exhibit || ({} as KungfuApi.KfExhibitConfig);
      const components = uiConfig?.components || null;
      const script = uiConfig?.script || '';

      configByExtraKey[extKey] = {
        key: extKey,
        category: 'ui',
        name: extName,
        keepAlive,
        silent,
        access,
        assets,
        extPath,
        readmePath,
        releaseNotePath,
        version,
        description,
        dependencies,
        position,
        sidebarIndex,
        exhibit,
        components,
        script,
      };
      return configByExtraKey;
    }, {} as KungfuApi.KfUIExtConfigs);
};
const getKfCliExtensionConfigByExtKey = (
  extConfigs: KungfuApi.KfExtOriginConfig[],
): KungfuApi.KfCliExtConfigs => {
  return extConfigs
    .filter((item) => 'cli_config' in item && !!item.cli_config)
    .reduce((configByExtraKey, extConfig) => {
      const extUIConfig = extConfig as KungfuApi.KfExtOriginUIConfig;
      const {
        key: extKey,
        name: extName,
        extPath,
        cli_config: cliConfig,
        readmePath,
        releaseNotePath,
        assets,
        version,
        description,
        dependencies,
      } = extUIConfig;
      const silent = cliConfig?.silent ?? false;
      const access = cliConfig?.access ?? {};
      const exhibit = cliConfig?.exhibit || ({} as KungfuApi.KfExhibitConfig);
      const components = cliConfig?.components || null;
      const script = cliConfig?.script || '';

      configByExtraKey[extKey] = {
        key: extKey,
        category: 'cli',
        name: extName,
        silent,
        access,
        assets,
        extPath,
        readmePath,
        releaseNotePath,
        version,
        description,
        dependencies,
        exhibit,
        components,
        script,
      };
      return configByExtraKey;
    }, {} as KungfuApi.KfCliExtConfigs);
};

export const getKfExtensionConfig =
  async (): Promise<KungfuApi.KfExtConfigs> => {
    const kfExtConfigList = await getKfExtConfigList();
    return getKfExtensionConfigByCategory(kfExtConfigList);
  };

export const getKfUIExtensionConfig =
  async (): Promise<KungfuApi.KfUIExtConfigs> => {
    const kfExtConfigList = await getKfExtConfigList();
    return getKfUIExtensionConfigByExtKey(kfExtConfigList);
  };

export const getKfCliExtensionConfig =
  async (): Promise<KungfuApi.KfCliExtConfigs> => {
    const kfExtConfigList = await getKfExtConfigList();
    return getKfCliExtensionConfigByExtKey(kfExtConfigList);
  };

export const getAllExtensions =
  async (): Promise<KungfuApi.KfAllExtConfigs> => {
    const kfExtConfigList = await getKfExtConfigList();
    const extConfigs = getKfExtensionConfigByCategory(kfExtConfigList);
    const uiExtConfigs = getKfUIExtensionConfigByExtKey(kfExtConfigList);
    const cliExtConfigs = getKfCliExtensionConfigByExtKey(kfExtConfigList);
    const indexerAndMatcherConfigs = kfExtConfigList.reduce(
      (extConfigs, ext) => {
        if (
          ext.type === KfExtTypeEnum.Indexer ||
          ext.type === KfExtTypeEnum.Matcher
        ) {
          extConfigs[ext.type][ext.key] = ext;
        }
        return extConfigs;
      },
      { indexer: {}, matcher: {} } as KungfuApi.KfBacktestExtConfigs,
    );

    return {
      ...extConfigs,
      ...indexerAndMatcherConfigs,
      ui: uiExtConfigs,
      cli: cliExtConfigs,
    };
  };

export const getExhibitConfig =
  async (): Promise<KungfuApi.KfExhibitConfigs> => {
    const KfExtConfig: KungfuApi.KfUIExtConfigs =
      await getKfUIExtensionConfig();
    return Object.keys(KfExtConfig).reduce((extensionData, key) => {
      const exhibitData: KungfuApi.KfExhibitConfig = KfExtConfig[key]?.exhibit;
      extensionData[key] = {
        type: exhibitData.type || '',
        config: exhibitData.config || [],
      };
      return extensionData;
    }, {});
  };

export const getKfExtensionLanguage = async () => {
  const kfExtConfigList = await getKfExtConfigList();

  return kfExtConfigList.reduce((languageMap, config) => {
    if ('language' in config) {
      const defaultLangData: KungfuApi.KfExtOriginConfig['language'] = {
        'zh-CN': {},
        'en-US': {},
      };
      const langData =
        typeof config.language === 'object' ? config.language : defaultLangData;

      const resolveExtName = (langName: 'zh-CN' | 'en-US') => {
        const nameKeys = config.name.split('.');
        if (nameKeys.length === 2) {
          const [extKey, nameKey] = nameKeys;
          if (extKey === config.key) {
            if (typeof langData[langName][nameKey] === 'string')
              return langData[langName][nameKey];
          }
        }

        const defaultName =
          langName === 'zh-CN'
            ? config.name
            : (config.key[0].toUpperCase() + config.key.slice(1)).replace(
                /(?<!^)([A-Z])(?![A-Z])/g,
                ' $1',
              );
        return langData[langName][config.key] ?? defaultName;
      };

      Object.keys(langData).forEach((langName) => {
        languageMap[langName] = {
          ...(languageMap[langName] || {}),
          [config.key]: langData[langName],
          [config.name]: resolveExtName(langName as 'zh-CN' | 'en-US'),
        };
      });
    }
    return languageMap;
  }, {} as KungfuApi.KfExtLanguages);
};

export const getAvailExtServiceList = async (): Promise<
  KungfuApi.KfExtServiceLocation[]
> => {
  const kfExtConfigs: KungfuApi.KfExtConfigs = await getKfExtensionConfig();
  const kfSystemExtConfigsMap = (kfExtConfigs['system'] || {}) as Record<
    string,
    KungfuApi.KfSystemExtConfigs
  >;
  return Object.values(kfSystemExtConfigsMap)
    .filter((item) => Object.keys(item).length)
    .reduce((extServiceList, item) => {
      if (!Object.keys(item).length) return extServiceList;

      extServiceList = [
        ...extServiceList,
        ...Object.values(item)
          .filter((config) => config.for.includes(ExtRunForEnvTypesEnum.Ui))
          .map(
            (config) =>
              ({
                category: 'system',
                group: 'service',
                name: config.name,
                mode: 'live',
                cwd: config.extPath,
                script: config.script,
              }) as KungfuApi.KfExtServiceLocation,
          ),
      ];
      return extServiceList;
    }, [] as KungfuApi.KfExtServiceLocation[]);
};

export const getAvailCliExtServiceList = async (): Promise<
  KungfuApi.KfExtServiceLocation[]
> => {
  const kfExtConfigs: KungfuApi.KfExtConfigs = await getKfExtensionConfig();
  const kfSystemExtConfigsMap = (kfExtConfigs['system'] || {}) as Record<
    string,
    KungfuApi.KfSystemExtConfigs
  >;
  return Object.values(kfSystemExtConfigsMap)
    .filter((item) => Object.keys(item).length)
    .reduce((extServiceList, item) => {
      if (!Object.keys(item).length) return extServiceList;

      extServiceList = [
        ...extServiceList,
        ...Object.values(item)
          .filter((config) => config.for.includes(ExtRunForEnvTypesEnum.Cli))
          .map(
            (config) =>
              ({
                category: 'system',
                group: 'service',
                name: config.name,
                mode: 'live',
                cwd: config.extPath,
                script: config.script,
              }) as KungfuApi.KfExtServiceLocation,
          ),
      ];
      return extServiceList;
    }, [] as KungfuApi.KfExtServiceLocation[]);
};

export const getAvailScripts = async (): Promise<string[]> => {
  const kfExtConfig: KungfuApi.KfUIExtConfigs = await getKfUIExtensionConfig();
  return Object.values(kfExtConfig || ({} as KungfuApi.KfUIExtConfigs))
    .filter((item) => Object.keys(item).length && item.script)
    .map((item) => path.resolve(item.extPath, item.script));
};

export const buildExtTypeMap = (
  extConfigs: KungfuApi.KfExtConfigs,
  category: KfCategoryTypes,
): Record<string, InstrumentTypes | StrategyExtTypes> => {
  if (category === 'system') return {};
  const extTypeMap: Record<string, InstrumentTypes | StrategyExtTypes> = {};
  const targetCategoryConfig = extConfigs[category] || {};

  Object.keys(targetCategoryConfig).forEach((extKey: string) => {
    const configInKfExtConfig = targetCategoryConfig[extKey];
    const types = resolveTypesInExtConfig(configInKfExtConfig?.type || []);

    if (!types.length) {
      extTypeMap[extKey] = 'unknown';
      return;
    }

    const primaryType = isTdMd(category)
      ? (types as InstrumentTypes[]).sort(
          (type1: InstrumentTypes, type2: InstrumentTypes) => {
            const level1 =
              (
                InstrumentType[
                  InstrumentTypeEnum[type1] || InstrumentTypeEnum.unknown
                ] || {}
              ).level || 0;
            const level2 =
              (
                InstrumentType[
                  InstrumentTypeEnum[type2] || InstrumentTypeEnum.unknown
                ] || {}
              ).level || 0;
            return level2 - level1;
          },
        )[0]
      : (types as StrategyExtTypes[]).sort(
          (type1: StrategyExtTypes, type2: StrategyExtTypes) => {
            const level1 = (StrategyExtType[type1] || {}).level || 0;
            const level2 = (StrategyExtType[type2] || {}).level || 0;
            return level2 - level1;
          },
        )[0];

    extTypeMap[extKey] = primaryType;
  });

  return extTypeMap;
};

export const getExtConfigList = (
  extConfigs: KungfuApi.KfExtConfigs,
  category: KfCategoryTypes,
): KungfuApi.KfExtConfig[] => {
  if (category === 'system') {
    return Object.values(extConfigs[category] || {})
      .map((item) => Object.values(item))
      .flat();
  }

  return Object.values(extConfigs[category] || {});
};

export function dealTradingTaskName(
  name: string,
  extConfigs: KungfuApi.KfExtConfigs,
): string {
  const { isLanguageKeyAvailable } = useLanguage();
  const group = name.toKfGroup();
  const strategyExts = (extConfigs['strategy'] ||
    {}) as unknown as KungfuApi.KfStrategyExtConfig;
  const groupResolved = strategyExts[group] ? strategyExts[group].name : group;
  const groupTranslated = isLanguageKeyAvailable(groupResolved)
    ? t(groupResolved)
    : groupResolved;
  const timestamp = name.toKfName();
  return `${groupTranslated} ${dayjs(+timestamp).format('HH:mm:ss')}`;
}
