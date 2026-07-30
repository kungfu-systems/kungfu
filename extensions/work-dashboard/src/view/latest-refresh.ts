export interface LatestRefreshOptions<T> {
  load: () => Promise<T>;
  apply: (value: T) => void;
  fail: (error: unknown) => void;
  busy?: () => void;
  idle?: () => void;
}

export interface LatestRefresh {
  request(): void;
  dispose(): void;
}

export function createLatestRefresh<T>(
  options: LatestRefreshOptions<T>,
): LatestRefresh {
  let generation = 0;
  let inFlight = false;
  let queued = false;
  let disposed = false;

  const start = async (requestGeneration: number): Promise<void> => {
    inFlight = true;
    try {
      const value = await options.load();
      if (!disposed && requestGeneration === generation) options.apply(value);
    } catch (error) {
      if (!disposed && requestGeneration === generation) options.fail(error);
    } finally {
      inFlight = false;
      if (queued && !disposed) {
        queued = false;
        void start(generation);
      } else if (!disposed) {
        options.idle?.();
      }
    }
  };

  return {
    request() {
      if (disposed) return;
      const requestGeneration = ++generation;
      options.busy?.();
      if (inFlight) {
        queued = true;
        return;
      }
      void start(requestGeneration);
    },
    dispose() {
      disposed = true;
      generation += 1;
    },
  };
}
