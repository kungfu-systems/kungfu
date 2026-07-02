// Framework-neutral i18n runtime for the capability SDK (ADR-0006: the SDK
// must not depend on any UI framework). Message catalogs and the t() calling
// convention are unchanged from the vue-i18n era: dot-path keys, named
// ({placeholder}) and list ({0}) interpolation, deep locale merge, and silent
// fallback (missing keys return the key itself).

export type LocaleMessages = { [key: string]: string | LocaleMessages };

export interface TranslatorGlobal {
  locale: string;
  fallbackLocale: string;
  messages: Record<string, LocaleMessages>;
  t: (key: string, args?: unknown[] | Record<string, unknown>) => string;
  mergeLocaleMessage: (locale: string, messages: LocaleMessages) => void;
}

export interface Translator {
  global: TranslatorGlobal;
}

const resolvePath = (
  messages: LocaleMessages | undefined,
  key: string,
): unknown => {
  if (!messages) return undefined;
  return key.split('.').reduce<unknown>((node, part) => {
    if (node && typeof node === 'object') {
      return (node as LocaleMessages)[part];
    }
    return undefined;
  }, messages);
};

const interpolate = (
  template: string,
  args?: unknown[] | Record<string, unknown>,
): string => {
  if (!args) return template;
  if (Array.isArray(args)) {
    // A single object element is a named-args call routed through the
    // list-style wrapper (useLanguage's t spreads its args into an array).
    if (
      args.length === 1 &&
      args[0] &&
      typeof args[0] === 'object' &&
      !Array.isArray(args[0])
    ) {
      return interpolate(template, args[0] as Record<string, unknown>);
    }
    return template.replace(/\{(\d+)\}/g, (match, index: string) => {
      const value = args[Number(index)];
      return value === undefined ? match : String(value);
    });
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = args[name];
    return value === undefined ? match : String(value);
  });
};

const deepMerge = (
  target: LocaleMessages,
  source: LocaleMessages,
): LocaleMessages => {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (
      value &&
      typeof value === 'object' &&
      existing &&
      typeof existing === 'object'
    ) {
      deepMerge(existing, value);
    } else {
      target[key] = value;
    }
  }
  return target;
};

export const createTranslator = (options: {
  locale: string;
  fallbackLocale: string;
  messages: Record<string, LocaleMessages>;
}): Translator => {
  const state = {
    locale: options.locale,
    fallbackLocale: options.fallbackLocale,
    messages: options.messages,
  };

  const t = (
    key: string,
    args?: unknown[] | Record<string, unknown>,
  ): string => {
    const hit =
      resolvePath(state.messages[state.locale], key) ??
      resolvePath(state.messages[state.fallbackLocale], key);
    if (typeof hit !== 'string') return key;
    return interpolate(hit, args);
  };

  const global: TranslatorGlobal = {
    get locale() {
      return state.locale;
    },
    set locale(value: string) {
      state.locale = value;
    },
    get fallbackLocale() {
      return state.fallbackLocale;
    },
    set fallbackLocale(value: string) {
      state.fallbackLocale = value;
    },
    messages: state.messages,
    t,
    mergeLocaleMessage: (locale: string, messages: LocaleMessages) => {
      state.messages[locale] = deepMerge(state.messages[locale] ?? {}, messages);
    },
  };

  return { global };
};
