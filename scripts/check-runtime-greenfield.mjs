#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Guard v4 runtime against reintroducing trading-era public runtime surfaces.
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const stagedOnly = args.includes('--staged');
const allFiles = args.includes('--all');

const SOURCE_EXT = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|mjs|js|cjs|ts|tsx|py|pyi)$/;
const PRE_V4_PY_TRADING_TYPES =
  /\b(AlgoOrder|AlgoOrderAction|AlgoOrderActionError|AlgoOrderInput|Asset|Basket|BasketInstrument|BlockMessage|Commission|Contract|CustomSubscribe|Entrust|HistoryOrder|HistoryTrade|Instrument|InstrumentFactor|InstrumentKey|Order|OrderAction|OrderActionError|OrderInput|OrderStat|OrderTrigger|OrderTriggerAction|OrderTriggerActionError|OrderTriggerInput|Position|PositionEnd|Quote|RequestHistoryOrder|RequestHistoryOrderError|RequestHistoryTrade|RequestHistoryTradeError|RiskSetting|Trade|TradingDay|Transaction|Tree)\b/g;
const PRE_V4_PY_TRADING_ENUMS =
  /\b(AccountType|AccountingMethodType|AlgoOrderActionFlag|BasketType|BasketVolumeType|BrokerState|BsFlag|CashReplaceFlag|CloseOutFlag|CommissionRateMode|ContractType|Currency|Direction|ETFStatus|ETFType|ExecType|HedgeFlag|InstrumentType|LedgerCategory|MarketType|Offset|OrderActionFlag|OrderStatus|OrderTriggerFlag|OrderTriggerType|PriceLevel|PriceType|Side|StrategyState|SubscribeDataType|SubscribeInstrumentType|TimeCondition|VolumeCondition)\b/g;
const LEGACY_NODE_PROFILE_STORES =
  /\b(RiskSettingStore|CommissionStore|BasketStore|BasketInstrumentStore)\b/g;
const LEGACY_CORE_PUBLIC_TYPES = [
  'AlgoOrder',
  'AlgoOrderAction',
  'AlgoOrderActionError',
  'AlgoOrderInput',
  'Asset',
  'AssetRequest',
  'AssetSync',
  'Basket',
  'BasketInstrument',
  'BlockMessage',
  'Commission',
  'Contract',
  'ContractRequest',
  'CustomSubscribe',
  'Depth',
  'Entrust',
  'HistoryOrder',
  'HistoryTrade',
  'Instrument',
  'InstrumentFactor',
  'InstrumentKey',
  'KeepPositionsRequest',
  'MirrorPositionsRequest',
  'Order',
  'OrderAction',
  'OrderActionError',
  'OrderInput',
  'OrderStat',
  'OrderTrigger',
  'OrderTriggerAction',
  'OrderTriggerActionError',
  'OrderTriggerInput',
  'OrderTriggerRequest',
  'Position',
  'PositionEnd',
  'PositionRequest',
  'PositionSync',
  'Quote',
  'RebuildPositionsRequest',
  'RequestHistoryOrder',
  'RequestHistoryOrderError',
  'RequestHistoryTrade',
  'RequestHistoryTradeError',
  'ResetBookRequest',
  'RiskSetting',
  'Tick',
  'Trade',
  'TradingDay',
  'Transaction',
  'Tree',
];
const CORE_PUBLIC_REGISTRIES = [
  'CorePublicDataTypes',
  'CorePublicStateDataTypes',
  'CorePublicProfileDataTypes',
];
const LEGACY_REGISTRY_RE =
  /\b(LegacyCompiledTypes|LegacyCompiledDataTypes|LegacyCompiledTypeTags)\b/g;
const AMBIGUOUS_HASH_API_RE =
  /\b(hash_32|hash_64|hash_str_32|hash_str_64|hash_string_32|hash_string_64|hash_string_128)\b/g;
const RETIRED_PRE_V4_FAST_HASH_RE = new RegExp(
  `\\b(Mur${'mur'}Hash3|mur${'mur'}3)\\b`,
  'gi',
);

