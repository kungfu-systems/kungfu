import { kfLogger } from '@kungfu-tech/api/utils/logUtils';

type Callback = (...args) => Promise<void>;
type ClearRegister = { clear: () => boolean };

type RegisterReturnType = ClearRegister | false;

export enum LifeCycleKeys {
  BeforeAppMount = 'beforeAppMount',
  AppMounted = 'AppMounted',
  BeforeStopAllProcesses = 'beforeStopAllProcesses',
}

export class LifeCycleHook {
  private CallbacksMapDefaultKey = 'DEFAULT';
  callbacksMap: Record<LifeCycleKeys, Map<string, Array<Callback>>>;

  constructor() {
    this.callbacksMap = this.buildInitCallbacksMap();
  }

  private buildInitCallbacksMap() {
    return Object.values(LifeCycleKeys).reduce(
      (map, key) => {
        map[key] = new Map();
        return map;
      },
      {} as Record<LifeCycleKeys, Map<string, Array<Callback>>>,
    );
  }

  register(
    lifeCycle: LifeCycleKeys,
    key: string | Callback,
    callback?: Callback,
  ): RegisterReturnType {
    if (typeof key === 'string') {
      if (typeof callback !== 'function') {
        kfLogger.error('LifeCycle hook register callback must be a function');
        return false;
      }
    } else if (typeof key === 'function') {
      callback = key;
      key = this.CallbacksMapDefaultKey;
    }

    const targetMap = this.callbacksMap[lifeCycle];
    if (targetMap.has(key)) {
      const existedCallbacks = targetMap.get(key) as Callback[];
      existedCallbacks.push(callback as Callback);
      targetMap.set(key, existedCallbacks);
    } else {
      targetMap.set(key, [callback as Callback]);
    }

    return {
      clear: () => this.clear(lifeCycle, key as string, callback as Callback),
    };
  }

  async trigger(lifeCycle: LifeCycleKeys) {
    const targetMap = this.callbacksMap[lifeCycle];

    if (targetMap.size === 0) return;

    for (const [key, callbacks] of targetMap) {
      try {
        for (const callback of callbacks) {
          await callback();
        }
        kfLogger.warn(
          `LifeCycle '${lifeCycle}' hook: the key named '${key}' trigger succeed`,
        );
      } catch (error) {
        kfLogger.error(
          `LifeCycle '${lifeCycle}' hook: the key named '${key}' trigger error: \n${error}`,
        );
      }
    }
  }

  isRegistered(lifeCycle: LifeCycleKeys): boolean;
  isRegistered(lifeCycle: LifeCycleKeys, key: string): boolean;
  isRegistered(lifeCycle: LifeCycleKeys, callback: Callback): boolean;
  isRegistered(
    lifeCycle: LifeCycleKeys,
    key: string,
    callback: Callback,
  ): boolean;
  isRegistered(
    lifeCycle: LifeCycleKeys,
    key?: string | Callback,
    callback?: Callback,
  ) {
    if (!key) return true;

    const targetMap = this.callbacksMap[lifeCycle];

    if (typeof key === 'function') {
      callback = key;
      key = this.CallbacksMapDefaultKey;
    }

    if (!targetMap.has(key) || targetMap.get(key)?.length === 0) return false;

    if (callback) {
      const existedCallbacks = targetMap.get(key) as Callback[];
      const index = existedCallbacks.findIndex((cb) => callback === cb);
      return index !== -1;
    }

    return true;
  }

  clear(lifeCycle: LifeCycleKeys): boolean;
  clear(lifeCycle: LifeCycleKeys, key: string): boolean;
  clear(lifeCycle: LifeCycleKeys, callback: Callback): boolean;
  clear(lifeCycle: LifeCycleKeys, key: string, callback: Callback): boolean;
  clear(
    lifeCycle: LifeCycleKeys,
    key?: string | Callback,
    callback?: Callback,
  ) {
    if (!key) return true;

    const targetMap = this.callbacksMap[lifeCycle];

    if (typeof key === 'function') {
      callback = key;
      key = this.CallbacksMapDefaultKey;
    }

    if (!targetMap.has(key) || targetMap.get(key)?.length === 0) {
      kfLogger.warn(
        `LifeCycle '${lifeCycle}' hook: callbacks for the key named '${key}' is not found`,
      );
      return false;
    }

    if (callback) {
      const existedCallbacks = targetMap.get(key) as Callback[];
      const index = existedCallbacks.findIndex((cb) => callback === cb);
      const clearedCallbacks = existedCallbacks.splice(index, 1);
      targetMap.set(key, clearedCallbacks);
      return true;
    }

    targetMap.set(key, []);
    return true;
  }

  clearAll(): boolean {
    this.callbacksMap = this.buildInitCallbacksMap();
    return true;
  }
}
