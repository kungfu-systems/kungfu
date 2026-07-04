import resolveStartOptionsHook from './resolveStartProcessOptionsHook';
import { DealTradingDataHooks } from './dealTradingDataHook';
import { DealTradingTableHooks } from './dealTradingTableHook';
import resolveExtConfigHook from './resolveExtConfigHook';
import { PrefixHooks } from './prefixHooks';
import { DealBoardsMapHook } from './dealBoardsMapHook';
import { LifeCycleHook } from './lifeCycleHook';
import { ProcessActionHook } from './processActionHook';
export interface KfHooks {
  resolveStartOptions: typeof resolveStartOptionsHook;
  dealTradingData: DealTradingDataHooks;
  dealTradingTable: DealTradingTableHooks;
  resolveExtConfig: typeof resolveExtConfigHook;
  prefix: PrefixHooks;
  dealBoardsMap: DealBoardsMapHook;
  lifeCycle: LifeCycleHook;
  processAction: ProcessActionHook;
}

export class KfHookKeeper {
  hooks: KfHooks;

  constructor() {
    this.hooks = {
      dealTradingData: new DealTradingDataHooks(),
      dealTradingTable: new DealTradingTableHooks(),
      resolveStartOptions: resolveStartOptionsHook,
      resolveExtConfig: resolveExtConfigHook,
      prefix: new PrefixHooks(),
      dealBoardsMap: new DealBoardsMapHook(),
      lifeCycle: new LifeCycleHook(),
      processAction: new ProcessActionHook(),
    };
  }

  getHooks(): KfHooks {
    return this.hooks;
  }
}

globalThis.HookKeeper = globalThis.HookKeeper || new KfHookKeeper();