const RULES = [
  {
    name: 'python runtime typed AllDataTypes binding',
    files: [
      /^framework\/core\/src\/bindings\/python\/binding\/py-runtime\.cpp$/,
    ],
    re: LEGACY_REGISTRY_RE,
    message:
      'Python runtime must expose neutral raw/envelope APIs, not generated business typed helpers.',
  },
  {
    name: 'python yijinjing public AllDataTypes binding',
    files: [
      /^framework\/core\/src\/bindings\/python\/binding\/py-yijinjing-types\.cpp$/,
    ],
    re: /\b(StateDataTypes|LegacyCompiledTypes|LegacyCompiledDataTypes|LegacyCompiledTypeTags)\b|boost::hana::for_each\((StateDataTypes|LegacyCompiledTypes|LegacyCompiledDataTypes)/g,
    message:
      'Python yijinjing public types/state must bind CorePublic*DataTypes, not the internal schema sets.',
  },
  {
    name: 'python profile public internal registry binding',
    files: [
      /^framework\/core\/src\/bindings\/python\/binding\/py-runtime\.cpp$/,
    ],
    re: /\bProfileDataTypes\b|boost::hana::for_each\(yijinjing::ProfileDataTypes/g,
    message:
      'Python runtime profile must bind CorePublicProfileDataTypes, not the internal profile schema set.',
  },
  {
    name: 'node schema public internal registry binding',
    files: [/^framework\/core\/src\/bindings\/node\/binding\/schema\.cpp$/],
    re: /\b(StateDataTypes|ProfileDataTypes|LegacyCompiledTypes|LegacyCompiledDataTypes|LegacyCompiledTypeTags)\b|boost::hana::for_each\((StateDataTypes|ProfileDataTypes|LegacyCompiledTypes|LegacyCompiledDataTypes)/g,
    message:
      'Node schema public types/carrierTypes must bind CorePublic*DataTypes, not the internal schema sets.',
  },
  {
    name: 'python yijinjing public trading stubs',
    files: [
      /^framework\/core\/stubs\/pykungfu\/yijinjing\/types\.pyi$/,
      /^framework\/core\/stubs\/pykungfu\/yijinjing\/state\.pyi$/,
      /^framework\/core\/stubs\/pykungfu\/runtime\.pyi$/,
    ],
    re: PRE_V4_PY_TRADING_TYPES,
    message:
      'Python yijinjing stubs must not expose legacy trading/profile typed classes as public v4 core types.',
  },
  {
    name: 'python yijinjing public trading enums',
    files: [
      /^framework\/core\/src\/bindings\/python\/binding\/py-yijinjing-enums\.cpp$/,
      /^framework\/core\/stubs\/pykungfu\/yijinjing\/enums\.pyi$/,
    ],
    re: PRE_V4_PY_TRADING_ENUMS,
    message:
      'Python yijinjing enums must expose only runtime/core enums, not trading/profile enums.',
  },
  {
    name: 'node legacy profile store public surface',
    files: [
      /^framework\/core\/src\/bindings\/node\/binding\/kungfu_node\.cpp$/,
      /^framework\/core\/lib\/kungfu\.js$/,
    ],
    re: LEGACY_NODE_PROFILE_STORES,
    message:
      'Node binding must not expose trading-era profile stores as v4 core API.',
  },
  {
    name: 'legacy compiled registry names',
    files: [
      /^framework\/core\/src\/bindings\//,
      /^framework\/core\/src\/libkungfu\//,
      /^framework\/core\/src\/libyijinjing\//,
    ],
    re: LEGACY_REGISTRY_RE,
    message:
      'LegacyCompiled* registries were removed; use the current core registry only.',
  },
  {
    name: 'python dispatch bench typed trading dependency',
    files: [/^framework\/core\/tests\/bench\/dispatch_load\.py$/],
    re: /\b(lf\.types\.Quote|use_quote|quote)\b/g,
    message:
      'Dispatch load bench must use raw carrier payloads, not Python trading typed bindings.',
  },
  {
    name: 'legacy trading time API',
    files: [
      /^framework\/core\/src\/libyijinjing\//,
      /^framework\/core\/src\/libkungfu\//,
      /^framework\/core\/src\/bindings\//,
      /^framework\/core\/stubs\/pykungfu\/runtime\.pyi$/,
    ],
    re: /\b(next_trading_day_end|trading_day_start|restore_start|KUNGFU_TRADING_DAY_FORMAT)\b/g,
    message:
      'Use neutral session/window time APIs: next_session_boundary, session_window_start, history_window_start.',
  },
  {
    name: 'trading closed-set schema registry',
    files: [
      /^framework\/core\/src\/libyijinjing\/include\/kungfu\/yijinjing\/schema\/registry\.h$/,
    ],
    re: /\b(TradingDataTypes|TradingDataTags|MarketDataTypes|is_market_data)\b/g,
    message:
      'Do not keep trading/market closed sets in the v4 yijinjing schema registry.',
  },
  {
    name: 'dead trading feed helper',
    files: [
      /^framework\/core\/src\/libkungfu\/include\/kungfu\/runtime\/cache\/cached\.h$/,
    ],
    re: /\bfeed_trading_data\b/g,
    message:
      'Closed-set trading feed helpers must not live in the v4 cache API.',
  },
  {
    name: 'ambiguous fast hash api',
    files: [
      /^framework\/core\/src\/libyijinjing\//,
      /^framework\/core\/src\/libkungfu\//,
      /^framework\/core\/src\/bindings\//,
    ],
    re: AMBIGUOUS_HASH_API_RE,
    message:
      'Use fast_hash_* for internal non-cryptographic ids; content integrity must use tagged content hashes.',
  },
  {
    name: 'storage content hash misuse',
    files: [
      /^framework\/core\/src\/libyijinjing\/include\/kungfu\/yijinjing\/storage\//,
      /^framework\/core\/src\/libyijinjing\/src\/storage\//,
    ],
    re: /\b(fast_hash_|FAST_HASH_ALGORITHM)\b/g,
    message:
      'Storage content hashes must be explicit content hashes such as sha256/blake3, not fast internal ids.',
  },
  {
    name: 'retired pre-v4 fast hash implementation',
    files: [/^framework\/core\/src\//, /^framework\/core\/stubs\//],
    re: RETIRED_PRE_V4_FAST_HASH_RE,
    message:
      'The retired pre-v4 fast hash implementation must not re-enter active runtime source.',
  },
];

function git(gitArgs) {
  const result = spawnSync('git', gitArgs, {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${gitArgs.join(' ')} failed: ${(result.stderr || '').trim()}`,
    );
  }
  return result.stdout.trim();
}

function gitMaybe(gitArgs) {
  const result = spawnSync('git', gitArgs, {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function splitLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isFile(rel) {
  try {
    return fs.statSync(path.join(ROOT, rel)).isFile();
  } catch {
    return false;
  }
}

function mergeBase() {
  const upstream = gitMaybe([
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]);
  const candidates = [
    upstream,
    'origin/HEAD',
    'nas/dev/v4/v4.0',
    'origin/dev/v4/v4.0',
    'dev/v4/v4.0',
  ].filter(Boolean);
  for (const ref of candidates) {
    const base = gitMaybe(['merge-base', String(ref), 'HEAD']);
    if (base) return base;
  }
  return null;
}

function selectedFiles() {
  const files = new Set();
  if (stagedOnly) {
    for (const file of splitLines(
      git(['diff', '--cached', '--name-only', '--diff-filter=ACM']),
    )) {
      files.add(file);
    }
  } else if (allFiles) {
    for (const file of splitLines(git(['ls-files']))) {
      files.add(file);
    }
  } else {
    const base = mergeBase();
    if (base) {
      for (const file of splitLines(
        git(['diff', '--name-only', '--diff-filter=ACM', `${base}...HEAD`]),
      )) {
        files.add(file);
      }
    }
    for (const mode of [[], ['--cached']]) {
      for (const file of splitLines(
        git(['diff', ...mode, '--name-only', '--diff-filter=ACM']),
      )) {
        files.add(file);
      }
    }
    for (const file of splitLines(
      git(['ls-files', '--others', '--exclude-standard']),
    )) {
      files.add(file);
    }
  }
  return [...files].filter((file) => SOURCE_EXT.test(file) && isFile(file));
}

function lineNumber(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function corePublicRegistryHits(rel, text) {
  if (
    rel !==
    'framework/core/src/libyijinjing/include/kungfu/yijinjing/schema/registry.h'
  ) {
    return [];
  }
  const hits = [];
  for (const registry of CORE_PUBLIC_REGISTRIES) {
    const blockRe = new RegExp(
      `constexpr auto ${registry} = boost::hana::make_map\\([\\s\\S]*?\\n\\);`,
      'm',
    );
    const block = blockRe.exec(text);
    if (!block) {
      hits.push({
        file: rel,
        line: 1,
        rule: `${registry} exists`,
        message: `${registry} must stay explicit so public binding checks can audit it.`,
        text: registry,
      });
      continue;
    }
    for (const typeName of LEGACY_CORE_PUBLIC_TYPES) {
      const typeRe = new RegExp(`\\bTYPE_PAIR\\(${typeName}\\)\\b`);
      const typeMatch = typeRe.exec(block[0]);
      if (!typeMatch) continue;
      hits.push({
        file: rel,
        line: lineNumber(text, block.index + typeMatch.index),
        rule: `${registry} legacy type`,
        message:
          'CorePublic*DataTypes must stay runtime/core-only; legacy trading/profile schemas belong to internal compatibility registries.',
        text: typeName,
      });
    }
  }
  return hits;
}

function directLegacyRegistryNameHits(rel, text) {
  if (
    rel ===
      'framework/core/src/libyijinjing/include/kungfu/yijinjing/schema/registry.h' ||
    rel ===
      'framework/core/src/libyijinjing/include/kungfu/yijinjing/schema/types.h' ||
    rel === 'framework/core/src/libyijinjing/check-deps.mjs' ||
    rel === 'scripts/check-runtime-greenfield.mjs'
  ) {
    return [];
  }
  if (!/^framework\/core\/src\/(bindings|libkungfu|libyijinjing)\//.test(rel)) {
    return [];
  }
  const hits = [];
  LEGACY_REGISTRY_RE.lastIndex = 0;
  for (const match of text.matchAll(LEGACY_REGISTRY_RE)) {
    hits.push({
      file: rel,
      line: lineNumber(text, match.index || 0),
      rule: 'legacy compiled registry',
      message:
        'LegacyCompiled* registries must not return; use the current core registry only.',
      text: match[0],
    });
  }
  return hits;
}

function isAllowedRuleSelfReference(rel, rule) {
  if (
    rule.name === 'ambiguous fast hash api' &&
    rel === 'framework/core/src/bindings/python/binding/py-runtime.cpp'
  ) {
    return true;
  }
  return (
    rule.name === 'legacy compiled registry names' &&
    rel === 'framework/core/src/libyijinjing/check-deps.mjs'
  );
}

const hits = [];
for (const rel of selectedFiles()) {
  const rules = RULES.filter((rule) => rule.files.some((re) => re.test(rel)));
  if (!rules.length) continue;
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const rule of rules) {
    if (isAllowedRuleSelfReference(rel, rule)) continue;
    rule.re.lastIndex = 0;
    for (const match of text.matchAll(rule.re)) {
      hits.push({
        file: rel,
        line: lineNumber(text, match.index || 0),
        rule: rule.name,
        message: rule.message,
        text: match[0],
      });
    }
  }
  hits.push(...corePublicRegistryHits(rel, text));
  hits.push(...directLegacyRegistryNameHits(rel, text));
}

if (hits.length) {
  console.error('[runtime-greenfield] trading-era runtime surface is blocked.');
  for (const hit of hits) {
    console.error(`  ${hit.file}:${hit.line} (${hit.rule}) ${hit.text}`);
    console.error(`    ${hit.message}`);
  }
  process.exit(1);
}

console.log('[runtime-greenfield] gate passed');
